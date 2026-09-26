//go:build !linux

package runtime

import "errors"

func aclReaders(string) ([]int, error)  { return nil, errors.ErrUnsupported }
func setACLReaders(string, []int) error { return errors.ErrUnsupported }
