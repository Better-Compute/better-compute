package redfish

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeBMC is a minimal Redfish service: one system, one manager with a CD, one account.
type fakeBMC struct {
	mu       sync.Mutex
	password string
	power    string
	boot     map[string]string
	media    string
	resets   []string
}

func (b *fakeBMC) handler() http.Handler {
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
	member := func(ids ...string) map[string]any {
		var ms []map[string]string
		for _, id := range ids {
			ms = append(ms, map[string]string{"@odata.id": id})
		}
		return map[string]any{"Members": ms}
	}
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			user, pass, ok := r.BasicAuth()
			b.mu.Lock()
			good := ok && user == "admin" && pass == b.password
			b.mu.Unlock()
			if !good {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			b.mu.Lock()
			defer b.mu.Unlock()
			next(w, r)
		}
	}
	mux.HandleFunc("GET /redfish/v1/Systems", auth(func(w http.ResponseWriter, _ *http.Request) { write(w, member("/redfish/v1/Systems/1")) }))
	mux.HandleFunc("GET /redfish/v1/Systems/1", auth(func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"PowerState": b.power, "Manufacturer": "Supermicro", "UUID": "4C4C4544-AAAA", "SerialNumber": "S1"})
	}))
	mux.HandleFunc("PATCH /redfish/v1/Systems/1", auth(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Boot map[string]string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.boot = body.Boot
	}))
	mux.HandleFunc("POST /redfish/v1/Systems/1/Actions/ComputerSystem.Reset", auth(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ ResetType string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.resets = append(b.resets, body.ResetType)
		if body.ResetType == "ForceOff" {
			b.power = "Off"
		} else {
			b.power = "On"
		}
	}))
	mux.HandleFunc("GET /redfish/v1/Systems/1/EthernetInterfaces", auth(func(w http.ResponseWriter, _ *http.Request) {
		write(w, member("/redfish/v1/Systems/1/EthernetInterfaces/1"))
	}))
	mux.HandleFunc("GET /redfish/v1/Systems/1/EthernetInterfaces/1", auth(func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"MACAddress": "B8:3F:D2:00:00:01", "IPv4Addresses": []map[string]string{{"Address": "10.20.0.7"}}})
	}))
	mux.HandleFunc("GET /redfish/v1/Managers", auth(func(w http.ResponseWriter, _ *http.Request) { write(w, member("/redfish/v1/Managers/1")) }))
	mux.HandleFunc("GET /redfish/v1/Managers/1/VirtualMedia", auth(func(w http.ResponseWriter, _ *http.Request) {
		write(w, member("/redfish/v1/Managers/1/VirtualMedia/Floppy", "/redfish/v1/Managers/1/VirtualMedia/CD"))
	}))
	mux.HandleFunc("GET /redfish/v1/Managers/1/VirtualMedia/Floppy", auth(func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"MediaTypes": []string{"Floppy"}})
	}))
	mux.HandleFunc("GET /redfish/v1/Managers/1/VirtualMedia/CD", auth(func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"MediaTypes": []string{"CD", "DVD"}})
	}))
	mux.HandleFunc("POST /redfish/v1/Managers/1/VirtualMedia/CD/Actions/VirtualMedia.InsertMedia", auth(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Image string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.media = body.Image
	}))
	mux.HandleFunc("POST /redfish/v1/Managers/1/VirtualMedia/CD/Actions/VirtualMedia.EjectMedia", auth(func(w http.ResponseWriter, _ *http.Request) { b.media = "" }))
	mux.HandleFunc("GET /redfish/v1/AccountService/Accounts", auth(func(w http.ResponseWriter, _ *http.Request) {
		write(w, member("/redfish/v1/AccountService/Accounts/2"))
	}))
	mux.HandleFunc("GET /redfish/v1/AccountService/Accounts/2", auth(func(w http.ResponseWriter, _ *http.Request) { write(w, map[string]string{"UserName": "admin"}) }))
	mux.HandleFunc("PATCH /redfish/v1/AccountService/Accounts/2", auth(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Password string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.password = body.Password
	}))
	return mux
}

