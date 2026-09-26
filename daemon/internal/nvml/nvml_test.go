//go:build nonvml

package nvml

import (
	"errors"
	"testing"
)

// The nonvml build never talks to the driver; the default build's Probe is SMI.Probe (smi_test.go).
func TestProbeReportsNotBuilt(t *testing.T) {
	if _, err := Probe(); !errors.Is(err, ErrNotBuilt) {
		t.Fatalf("Probe() = %v; want ErrNotBuilt", err)
	}
}
