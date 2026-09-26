//go:build !nonvml

package nvml

import (
	"context"
	"time"
)

// Probe reports the driver version and the GPU count through nvidia-smi (SMI); ErrNoDriver on a
// host without it.
//
// TODO: a go-nvml (cgo) backend once the dependency is approved; SMI covers every inventory field.
func Probe() (Info, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return SMI{}.Probe(ctx)
}