func TestRedfishOperations(t *testing.T) {
	bmc := &fakeBMC{password: "old", power: "Off"}
	srv := httptest.NewTLSServer(bmc.handler())
	defer srv.Close()
	pin := sha256.Sum256(srv.Certificate().RawSubjectPublicKeyInfo)
	ctx := context.Background()
	c, err := New(srv.URL, "admin", "old", pin[:])
	if err != nil {
		t.Fatal(err)
	}
	if r, err := c.Do(ctx, "power.getPower", nil); err != nil || r["power"] != "off" {
		t.Fatalf("getPower = %v, %v", r, err)
	}
	if _, err := c.Do(ctx, "power.setPower", map[string]any{"action": "on"}); err != nil || bmc.power != "On" || bmc.resets[0] != "On" {
		t.Fatalf("setPower: %v %v", err, bmc.resets)
	}
	if _, err := c.Do(ctx, "management.setBootDevice", map[string]any{"device": "pxe", "uefi": true}); err != nil ||
		bmc.boot["BootSourceOverrideTarget"] != "Pxe" || bmc.boot["BootSourceOverrideEnabled"] != "Once" || bmc.boot["BootSourceOverrideMode"] != "UEFI" {
		t.Fatalf("setBootDevice: %v %v", err, bmc.boot)
	}
	if _, err := c.Do(ctx, "virtual-media.insert", map[string]any{"url": "https://cache/x.iso"}); err != nil || bmc.media != "https://cache/x.iso" {
		t.Fatalf("insert: %v %q", err, bmc.media)
	}
	if _, err := c.Do(ctx, "virtual-media.eject", nil); err != nil || bmc.media != "" {
		t.Fatalf("eject: %v", err)
	}
	r, err := c.Do(ctx, "inspect.inspect", nil)
	if err != nil || r["productUuid"] != "4c4c4544-aaaa" || r["macs"].([]string)[0] != "b8:3f:d2:00:00:01" || r["ipAddresses"].([]string)[0] != "10.20.0.7" {
		t.Fatalf("inspect = %v, %v", r, err)
	}
	if r, err := c.Do(ctx, "management.rotateCredential", map[string]any{"newPassword": "n3w-S3cret"}); err != nil || r["verified"] != true || bmc.password != "n3w-S3cret" {
		t.Fatalf("rotate = %v, %v", r, err)
	}
	// The old password no longer works: auth-failed.
	var e *Error
	if _, err := c.Do(ctx, "power.getPower", nil); !errors.As(err, &e) || e.Code != "auth-failed" {
		t.Fatalf("old password: %v", err)
	}
	if _, err := c.Do(ctx, "bios.apply", nil); !errors.As(err, &e) || e.Code != "unsupported" {
		t.Fatalf("unknown op: %v", err)
	}
	// Another pin refuses the BMC outright.
	wrong := pin
	wrong[0] ^= 1
	other, _ := New(srv.URL, "admin", "n3w-S3cret", wrong[:])
	if _, err := other.Do(ctx, "power.getPower", nil); !errors.As(err, &e) || e.Code != "unreachable" || !strings.Contains(e.Message, "pinned") {
		t.Fatalf("wrong pin: %v", err)
	}
	if _, err := New("http://10.0.0.1", "a", "b", nil); err == nil {
		t.Fatal("a plain-http BMC was accepted")
	}
}

