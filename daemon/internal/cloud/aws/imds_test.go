package aws

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The exact document bytes the attestor verifies (cloud-iid.ts): never re-encoded.
const testDocument = "{\n  \"accountId\" : \"123456789012\",\n  \"architecture\" : \"x86_64\",\n  \"availabilityZone\" : \"us-east-1a\",\n  \"imageId\" : \"ami-0123456789abcdef0\",\n  \"instanceId\" : \"i-0123456789abcdef0\",\n  \"instanceType\" : \"p5.48xlarge\",\n  \"pendingTime\" : \"2026-11-05T10:00:00Z\",\n  \"privateIp\" : \"10.0.0.12\",\n  \"region\" : \"us-east-1\",\n  \"version\" : \"2017-09-30\"\n}"

const testSignature = "dGVzdC1zaWduYXR1cmUtYnl0ZXMtMDEyMzQ1Njc4OWFi\nY2RlZg=="

// fakeIMDS is an IMDSv2 fake: a token from PUT /latest/api/token, every GET needs it.
type fakeIMDS struct {
	t  *testing.T
	mu sync.Mutex
	// paths answers GETs (path → body); a missing path is 404.
	paths    map[string]string
	tokens   int
	requests []string
	// expireNext answers the next GET with 401 (the token expired).
	expireNext bool
	token      string
}

