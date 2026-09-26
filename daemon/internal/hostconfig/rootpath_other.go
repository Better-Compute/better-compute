//go:build !unix

package hostconfig

// checkRootPath has nothing to check where bcd does not configure hosts (it targets Linux).
func checkRootPath(string) error { return nil }
