//go:build !linux

package runtime

import "errors"

func aclReaders(string) ([]int, error)  { return nil, errors.ErrUnsupported }
func setACLReaders(string, []int) error { return errors.ErrUnsupported }

func aclGrant(string, int, uint16, bool) error { return errors.ErrUnsupported }

const (
	aclRead = 0x04
	aclRW   = 0x06
	aclRWX  = 0x07
)
