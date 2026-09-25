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

// configBMC is a Redfish service with a BIOS, a RAID controller with two drives, and firmware.
type configBMC struct {
	mu       sync.Mutex
	pending  map[string]any
	volumes  map[string]map[string]any
	nextVol  int
	deleted  []string
	updates  []map[string]any
	requests []string
}

func (b *configBMC) handler() http.Handler {
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
	members := func(ids ...string) map[string]any {
		ms := []map[string]string{}
		for _, id := range ids {
			ms = append(ms, map[string]string{"@odata.id": id})
		}
		return map[string]any{"Members": ms}
	}
	route := func(pattern string, h http.HandlerFunc) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			b.mu.Lock()
			defer b.mu.Unlock()
			b.requests = append(b.requests, r.Method+" "+r.URL.Path)
			h(w, r)
		})
	}
	route("GET /redfish/v1/Systems", func(w http.ResponseWriter, _ *http.Request) { write(w, members("/redfish/v1/Systems/1")) })
	route("GET /redfish/v1/Systems/1", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"Bios": map[string]string{"@odata.id": "/redfish/v1/Systems/1/Bios"}})
	})
	route("GET /redfish/v1/Systems/1/Bios", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{
			"Attributes":        map[string]any{"BootMode": "Uefi", "SriovGlobalEnable": false, "NumaNodesPerSocket": 1},
			"@Redfish.Settings": map[string]any{"SettingsObject": map[string]string{"@odata.id": "/redfish/v1/Systems/1/Bios/Settings"}},
		})
	})
	route("PATCH /redfish/v1/Systems/1/Bios/Settings", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Attributes map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.pending = body.Attributes
	})
	route("GET /redfish/v1/Systems/1/Storage", func(w http.ResponseWriter, _ *http.Request) { write(w, members("/redfish/v1/Systems/1/Storage/RAID")) })
	route("GET /redfish/v1/Systems/1/Storage/RAID", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{
			"Volumes": map[string]string{"@odata.id": "/redfish/v1/Systems/1/Storage/RAID/Volumes"},
			"Drives":  []map[string]string{{"@odata.id": "/redfish/v1/Systems/1/Storage/RAID/Drives/0"}, {"@odata.id": "/redfish/v1/Systems/1/Storage/RAID/Drives/1"}},
		})
	})
	for i, serial := range []string{"S0", "S1"} {
		route("GET /redfish/v1/Systems/1/Storage/RAID/Drives/"+string(rune('0'+i)), func(w http.ResponseWriter, _ *http.Request) {
			write(w, map[string]any{"SerialNumber": serial, "Identifiers": []map[string]string{{"DurableName": "0x5000c500" + serial}}})
		})
	}
	route("GET /redfish/v1/Systems/1/Storage/RAID/Volumes", func(w http.ResponseWriter, _ *http.Request) {
		ids := []string{}
		for id := range b.volumes {
			ids = append(ids, id)
		}
		write(w, members(ids...))
	})
	route("POST /redfish/v1/Systems/1/Storage/RAID/Volumes", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.nextVol++
		b.volumes["/redfish/v1/Systems/1/Storage/RAID/Volumes/"+string(rune('0'+b.nextVol))] = body
		w.WriteHeader(http.StatusCreated)
	})
	route("/redfish/v1/Systems/1/Storage/RAID/Volumes/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			v := b.volumes[r.URL.Path]
			write(w, map[string]any{"RAIDType": v["RAIDType"], "CapacityBytes": v["CapacityBytes"]})
		case http.MethodDelete:
			delete(b.volumes, r.URL.Path)
			b.deleted = append(b.deleted, r.URL.Path)
		}
	})
	route("GET /redfish/v1/UpdateService/FirmwareInventory", func(w http.ResponseWriter, _ *http.Request) {
		write(w, members("/redfish/v1/UpdateService/FirmwareInventory/BIOS"))
	})
	route("GET /redfish/v1/UpdateService/FirmwareInventory/BIOS", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"Id": "BIOS", "Version": "1.0"})
	})
	route("POST /redfish/v1/UpdateService/Actions/UpdateService.SimpleUpdate", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.updates = append(b.updates, body)
		w.WriteHeader(http.StatusAccepted)
	})
	return mux
}

