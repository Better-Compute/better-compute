package telemetry

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExportEncodesOTLPJSON(t *testing.T) {
	var got map[string]any
	var headers http.Header
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, headers = r.URL.Path, r.Header
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &got); err != nil {
			t.Error(err)
		}
	}))
	defer srv.Close()
	five := int64(5)
	start := time.Unix(100, 0)
	e := &Exporter{Endpoint: srv.URL, Headers: map[string]string{"Authorization": "Bearer x"}, Resource: map[string]string{"service.name": "bcd", "bcd.node.id": "n1"},
		Scope: "bcd", ScopeVersion: "1.0.0", Start: start}
	err := e.Export(context.Background(), time.Unix(200, 5), []Metric{
		{Name: "bcd.gpu.utilization", Unit: "1", Points: []Point{{Attrs: map[string]string{"gpu.uuid": "GPU-1"}, Double: 0.87}}},
		{Name: "bcd.gpu.ecc.errors", Unit: "{error}", Sum: true, Points: []Point{{Attrs: map[string]string{"gpu.uuid": "GPU-1", "type": "correctable"}, Int: &five}}},
		{Name: "bcd.empty", Unit: "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1/metrics" || headers.Get("Content-Type") != "application/json" || headers.Get("Authorization") != "Bearer x" {
		t.Fatalf("path %s headers %v", path, headers)
	}
	rm := got["resourceMetrics"].([]any)[0].(map[string]any)
	res := rm["resource"].(map[string]any)["attributes"].([]any)
	if len(res) != 2 || res[0].(map[string]any)["key"] != "bcd.node.id" {
		t.Fatalf("resource = %v", res)
	}
	sm := rm["scopeMetrics"].([]any)[0].(map[string]any)
	metrics := sm["metrics"].([]any)
	if len(metrics) != 2 || sm["scope"].(map[string]any)["version"] != "1.0.0" {
		t.Fatalf("metrics = %v", metrics)
	}
	gauge := metrics[0].(map[string]any)["gauge"].(map[string]any)["dataPoints"].([]any)[0].(map[string]any)
	if gauge["asDouble"] != 0.87 || gauge["timeUnixNano"] != "200000000005" {
		t.Fatalf("gauge point = %v", gauge)
	}
	sum := metrics[1].(map[string]any)["sum"].(map[string]any)
	point := sum["dataPoints"].([]any)[0].(map[string]any)
	if sum["aggregationTemporality"] != 2.0 || sum["isMonotonic"] != true || point["asInt"] != "5" || point["startTimeUnixNano"] != "100000000000" {
		t.Fatalf("sum = %v", sum)
	}
}

func TestExportErrors(t *testing.T) {
	status := http.StatusBadRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	}))
	defer srv.Close()
	e := &Exporter{Endpoint: srv.URL + "/v1/metrics"}
	m := []Metric{{Name: "x", Points: []Point{{Double: 1}}}}
	if err := e.Export(context.Background(), time.Now(), m); !IsPermanent(err) {
		t.Fatalf("400 = %v", err)
	}
	status = http.StatusTooManyRequests
	if err := e.Export(context.Background(), time.Now(), m); err == nil || IsPermanent(err) {
		t.Fatalf("429 = %v", err)
	}
	if _, err := MetricsURL("ftp://x"); err == nil {
		t.Fatal("ftp endpoint accepted")
	}
	if u, _ := MetricsURL("https://otel.example.com:4318/"); u != "https://otel.example.com:4318/v1/metrics" {
		t.Fatalf("url = %s", u)
	}
}

func TestParseHeaders(t *testing.T) {
	for in, want := range map[string]map[string]string{
		`{"Authorization":"Bearer a"}`:               {"Authorization": "Bearer a"},
		"Authorization: Bearer a\nX-Scope-OrgID: t1": {"Authorization": "Bearer a", "X-Scope-OrgID": "t1"},
		"api-key=abc,x-tenant=t":                     {"api-key": "abc", "x-tenant": "t"},
	} {
		got, err := ParseHeaders([]byte(in))
		if err != nil || len(got) != len(want) {
			t.Fatalf("%q = %v, %v", in, got, err)
		}
		for k, v := range want {
			if got[k] != v {
				t.Fatalf("%q: %s = %q", in, k, got[k])
			}
		}
	}
	for _, bad := range []string{"novalue", `{"a b":"c"}`, "{\"a\":\"b\\r\\nc\"}"} {
		if _, err := ParseHeaders([]byte(bad)); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}
