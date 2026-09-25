package runtime

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestParseRebind(t *testing.T) {
	cert := "ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAKGVjZHNh inst_1\n"
	for raw, ok := range map[string]bool{
		`{"v":1,"account":"sandbox","principals":"sandbox@inst_1\n"}`:                                          true,
		`{"v":1,"account":"sandbox","principals":"sandbox@inst_1","hostKey":"-----BEGIN OPENSSH PRIVATE KEY-----\nx\n","hostCertificate":"` + cert[:len(cert)-1] + `"}`: true,
		`{"v":2,"account":"sandbox","principals":"sandbox@inst_1"}`:                                            false,
		`{"v":1,"account":"root; rm -rf /","principals":"x@y"}`:                                                false,
		`{"v":1,"account":"sandbox","principals":"a@b\n../../etc/passwd x"}`:                                   false,
		`{"v":1,"account":"sandbox","principals":"a@b","hostKey":"-----BEGIN KEY-----"}`:                       false,
		`{"v":1,"account":"sandbox","principals":"a@b","extra":1}`:                                             false,
	} {
		if _, err := ParseRebind([]byte(raw)); (err == nil) != ok {
			t.Errorf("ParseRebind(%s) = %v", raw, err)
		}
	}
}

// The disk is the tar the guest's unit reads, room for its acknowledgement, and nothing else.
func TestRebindImage(t *testing.T) {
	img, nonce, err := rebindImage(Rebind{V: 1, Account: "sandbox", Principals: "sandbox@inst_1", HostKey: "-----BEGIN k", HostCertificate: "c"})
	if err != nil || len(img) != RebindImageSize || len(nonce) != 32 {
		t.Fatal(len(img), nonce, err)
	}
	files := map[string]string{}
	tr := tar.NewReader(bytes.NewReader(img))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		files[h.Name] = string(b)
	}
	if files["nonce"] != nonce+"\n" || files["account"] != "sandbox\n" || files["principals"] != "sandbox@inst_1\n" || files["host_key"] != "-----BEGIN k" || files["host_key-cert.pub"] != "c" {
		t.Fatalf("files = %v", files)
	}
	path := filepath.Join(t.TempDir(), "rebind.img")
	_ = os.WriteFile(path, img, 0o600)
	if rebindAcked(path, nonce) {
		t.Fatal("acknowledged before the guest wrote")
	}
	if err := guestAck(path); err != nil || !rebindAcked(path, nonce) || rebindAcked(path, "other") {
		t.Fatalf("ack: %v", err)
	}
	scrub(path)
	if _, err := os.Stat(path); err == nil {
		t.Fatal("scrubbed disk stayed")
	}
}
