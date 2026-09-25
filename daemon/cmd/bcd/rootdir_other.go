//go:build !unix

package main

import "errors"

// rootOnlyDir: bcd helper runs on Linux only.
func rootOnlyDir(string) error { return errors.New("bcd helper runs on Linux") }
