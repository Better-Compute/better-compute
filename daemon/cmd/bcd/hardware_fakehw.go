//go:build fakehw

package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/tpm/tpmsim"
)

// hardwareBackend names the inventory source this binary was built with.
const hardwareBackend = "fakehw"

// devBuild accepts dev-only configuration (dev_insecure_h2c).
const devBuild = true

// fakeSeed is BCD_FAKEHW_SEED (default 0): each seed is a distinct fake machine.
func fakeSeed() uint64 {
	seed, _ := strconv.ParseUint(os.Getenv("BCD_FAKEHW_SEED"), 10, 64)
	return seed
}

// collectInventory returns the fake HGX H100 node for BCD_FAKEHW_SEED.
func collectInventory() (*inventory.NodeInventory, error) {
	return fakehw.Inventory(fakeSeed()), nil
}

// nodeKeyTPM keeps a fake machine's node keys in its software TPM when BCD_FAKEHW_TPM_KEYS=1 (the
// TPM node-key path end to end); else they are files.
func nodeKeyTPM(dataDir string) func() (tpm.Transport, error) {
	if os.Getenv("BCD_FAKEHW_TPM_KEYS") != "1" {
		return nil
	}
	return func() (tpm.Transport, error) {
		t, _, err := openTPM(dataDir)
		return t, err
	}
}

// nodeKeyDevice: a fake machine's TPM is a file, open to whoever runs bcd.
func nodeKeyDevice() string { return "" }

// openTPM is the fake machine's TPM: a software TPM (tpmsim) kept in <data_dir>/fakehw-tpm.json, the
// same EK on every join of this machine.
func openTPM(dataDir string) (tpm.Transport, func(), error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, nil, err
	}
	sim, err := tpmsim.Load(filepath.Join(dataDir, "fakehw-tpm.json"))
	if err != nil {
		return nil, nil, err
	}
	return sim, func() {}, nil
}

// newHost is a fake machine in the data directory: its files live under fakehw-root/, its boot id in
// fakehw-boot-id, and a reboot writes a new boot id and restarts the process.
func newHost(dataDir string) (agent.Host, error) {
	bootFile := filepath.Join(dataDir, "fakehw-boot-id")
	if _, err := os.Stat(bootFile); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(bootFile, []byte(newUUID()+"\n"), 0o600); err != nil {
			return nil, err
		}
	}
	root := filepath.Join(dataDir, "fakehw-root")
	return &agent.RealHost{
		// What the host units changed under the fake root (hugepages) shows in the inventory.
		Collect: func() (*inventory.NodeInventory, error) {
			return fakehw.ApplyRoot(fakehw.Inventory(fakeSeed()), root), nil
		},
		Root:       root,
		BootIDFile: bootFile,
		RebootFunc: func(string) error {
			if err := os.WriteFile(bootFile, []byte(newUUID()+"\n"), 0o600); err != nil {
				return err
			}
			return reexec()
		},
	}, nil
}

// newSimHost is one machine of bcd sim: the fakehw machine of seed, its files under dataDir. A reboot
// writes a new boot id and calls onReboot: the simulator restarts that machine's agent, not the
// process.
func newSimHost(dataDir string, seed uint64, onReboot func()) (agent.Host, error) {
	bootFile := filepath.Join(dataDir, "fakehw-boot-id")
	if _, err := os.Stat(bootFile); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(bootFile, []byte(newUUID()+"\n"), 0o600); err != nil {
			return nil, err
		}
	}
	root := filepath.Join(dataDir, "fakehw-root")
	return &agent.RealHost{
		Collect:    func() (*inventory.NodeInventory, error) { return fakehw.ApplyRoot(fakehw.Inventory(seed), root), nil },
		Root:       root,
		BootIDFile: bootFile,
		RebootFunc: func(string) error {
			if err := os.WriteFile(bootFile, []byte(newUUID()+"\n"), 0o600); err != nil {
				return err
			}
			onReboot()
			return nil
		},
	}, nil
}

// newRuntimes is the fake instance runtime of a fakehw VPS host (FakeHypervisor's default id); it
// writes the libvirt plan of each domain too (plannedFake).
func newRuntimes(dataDir, bootID string) []runtime.Runtime {
	fake := &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(dataDir, "fakehw-runtime.json"), BootID: bootID}
	return []runtime.Runtime{newPlannedFake(dataDir, fake)}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
