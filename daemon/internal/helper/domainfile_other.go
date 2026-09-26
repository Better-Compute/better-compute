//go:build !unix

package helper

import "errors"

// NodeFileCheck needs Unix file ownership; the helper runs on Linux only.
func NodeFileCheck([]string, int) func(string) error {
	return func(string) error { return errors.New("helper: needs Linux") }
}
