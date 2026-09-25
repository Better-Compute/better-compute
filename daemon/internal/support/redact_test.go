package support

import (
	"strings"
	"testing"
)

func TestRedactMirrorsPki(t *testing.T) {
	text := strings.Join([]string{
		"env: BCD_JOIN_TOKEN=bcjt_join_01k5w0000000000000000000000.secretsecret",
		"auth biam_ses_abcdef123456 used",
		"jwt eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln",
		"db postgres://app:hunter22@db.internal:5432/compute",
		"-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----",
		"deployment secret s3cr3t-deployment-value here",
		"plain line",
	}, "\n")
	out, n := Redact(text, "s3cr3t-deployment-value", "short")
	want := strings.Join([]string{
		"env: BCD_JOIN_TOKEN=bcjt_[redacted]",
		"auth biam_[redacted] used",
		"jwt [redacted:jwt]",
		"db postgres://app:[redacted:url-password]@db.internal:5432/compute",
		"[redacted:private-key]",
		"deployment secret [redacted:known-value] here",
		"plain line",
	}, "\n")
	if out != want || n != 6 {
		t.Fatalf("redacted (%d):\n%s", n, out)
	}
	// A re-scan of redacted text comes back clean.
	if again, n := Redact(out); n != 0 || again != out {
		t.Fatalf("re-scan found %d: %s", n, again)
	}
	// A known value inside a token does not leave the rest of the token behind.
	if out, _ := Redact("x bcjt_abc_secretvalue1.zzz y", "secretvalue1"); out != "x bcjt_[redacted] y" {
		t.Fatalf("overlap = %q", out)
	}
}
