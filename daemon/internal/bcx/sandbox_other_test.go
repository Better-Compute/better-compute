//go:build !linux

package bcx

func probeDenied() string { return "unsupported" }
