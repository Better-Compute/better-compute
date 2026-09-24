package converge

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

// fake is a converger whose plan applies the given step results in order.
type fake struct {
	section Section
	planErr error
	steps   []error
	applied *[]string
}

func (f fake) Section() Section { return f.section }

func (f fake) Plan(_ context.Context, desired []byte) ([]Action, error) {
	if f.planErr != nil {
		return nil, f.planErr
	}
	var actions []Action
	for i, stepErr := range f.steps {
		name := string(f.section) + "/" + string(rune('a'+i))
		actions = append(actions, Action{Description: name, Apply: func(context.Context) error {
			if f.applied != nil {
				*f.applied = append(*f.applied, name+"="+string(desired))
			}
			return stepErr
		}})
	}
	return actions, nil
}

func statuses(r Report) map[Section]Status {
	out := make(map[Section]Status, len(r.Sections))
	for _, s := range r.Sections {
		out[s.Section] = s.Status
	}
	return out
}

func TestOrder(t *testing.T) {
	want := []Section{"host", "devices", "instances", "access", "telemetry", "daemon"}
	if got := Order(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Order() = %v, want %v", got, want)
	}
}

func TestRunConvergesInOrderAndAdvances(t *testing.T) {
	var applied []string
	spec := Spec{Generation: 7, Sections: map[Section][]byte{SectionDevices: []byte("gpu0"), SectionHost: []byte("sysctl")}}
	report, err := Run(context.Background(), spec, []Converger{
		fake{section: SectionDevices, steps: []error{nil, nil}, applied: &applied},
		fake{section: SectionHost, steps: []error{nil}, applied: &applied},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Observed || report.Generation != 7 {
		t.Fatalf("report = %+v; want generation 7 observed", report)
	}
	want := []string{"host/a=sysctl", "devices/a=gpu0", "devices/b=gpu0"}
	if !reflect.DeepEqual(applied, want) {
		t.Fatalf("applied %v, want %v", applied, want)
	}
	if len(report.Sections) != len(Order()) {
		t.Fatalf("%d sections reported, want %d", len(report.Sections), len(Order()))
	}
	for _, s := range report.Sections {
		if s.Status != StatusConverged {
			t.Fatalf("section %s = %s, want converged", s.Section, s.Status)
		}
	}
}

func TestRetryableFailureHoldsObservedGeneration(t *testing.T) {
	transient := errors.New("containerd not ready")
	var applied []string
	report, err := Run(context.Background(), Spec{Generation: 3}, []Converger{
		fake{section: SectionHost, steps: []error{transient, nil}, applied: &applied},
		fake{section: SectionDevices, steps: []error{nil}, applied: &applied},
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Observed {
		t.Fatal("observedGeneration advanced past a retryable failure")
	}
	host := report.Sections[0]
	if host.Section != SectionHost || host.Status != StatusProgressing || !errors.Is(host.Err, transient) || host.Applied != 0 {
		t.Fatalf("host = %+v", host)
	}
	// The failing section stops at its first failed action; later sections still run.
	if want := []string{"host/a=", "devices/a="}; !reflect.DeepEqual(applied, want) {
		t.Fatalf("applied %v, want %v", applied, want)
	}
}

func TestTerminalFailureAndUnsupportedSectionsAdvance(t *testing.T) {
	spec := Spec{Generation: 9, Sections: map[Section][]byte{
		SectionInstances: []byte("vm-1"),
		"gpu-fabric":     []byte("imex"),
		"alpha":          nil,
	}}
	report, err := Run(context.Background(), spec, []Converger{
		fake{section: SectionDevices, planErr: Terminal(errors.New("GPU missing"))},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Observed {
		t.Fatal("terminal and unsupported sections must not hold observedGeneration back")
	}
	got := statuses(report)
	want := map[Section]Status{
		SectionHost:      StatusConverged,
		SectionDevices:   StatusFailed,
		SectionInstances: StatusUnsupported,
		SectionAccess:    StatusConverged,
		SectionTelemetry: StatusConverged,
		SectionDaemon:    StatusConverged,
		"alpha":          StatusConverged,
		"gpu-fabric":     StatusUnsupported,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("statuses = %v, want %v", got, want)
	}
	// Unknown sections come after the known ones, by name.
	n := len(report.Sections)
	if report.Sections[n-2].Section != "alpha" || report.Sections[n-1].Section != "gpu-fabric" {
		t.Fatalf("unknown sections out of order: %+v", report.Sections[n-2:])
	}
	if !errors.Is(report.Sections[1].Err, ErrTerminal) {
		t.Fatalf("devices error = %v; want ErrTerminal", report.Sections[1].Err)
	}
}

func TestRunRejectsDuplicateConverger(t *testing.T) {
	_, err := Run(context.Background(), Spec{}, []Converger{fake{section: SectionHost}, fake{section: SectionHost}})
	if err == nil {
		t.Fatal("two convergers for one section were accepted")
	}
}

func TestRunStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Run(ctx, Spec{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run = %v; want context.Canceled", err)
	}
}