// A service with several systems (sushy-tools over libvirt, a chassis manager): the address names
// the system, and virtual media goes to that system's manager.
func TestRedfishAddressNamesTheSystem(t *testing.T) {
	var mu sync.Mutex
	var resets, inserted []string
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
	mux.HandleFunc("GET /redfish/v1/Systems", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"Members": []map[string]string{{"@odata.id": "/redfish/v1/Systems/a"}, {"@odata.id": "/redfish/v1/Systems/b"}}})
	})
	for _, id := range []string{"a", "b"} {
		mux.HandleFunc("GET /redfish/v1/Systems/"+id, func(w http.ResponseWriter, _ *http.Request) {
			write(w, map[string]any{"PowerState": "On", "UUID": "UUID-" + id, "Links": map[string]any{"ManagedBy": []map[string]string{{"@odata.id": "/redfish/v1/Managers/m" + id}}}})
		})
		mux.HandleFunc("POST /redfish/v1/Systems/"+id+"/Actions/ComputerSystem.Reset", func(http.ResponseWriter, *http.Request) {
			mu.Lock()
			resets = append(resets, id)
			mu.Unlock()
		})
		mux.HandleFunc("GET /redfish/v1/Managers/m"+id+"/VirtualMedia", func(w http.ResponseWriter, _ *http.Request) {
			write(w, map[string]any{"Members": []map[string]string{{"@odata.id": "/redfish/v1/Managers/m" + id + "/VirtualMedia/Cd"}}})
		})
		mux.HandleFunc("GET /redfish/v1/Managers/m"+id+"/VirtualMedia/Cd", func(w http.ResponseWriter, _ *http.Request) {
			write(w, map[string]any{"MediaTypes": []string{"CD"}})
		})
		mux.HandleFunc("POST /redfish/v1/Managers/m"+id+"/VirtualMedia/Cd/Actions/VirtualMedia.InsertMedia", func(http.ResponseWriter, *http.Request) {
			mu.Lock()
			inserted = append(inserted, id)
			mu.Unlock()
		})
	}
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()
	pin := sha256.Sum256(srv.Certificate().RawSubjectPublicKeyInfo)
	ctx := context.Background()

	address := "redfish://" + strings.TrimPrefix(srv.URL, "https://") + "/redfish/v1/Systems/b"
	c, err := New(address, "admin", "pw", pin[:])
	if err != nil {
		t.Fatal(err)
	}
	if r, err := c.Do(ctx, "inspect.inspect", nil); err != nil || r["productUuid"] != "uuid-b" {
		t.Fatalf("inspect = %v, %v", r, err)
	}
	if _, err := c.Do(ctx, "power.setPower", map[string]any{"action": "reset"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Do(ctx, "virtual-media.insert", map[string]any{"url": "https://cache/x.iso"}); err != nil {
		t.Fatal(err)
	}
	if len(resets) != 1 || resets[0] != "b" || len(inserted) != 1 || inserted[0] != "b" {
		t.Fatalf("resets %v, media %v; want system b and its manager", resets, inserted)
	}
	// Without a path, the first system.
	first, _ := New(srv.URL, "admin", "pw", pin[:])
	if r, err := first.Do(ctx, "inspect.inspect", nil); err != nil || r["productUuid"] != "uuid-a" {
		t.Fatalf("first system = %v, %v", r, err)
	}
	for _, bad := range []string{
		srv.URL + "/redfish/v1/Managers/ma",
		srv.URL + "/redfish/v1/Systems/a/../../x",
		srv.URL + "/other",
		"https://user:pw@10.0.0.1",
		srv.URL + "/redfish/v1/Systems/a?x=1",
	} {
		if _, err := New(bad, "a", "b", nil); err == nil {
			t.Errorf("address %q was accepted", bad)
		}
	}
}

// Resource paths come from the BMC's answers; one pointing elsewhere is never followed.
func TestRedfishRefusesForeignResourcePaths(t *testing.T) {
	var hits sync.Map
	mux := http.NewServeMux()
	mux.HandleFunc("GET /redfish/v1/Systems", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"Members": []map[string]string{{"@odata.id": "@evil.example/redfish/v1/Systems/1"}}})
	})
	mux.HandleFunc("/", func(_ http.ResponseWriter, r *http.Request) { hits.Store(r.URL.Path, true) })
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()
	pin := sha256.Sum256(srv.Certificate().RawSubjectPublicKeyInfo)
	c, _ := New(srv.URL, "admin", "pw", pin[:])
	var e *Error
	if _, err := c.Do(context.Background(), "power.getPower", nil); !errors.As(err, &e) || e.Code != "bmc-error" || !strings.Contains(e.Message, "outside /redfish/v1") {
		t.Fatalf("foreign path: %v", err)
	}
}
