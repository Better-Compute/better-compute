package main

import (
	"fmt"
	"os"
	goruntime "runtime"
)

// maxTokenFile bounds a join token file (a token is about a hundred bytes).
const maxTokenFile = 4096

// readTokenFile reads a join token file that only its owner can read (0600 or 0400; a Kubernetes
// Secret volume with defaultMode 0400): a token others could read may already be someone else's.
func readTokenFile(name string) ([]byte, error) {
	fi, err := os.Stat(name) // a Secret volume's file is a symlink into ..data: its target counts
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", name)
	}
	if goruntime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is readable by others (mode %04o): make it 0600 (a Kubernetes Secret: defaultMode 0400)", name, fi.Mode().Perm())
	}
	if fi.Size() > maxTokenFile {
		return nil, fmt.Errorf("%s is %d bytes; a join token is under %d", name, fi.Size(), maxTokenFile)
	}
	return os.ReadFile(name)
}
