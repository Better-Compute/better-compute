package runtime

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// Post-restore identity rebind (review 13 H2). A memory-restored guest resumes with its source's
// sshd identity: principals naming the source instance and the source's certified host key. bcd
// gives it its own through a raw disk it hot-adds with virtio serial "bc-rebind".
//
// Disk layout: a tar at offset 0 (members nonce, account, principals and, with a host key,
// host_key and host_key-cert.pub), zero padding to RebindImageSize, and the last 4 KiB kept free for
// the guest's acknowledgement.
//
// Guest half: a udev rule and a oneshot unit (daemon/README.md "Identity rebind") install the files,
// reload sshd, and write "BCREBOUND <nonce>\n" into the last 4 KiB. bcd waits for that line, removes
// the disk, scrubs its file, and reports the rebind ref applied (InstanceStatus.identity_rebound_ref).
const (
	RebindSerial    = "bc-rebind"
	RebindImageSize = 1 << 20
	rebindAckSize   = 4096
	// RebindTimeout bounds the wait for the guest's acknowledgement.
	RebindTimeout = 2 * time.Minute
)

// Rebind is a rebind bundle (vps seals it; {"v":1,"account","principals","hostKey"?,"hostCertificate"?}).
type Rebind struct {
	V               int    `json:"v"`
	Account         string `json:"account"`
	Principals      string `json:"principals"`
	HostKey         string `json:"hostKey,omitempty"`
	HostCertificate string `json:"hostCertificate,omitempty"`
}

// Rebinder installs a new identity into a running guest.
type Rebinder interface {
	Rebind(ctx context.Context, id string, bundle Rebind) error
}

var (
	rebindAccount   = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	rebindPrincipal = regexp.MustCompile(`^[A-Za-z0-9_.@+-]{1,255}$`)
	rebindCert      = regexp.MustCompile(`^(ssh|ecdsa)-[a-z0-9-]+-cert-v01@openssh\.com [A-Za-z0-9+/=]+( [^\r\n]*)?\n?$`)
)

// ParseRebind checks a bundle: an account name, principal lines, and a host key with its
// certificate or neither.
func ParseRebind(raw []byte) (Rebind, error) {
	var b Rebind
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if len(raw) > 64<<10 || dec.Decode(&b) != nil || b.V != 1 {
		return Rebind{}, errors.New("not a rebind bundle")
	}
	if !rebindAccount.MatchString(b.Account) {
		return Rebind{}, fmt.Errorf("rebind account %q", b.Account)
	}
	lines := strings.Split(strings.TrimSuffix(b.Principals, "\n"), "\n")
	for _, l := range lines {
		if !rebindPrincipal.MatchString(l) {
			return Rebind{}, fmt.Errorf("rebind principal %q", l)
		}
	}
	if (b.HostKey == "") != (b.HostCertificate == "") {
		return Rebind{}, errors.New("a rebind host key comes with its certificate")
	}
	if b.HostKey != "" && (!strings.HasPrefix(b.HostKey, "-----BEGIN ") || !rebindCert.MatchString(b.HostCertificate)) {
		return Rebind{}, errors.New("the rebind host key or certificate is malformed")
	}
	return b, nil
}

// rebindImage is the disk for bundle, and its nonce.
func rebindImage(b Rebind) ([]byte, string, error) {
	n := make([]byte, 16)
	if _, err := rand.Read(n); err != nil {
		return nil, "", err
	}
	nonce := hex.EncodeToString(n)
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	files := [][2]string{{"nonce", nonce + "\n"}, {"account", b.Account + "\n"}, {"principals", strings.TrimSuffix(b.Principals, "\n") + "\n"}}
	if b.HostKey != "" {
		files = append(files, [2]string{"host_key", b.HostKey}, [2]string{"host_key-cert.pub", b.HostCertificate})
	}
	for _, f := range files {
		if err := tw.WriteHeader(&tar.Header{Name: f[0], Mode: 0o600, Size: int64(len(f[1])), Typeflag: tar.TypeReg}); err != nil {
			return nil, "", err
		}
		if _, err := tw.Write([]byte(f[1])); err != nil {
			return nil, "", err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, "", err
	}
	if buf.Len() > RebindImageSize-rebindAckSize {
		return nil, "", errors.New("the rebind bundle is too large")
	}
	img := make([]byte, RebindImageSize)
	copy(img, buf.Bytes())
	return img, nonce, nil
}

// rebindAcked reports whether the guest wrote its acknowledgement for nonce into the disk at path.
func rebindAcked(path, nonce string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	ack := make([]byte, rebindAckSize)
	if _, err := f.ReadAt(ack, RebindImageSize-rebindAckSize); err != nil {
		return false
	}
	return bytes.HasPrefix(ack, []byte("BCREBOUND "+nonce+"\n"))
}

// scrub zeroes a rebind disk (its host key) before removing it.
func scrub(path string) {
	if f, err := os.OpenFile(path, os.O_WRONLY, 0); err == nil {
		_, _ = f.WriteAt(make([]byte, RebindImageSize), 0)
		_ = f.Sync()
		f.Close()
	}
	_ = os.Remove(path)
}

// waitAck polls for the guest's acknowledgement until timeout.
func waitAck(ctx context.Context, path, nonce string, timeout, poll time.Duration) error {
	deadline := time.Now().Add(timeout)
	for !rebindAcked(path, nonce) {
		if time.Now().After(deadline) {
			return errors.New("the guest did not acknowledge the rebind (no bc-rebind unit?)")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(poll):
		}
	}
	return nil
}