func TestBiosRaidAndFirmware(t *testing.T) {
	bmc := &configBMC{volumes: map[string]map[string]any{"/redfish/v1/Systems/1/Storage/RAID/Volumes/0": {"RAIDType": "RAID0"}}}
	srv := httptest.NewTLSServer(bmc.handler())
	defer srv.Close()
	pin := sha256.Sum256(srv.Certificate().RawSubjectPublicKeyInfo)
	c, _ := New(srv.URL, "admin", "pw", pin[:])
	ctx := context.Background()
	var e *Error

	// BIOS: attributes read as text, written back with the BIOS's own types.
	got, err := c.Do(ctx, "bios.getSettings", nil)
	settings, _ := got["settings"].(map[string]string)
	if err != nil || settings["BootMode"] != "Uefi" || settings["SriovGlobalEnable"] != "false" || settings["NumaNodesPerSocket"] != "1" {
		t.Fatalf("bios.getSettings = %v, %v", got, err)
	}
	if _, err := c.Do(ctx, "bios.applySettings", map[string]any{"settings": map[string]any{"SriovGlobalEnable": "true", "NumaNodesPerSocket": "2", "BootMode": "Legacy"}}); err != nil {
		t.Fatal(err)
	}
	if bmc.pending["SriovGlobalEnable"] != true || bmc.pending["NumaNodesPerSocket"] != float64(2) || bmc.pending["BootMode"] != "Legacy" {
		t.Fatalf("pending BIOS settings = %v", bmc.pending)
	}
	for _, bad := range []map[string]any{{"NoSuchThing": "1"}, {"NumaNodesPerSocket": "many"}, {"SriovGlobalEnable": "maybe"}} {
		if _, err := c.Do(ctx, "bios.applySettings", map[string]any{"settings": bad}); !errors.As(err, &e) || e.Code != "invalid-args" {
			t.Errorf("bios.applySettings %v = %v", bad, err)
		}
	}

	// RAID: the old volume goes, the layout's are created with their drives by serial or WWN.
	layout := map[string]any{"volumes": []any{
		map[string]any{"level": "1", "disks": []any{"S0", "0x5000c500S1"}},
		map[string]any{"level": "0", "sizeGiB": 100},
	}}
	if _, err := c.Do(ctx, "raid.applyLayout", layout); err != nil {
		t.Fatal(err)
	}
	if len(bmc.deleted) != 1 || len(bmc.volumes) != 2 {
		t.Fatalf("volumes = %v, deleted %v", bmc.volumes, bmc.deleted)
	}
	read, err := c.Do(ctx, "raid.getLayout", nil)
	raw, _ := json.Marshal(read)
	if err != nil || !strings.Contains(string(raw), `"level":"1"`) || !strings.Contains(string(raw), `"sizeGiB":100`) {
		t.Fatalf("raid.getLayout = %s, %v", raw, err)
	}
	if _, err := c.Do(ctx, "raid.applyLayout", map[string]any{"volumes": []any{map[string]any{"level": "1", "disks": []any{"nope"}}}}); !errors.As(err, &e) || e.Code != "invalid-args" {
		t.Fatalf("an unknown disk = %v", err)
	}
	if _, err := c.Do(ctx, "raid.applyLayout", map[string]any{"volumes": []any{map[string]any{"level": "4"}}}); !errors.As(err, &e) || e.Code != "invalid-args" {
		t.Fatalf("RAID 4 = %v", err)
	}
	if len(bmc.volumes) != 2 {
		t.Fatal("a refused layout deleted volumes")
	}

	// Firmware: SimpleUpdate targets the component from the image URL given.
	if _, err := c.Do(ctx, "firmware.update", map[string]any{"component": "BIOS", "url": "http://10.0.0.2:8080/cache/ab"}); err != nil {
		t.Fatal(err)
	}
	if len(bmc.updates) != 1 || bmc.updates[0]["ImageURI"] != "http://10.0.0.2:8080/cache/ab" || bmc.updates[0]["TransferProtocol"] != "HTTP" {
		t.Fatalf("updates = %v", bmc.updates)
	}
	if _, err := c.Do(ctx, "firmware.update", map[string]any{"component": "GPU", "url": "http://x/cache/ab"}); !errors.As(err, &e) || e.Code != "invalid-args" {
		t.Fatalf("an unknown component = %v", err)
	}
}
