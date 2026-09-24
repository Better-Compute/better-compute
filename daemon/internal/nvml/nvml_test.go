package nvml

import (
	"errors"
	"testing"
)

// TODO(v0.1): once nvml.go talks to go-nvml, keep this assertion for -tags nonvml only and test the
// default build against the go-nvml mock.
func TestProbeReportsNotBuilt(t *testing.T) {
	if _, err := Probe(); !errors.Is(err, ErrNotBuilt) {
		t.Fatalf("Probe() = %v; want ErrNotBuilt", err)
	}
}