func newFakeIMDS(t *testing.T) (*fakeIMDS, *httptest.Server) {
	f := &fakeIMDS{t: t, paths: map[string]string{
		"/latest/dynamic/instance-identity/document":  testDocument,
		"/latest/dynamic/instance-identity/signature": testSignature,
	}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeIMDS) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path)
	if r.Header.Get("X-Forwarded-For") != "" {
		http.Error(w, "forwarded", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/latest/api/token" {
		if r.Method != http.MethodPut {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("X-aws-ec2-metadata-token-ttl-seconds") != "21600" {
			http.Error(w, "ttl", http.StatusBadRequest)
			return
		}
		f.tokens++
		f.token = "tok-" + strings.Repeat("x", f.tokens)
		_, _ = w.Write([]byte(f.token))
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if f.token == "" || r.Header.Get("X-aws-ec2-metadata-token") != f.token || f.expireNext {
		f.expireNext = false
		http.Error(w, "", http.StatusUnauthorized)
		return
	}
	body, ok := f.paths[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	_, _ = w.Write([]byte(body))
}

func (f *fakeIMDS) log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

// dmiRoot is a host root whose DMI sys_vendor is vendor.
func dmiRoot(t *testing.T, vendor string) string {
	root := t.TempDir()
	dir := filepath.Join(root, "sys", "class", "dmi", "id")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sys_vendor"), []byte(vendor+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func ec2Client(t *testing.T, srv *httptest.Server) *Client {
	return &Client{Root: dmiRoot(t, "Amazon EC2"), Endpoint: srv.URL}
}

func TestTokenThenDocument(t *testing.T) {
	f, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	doc, sig, err := c.IdentityDocument(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if string(doc) != testDocument {
		t.Fatalf("document re-encoded or changed:\n%q", doc)
	}
	if sig != strings.ReplaceAll(testSignature, "\n", "") {
		t.Fatalf("signature %q", sig)
	}
	want := []string{
		"PUT /latest/api/token",
		"GET /latest/dynamic/instance-identity/document",
		"GET /latest/dynamic/instance-identity/signature",
	}
	if got := f.log(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("requests %v, want %v (one token, reused)", got, want)
	}
}

func TestEvidenceIsTheCloudIidFormat(t *testing.T) {
	_, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	raw, err := c.Evidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ev map[string]any
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatal(err)
	}
	if len(ev) != 3 || ev["provider"] != "aws" || ev["document"] != testDocument ||
		ev["signature"] != strings.ReplaceAll(testSignature, "\n", "") {
		t.Fatalf("evidence %s", raw)
	}
}

func TestNoNetworkCallOffEC2(t *testing.T) {
	for _, vendor := range []string{"QEMU", "Google", "Amazon EC2 (not)", ""} {
		f, srv := newFakeIMDS(t)
		c := &Client{Root: dmiRoot(t, vendor), Endpoint: srv.URL}
		if _, _, err := c.IdentityDocument(context.Background()); !errors.Is(err, ErrNotEC2) {
			t.Fatalf("vendor %q: err %v, want ErrNotEC2", vendor, err)
		}
		if _, err := c.Evidence(context.Background()); !errors.Is(err, ErrNotEC2) {
			t.Fatalf("vendor %q: evidence err %v", vendor, err)
		}
		if got := f.log(); len(got) != 0 {
			t.Fatalf("vendor %q: %d requests off EC2", vendor, len(got))
		}
	}
	// No DMI at all (a container without /sys/class/dmi): not EC2 either.
	f, srv := newFakeIMDS(t)
	c := &Client{Root: t.TempDir(), Endpoint: srv.URL}
	if _, err := c.Get(context.Background(), "/latest/meta-data/instance-id"); !errors.Is(err, ErrNotEC2) {
		t.Fatalf("no DMI: %v", err)
	}
	if len(f.log()) != 0 {
		t.Fatal("requests without DMI")
	}
	if OnEC2(dmiRoot(t, "Amazon EC2")) != true || OnEC2(dmiRoot(t, "QEMU")) {
		t.Fatal("OnEC2")
	}
}

// writeDMI writes one more /sys file under a dmiRoot.
func writeDMI(t *testing.T, root, rel, value string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(value+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Previous-generation (Xen) instance types (t2, m4, c4, r4, non-metal i3) report sys_vendor "Xen";
// EC2 marks them in the BIOS version ("4.11.amazon") and the hypervisor and product UUIDs ("ec2…").
// Local files only, still before any network call; a Xen host without those marks is not EC2.
func TestOnEC2RecognisesXenInstances(t *testing.T) {
	bios := dmiRoot(t, "Xen")
	writeDMI(t, bios, "sys/class/dmi/id/bios_version", "4.11.amazon")
	hyper := dmiRoot(t, "Xen")
	writeDMI(t, hyper, "sys/hypervisor/uuid", "ec2e1916-9099-7caf-fd21-012345678901")
	product := dmiRoot(t, "Xen")
	writeDMI(t, product, "sys/class/dmi/id/product_uuid", "EC2E1916-9099-7CAF-FD21-012345678901")
	for name, root := range map[string]string{"bios_version": bios, "hypervisor uuid": hyper, "product_uuid": product} {
		if !OnEC2(root) {
			t.Errorf("Xen EC2 by %s: not recognised", name)
		}
	}
	plain := dmiRoot(t, "Xen")
	writeDMI(t, plain, "sys/class/dmi/id/bios_version", "4.2.5")
	writeDMI(t, plain, "sys/hypervisor/uuid", "3fa1e5b2-0000-0000-0000-000000000000")
	notXen := dmiRoot(t, "QEMU")
	writeDMI(t, notXen, "sys/class/dmi/id/bios_version", "1.amazon")
	for name, root := range map[string]string{"plain Xen": plain, "QEMU with an amazon BIOS": notXen} {
		f, srv := newFakeIMDS(t)
		c := &Client{Root: root, Endpoint: srv.URL}
		if OnEC2(root) {
			t.Errorf("%s: taken for EC2", name)
		}
		if _, err := c.Get(context.Background(), "/latest/meta-data/instance-id"); !errors.Is(err, ErrNotEC2) || len(f.log()) != 0 {
			t.Errorf("%s: err %v, %d requests", name, err, len(f.log()))
		}
	}
}

func TestExpiredTokenIsRenewedOnce(t *testing.T) {
	f, srv := newFakeIMDS(t)
	f.paths["/latest/meta-data/instance-id"] = "i-0123456789abcdef0"
	c := ec2Client(t, srv)
	if _, err := c.Get(context.Background(), "/latest/meta-data/instance-id"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.expireNext = true
	f.mu.Unlock()
	got, err := c.Get(context.Background(), "/latest/meta-data/instance-id")
	if err != nil || string(got) != "i-0123456789abcdef0" {
		t.Fatalf("%q %v", got, err)
	}
	if f.tokens != 2 {
		t.Fatalf("%d tokens, want 2", f.tokens)
	}
}

func TestTokenIsCachedUntilNearExpiry(t *testing.T) {
	f, srv := newFakeIMDS(t)
	f.paths["/latest/meta-data/instance-id"] = "i-1"
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	c := ec2Client(t, srv)
	c.Now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if _, err := c.Get(context.Background(), "/latest/meta-data/instance-id"); err != nil {
			t.Fatal(err)
		}
	}
	if f.tokens != 1 {
		t.Fatalf("%d tokens", f.tokens)
	}
	now = now.Add(6 * time.Hour)
	if _, err := c.Get(context.Background(), "/latest/meta-data/instance-id"); err != nil {
		t.Fatal(err)
	}
	if f.tokens != 2 {
		t.Fatalf("%d tokens after the TTL", f.tokens)
	}
}

func TestNotFoundIsErrNotFound(t *testing.T) {
	_, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	_, err := c.Get(context.Background(), "/latest/meta-data/spot/instance-action")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err %v", err)
	}
}

func TestRefusesRedirectsAndOversizedAnswers(t *testing.T) {
	var hits int
	mux := http.NewServeMux()
	mux.HandleFunc("/latest/api/token", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("t")) })
	mux.HandleFunc("/latest/meta-data/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	})
	mux.HandleFunc("/elsewhere", func(w http.ResponseWriter, r *http.Request) { hits++ })
	mux.HandleFunc("/latest/meta-data/big", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("a", maxAnswer+1)))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := ec2Client(t, srv)
	if _, err := c.Get(context.Background(), "/latest/meta-data/redirect"); err == nil || hits != 0 {
		t.Fatalf("redirect followed: %v, hits %d", err, hits)
	}
	if _, err := c.Get(context.Background(), "/latest/meta-data/big"); err == nil {
		t.Fatal("oversized answer accepted")
	}
	if _, err := c.Get(context.Background(), "http://evil.example/latest/x"); err == nil {
		t.Fatal("absolute URL accepted as a path")
	}
}

func TestTimesOutAfterOneSecond(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer srv.Close()
	defer close(release)
	c := ec2Client(t, srv)
	c.Timeout = 50 * time.Millisecond
	start := time.Now()
	if _, err := c.Get(context.Background(), "/latest/meta-data/instance-id"); err == nil {
		t.Fatal("no timeout")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %s", d)
	}
	if (&Client{}).timeout() != time.Second {
		t.Fatal("default timeout is not 1 s")
	}
}

func TestErrorsNeverCarryTheToken(t *testing.T) {
	f, srv := newFakeIMDS(t)
	f.paths["/latest/meta-data/x"] = "x"
	c := ec2Client(t, srv)
	if _, err := c.Get(context.Background(), "/latest/meta-data/x"); err != nil {
		t.Fatal(err)
	}
	_, err := c.Get(context.Background(), "/latest/meta-data/missing")
	if err == nil || strings.Contains(err.Error(), f.token) {
		t.Fatalf("error %v", err)
	}
}

func TestRefusesADocumentWithoutIdentity(t *testing.T) {
	f, srv := newFakeIMDS(t)
	f.paths["/latest/dynamic/instance-identity/document"] = `{"region":"us-east-1"}`
	c := ec2Client(t, srv)
	if _, _, err := c.IdentityDocument(context.Background()); err == nil {
		t.Fatal("document without instanceId/accountId accepted")
	}
	f.paths["/latest/dynamic/instance-identity/document"] = testDocument
	f.paths["/latest/dynamic/instance-identity/signature"] = "not base64 !"
	if _, _, err := c.IdentityDocument(context.Background()); err == nil {
		t.Fatal("malformed signature accepted")
	}
}
