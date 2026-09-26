// Package telemetry exports bcd's own metrics over OTLP/HTTP (PLAN.md P8: telemetry never rides the
// Session or reaches Postgres). It speaks the OTLP JSON encoding (application/json, the protobuf
// JSON mapping of ExportMetricsServiceRequest), so bcd needs no OpenTelemetry modules: gauges for
// live readings (GPU memory, utilization, temperature, power, clocks) and cumulative sums for
// counters (ECC errors).
package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Point is one data point: its attributes and value (Int for integer points, else Double).
type Point struct {
	Attrs  map[string]string
	Double float64
	Int    *int64
}

// Metric is one metric of an export.
type Metric struct {
	Name, Unit, Description string
	// Sum marks a cumulative monotonic counter (a gauge otherwise).
	Sum    bool
	Points []Point
}

// Exporter posts metrics to an OTLP/HTTP collector.
type Exporter struct {
	// Endpoint is the collector's base URL (http[s]://host:4318); /v1/metrics is appended unless it
	// is already the path.
	Endpoint string
	Headers  map[string]string
	// Resource are the resource attributes (service.name and the node's identity).
	Resource map[string]string
	// Scope names the instrumentation scope (bcd and its version).
	Scope, ScopeVersion string
	// Start is the start of the cumulative sums (the process start).
	Start  time.Time
	Client *http.Client
}

// MetricsURL resolves the endpoint's metrics URL; http and https only.
func MetricsURL(endpoint string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", fmt.Errorf("otlp endpoint %q is not an http(s) URL", endpoint)
	}
	if !strings.HasSuffix(u.Path, "/v1/metrics") {
		u.Path = strings.TrimSuffix(u.Path, "/") + "/v1/metrics"
	}
	return u.String(), nil
}

type kv struct {
	Key   string         `json:"key"`
	Value map[string]any `json:"value"`
}

func attrs(m map[string]string) []kv {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]kv, 0, len(keys))
	for _, k := range keys {
		out = append(out, kv{Key: k, Value: map[string]any{"stringValue": m[k]}})
	}
	return out
}

func nanos(t time.Time) string { return strconv.FormatInt(t.UnixNano(), 10) }

// Encode renders an ExportMetricsServiceRequest in the OTLP JSON encoding.
func (e *Exporter) Encode(now time.Time, metrics []Metric) ([]byte, error) {
	var ms []map[string]any
	for _, m := range metrics {
		if len(m.Points) == 0 {
			continue
		}
		var points []map[string]any
		for _, p := range m.Points {
			dp := map[string]any{"timeUnixNano": nanos(now)}
			if len(p.Attrs) > 0 {
				dp["attributes"] = attrs(p.Attrs)
			}
			if p.Int != nil {
				dp["asInt"] = strconv.FormatInt(*p.Int, 10)
			} else {
				dp["asDouble"] = p.Double
			}
			if m.Sum {
				dp["startTimeUnixNano"] = nanos(e.Start)
			}
			points = append(points, dp)
		}
		metric := map[string]any{"name": m.Name, "unit": m.Unit}
		if m.Description != "" {
			metric["description"] = m.Description
		}
		if m.Sum {
			// AGGREGATION_TEMPORALITY_CUMULATIVE = 2.
			metric["sum"] = map[string]any{"aggregationTemporality": 2, "isMonotonic": true, "dataPoints": points}
		} else {
			metric["gauge"] = map[string]any{"dataPoints": points}
		}
		ms = append(ms, metric)
	}
	req := map[string]any{"resourceMetrics": []any{map[string]any{
		"resource": map[string]any{"attributes": attrs(e.Resource)},
		"scopeMetrics": []any{map[string]any{
			"scope":   map[string]any{"name": e.Scope, "version": e.ScopeVersion},
			"metrics": ms,
		}},
	}}}
	return json.Marshal(req)
}

// Export posts one batch. A 4xx other than 429 is permanent (the batch is dropped by the caller);
// everything else is worth retrying on the next interval.
func (e *Exporter) Export(ctx context.Context, now time.Time, metrics []Metric) error {
	target, err := MetricsURL(e.Endpoint)
	if err != nil {
		return err
	}
	body, err := e.Encode(now, metrics)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range e.Headers {
		req.Header.Set(k, v)
	}
	client := e.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode/100 == 2 {
		return nil
	}
	err = fmt.Errorf("otlp %s: %s: %s", target, resp.Status, strings.TrimSpace(string(msg)))
	if resp.StatusCode/100 == 4 && resp.StatusCode != http.StatusTooManyRequests {
		return &PermanentError{err}
	}
	return err
}

// PermanentError is an export the collector refused for good (retrying the batch cannot help).
type PermanentError struct{ Err error }

func (p *PermanentError) Error() string { return p.Err.Error() }
func (p *PermanentError) Unwrap() error { return p.Err }

// IsPermanent reports a PermanentError.
func IsPermanent(err error) bool {
	var p *PermanentError
	return errors.As(err, &p)
}

// ParseHeaders reads exporter headers from a secret: a JSON object of name → value, or
// "Name: value" / "name=value" lines (OTEL_EXPORTER_OTLP_HEADERS style, comma-separated too).
func ParseHeaders(secret []byte) (map[string]string, error) {
	out := map[string]string{}
	trimmed := bytes.TrimSpace(secret)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		if err := json.Unmarshal(trimmed, &out); err != nil {
			return nil, fmt.Errorf("otlp headers: %w", err)
		}
	} else {
		for _, part := range strings.FieldsFunc(string(trimmed), func(r rune) bool { return r == '\n' || r == ',' }) {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			i := strings.IndexAny(part, ":=")
			if i <= 0 {
				return nil, fmt.Errorf("otlp headers: %q is not name: value", part)
			}
			out[strings.TrimSpace(part[:i])] = strings.TrimSpace(part[i+1:])
		}
	}
	for k, v := range out {
		if k == "" || strings.ContainsAny(k, " \t\r\n:") || strings.ContainsAny(v, "\r\n") {
			return nil, fmt.Errorf("otlp headers: %q is not a header", k)
		}
	}
	return out, nil
}
