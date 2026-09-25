package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"github.com/better-compute/better-compute/daemon/internal/bcx"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// driver.invoke (PLAN.md §5.5, §11.2; FakeDaemon's fakeDriverInvoke): one driver operation
// `<concern>.<operation>` of a driver a bcx plugin hosted by this agent serves. The driver config
// carries secret references only; each top-level field holding one is fetched with SecretRequest
// (bound to the workflow step) and handed to the plugin as a SecretValue, never in the config.

var (
	concernName   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,63}$`)
	operationName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,63}$`)
	driverIDName  = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,127}$`)
	secretRef     = regexp.MustCompile(`^(secret|vault|env)://`)
)

// DriverHost is what driver.invoke needs from a plugin (bcx.Plugin in production).
type DriverHost interface {
	Invoke(ctx context.Context, req *driverv1.InvokeRequest, onProgress func(*driverv1.Progress)) (string, error)
}

// HostedDriver is one driver a plugin serves.
type HostedDriver struct {
	Manifest *commonv1.DriverManifest
	Host     DriverHost
}

// DriversOf lists the drivers of started plugins.
func DriversOf(plugins []*bcx.Plugin) []HostedDriver {
	var out []HostedDriver
	for _, p := range plugins {
		for _, m := range p.Drivers {
			out = append(out, HostedDriver{Manifest: m, Host: p})
		}
	}
	return out
}

type invocation struct {
	Concern   string          `json:"concern"`
	Operation string          `json:"operation"`
	Args      json.RawMessage `json:"args"`
	Driver    string          `json:"driver"`
	Config    json.RawMessage `json:"config"`
}

func (a *Agent) runDriverInvoke(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.DriverInvokeRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	raw, err := req.GetArgs().MarshalJSON()
	if err != nil {
		return journal.Result{}, invalidPayload(errors.New("driver.invoke args must be an object"))
	}
	var inv invocation
	if err := json.Unmarshal(raw, &inv); err != nil {
		return journal.Result{}, invalidPayload(errors.New("driver.invoke args must be an object"))
	}
	switch {
	case !concernName.MatchString(inv.Concern):
		return journal.Result{}, invalidPayload(errors.New("driver.invoke needs a concern"))
	case !operationName.MatchString(inv.Operation):
		return journal.Result{}, invalidPayload(errors.New("driver.invoke needs an operation"))
	case inv.Driver != "" && !driverIDName.MatchString(inv.Driver):
		return journal.Result{}, invalidPayload(errors.New("driver.invoke driver is not a driver id"))
	}
	var candidates []HostedDriver
	for _, d := range a.o.Drivers {
		if inv.Driver != "" && d.Manifest.GetId() != inv.Driver {
			continue
		}
		for _, k := range d.Manifest.GetKinds() {
			if k == inv.Concern {
				candidates = append(candidates, d)
				break
			}
		}
	}
	switch len(candidates) {
	case 0:
		msg := "no hosted driver implements " + inv.Concern
		if inv.Driver != "" {
			msg = fmt.Sprintf("driver %s is not hosted here or does not implement %s", inv.Driver, inv.Concern)
		}
		return journal.Result{}, &KindError{Code: "driver-not-found", Message: msg}
	case 1:
	default:
		return journal.Result{}, &KindError{Code: "ambiguous-driver", Message: "several hosted drivers implement " + inv.Concern + "; the step must name one"}
	}
	d := candidates[0]
	config := map[string]json.RawMessage{}
	if len(inv.Config) > 0 && string(inv.Config) != "null" {
		if err := json.Unmarshal(inv.Config, &config); err != nil {
			return journal.Result{}, invalidPayload(errors.New("driver.invoke config must be an object"))
		}
	}
	var secrets []*driverv1.SecretValue
	fields := make([]string, 0, len(config))
	for f := range config {
		fields = append(fields, f)
	}
	sort.Strings(fields)
	for _, f := range fields {
		var ref string
		if json.Unmarshal(config[f], &ref) != nil || !secretRef.MatchString(ref) {
			continue
		}
		v, err := a.RequestSecret(ctx, ref, pki.SecretBinding{WorkflowID: req.GetWorkflowId(), StepID: req.GetStepId()})
		if err != nil {
			return journal.Result{}, &KindError{Code: "secret-unavailable", Message: err.Error()}
		}
		secrets = append(secrets, &driverv1.SecretValue{Field: f, Value: v})
	}
	configJSON, _ := json.Marshal(config)
	args := string(inv.Args)
	if args == "" {
		args = "null"
	}
	ireq := &driverv1.InvokeRequest{
		DriverId:       d.Manifest.GetId(),
		Kind:           inv.Concern,
		Operation:      inv.Operation,
		ConfigJson:     string(configJSON),
		ArgsJson:       args,
		Secrets:        secrets,
		IdempotencyKey: fmt.Sprintf("wf:%s:%s#%d", req.GetWorkflowId(), req.GetStepId(), req.GetAttempt()),
		Traceparent:    cmd.Traceparent,
	}
	if !cmd.NotAfter.IsZero() {
		ireq.Deadline = timestamppb.New(cmd.NotAfter)
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, cmd.NotAfter.Add(-a.offsetNow()))
		defer cancel()
	}
	result, err := d.Host.Invoke(ctx, ireq, nil)
	if err != nil {
		var de *bcx.Error
		if errors.As(err, &de) {
			return journal.Result{}, &KindError{Code: de.Code, Message: de.Message}
		}
		return journal.Result{}, &KindError{Code: "driver-error", Message: err.Error()}
	}
	a.log.Info("driver operation", "driver", d.Manifest.GetId(), "operation", inv.Concern+"."+inv.Operation)
	return succeeded(&agentv1.DriverInvokeResult{ResultJson: strings.TrimSpace(result)})
}

// offsetNow is the Welcome clock offset (server time minus local time).
func (a *Agent) offsetNow() time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.offset
}
