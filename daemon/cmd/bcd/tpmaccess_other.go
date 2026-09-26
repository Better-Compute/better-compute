//go:build !unix

package main

import "errors"

// userCanOpen: TPM devices need Linux.
func userCanOpen(string, string) error { return errors.New("TPM devices need Linux") }
