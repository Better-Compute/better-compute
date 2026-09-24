//go:build nonvml

package nvml

import "fmt"

// Probe always fails: this binary was built with -tags nonvml.
func Probe() (Info, error) {
	return Info{}, fmt.Errorf("%w: built with -tags nonvml", ErrNotBuilt)
}
