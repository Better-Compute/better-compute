//go:build unix

package main

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
	"syscall"
)

// userCanOpen reports whether the account name can read and write the device path: bcd join runs as
// root, and a node key it makes in the TPM is useless to a bcd node (the [helper] user) that cannot
// open the TPM.
func userCanOpen(name, path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s: no owner", path)
	}
	account, err := user.Lookup(name)
	if err != nil {
		return err
	}
	mode := fi.Mode().Perm()
	if mode&0o006 == 0o006 || (account.Uid == strconv.Itoa(int(st.Uid)) && mode&0o600 == 0o600) {
		return nil
	}
	if mode&0o060 == 0o060 {
		groups, _ := account.GroupIds()
		for _, g := range append(groups, account.Gid) {
			if g == strconv.Itoa(int(st.Gid)) {
				return nil
			}
		}
	}
	return fmt.Errorf("%s cannot open %s (mode %04o, group %d): add it to the device's group (the install script does)", name, path, mode, st.Gid)
}
