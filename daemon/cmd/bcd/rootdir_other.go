//go:build !unix

package main

import "errors"

// rootOnlyDir: bcd helper runs on Linux only.
func rootOnlyDir(string) error { return errors.New("bcd helper runs on Linux") }

// rootOnlyPath: bcd helper runs on Linux only.
func rootOnlyPath(string) error { return errors.New("bcd helper runs on Linux") }
