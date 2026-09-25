package redfish

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// BIOS settings, RAID layouts and firmware updates (metal's bios, raid and firmware kinds; v0.5).

type link struct {
	ID string `json:"@odata.id"`
}

// biosPath is the system's Bios resource.
func (c *Client) biosPath(ctx context.Context) (string, error) {
	sys, err := c.systemPath(ctx)
	if err != nil {
		return "", err
	}
	var s struct {
		Bios link `json:"Bios"`
	}
	if err := c.call(ctx, http.MethodGet, sys, nil, &s); err != nil {
		return "", err
	}
	if s.Bios.ID != "" {
		return s.Bios.ID, nil
	}
	return sys + "/Bios", nil
}

type biosResource struct {
	Attributes map[string]json.RawMessage `json:"Attributes"`
	Settings   struct {
		Object link `json:"SettingsObject"`
	} `json:"@Redfish.Settings"`
}

func (c *Client) readBios(ctx context.Context) (string, biosResource, error) {
	path, err := c.biosPath(ctx)
	if err != nil {
		return "", biosResource{}, err
	}
	var b biosResource
	err = c.call(ctx, http.MethodGet, path, nil, &b)
	return path, b, err
}

// attributeText is an attribute as metal compares it: its value as text.
func attributeText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}

func (c *Client) biosSettings(ctx context.Context) (map[string]any, error) {
	_, b, err := c.readBios(ctx)
	if err != nil {
		return nil, err
	}
	settings := map[string]string{}
	for k, v := range b.Attributes {
		settings[k] = attributeText(v)
	}
	return map[string]any{"settings": settings}, nil
}

// applyBios writes the attributes to the pending settings (they apply on the next boot), each with
// the type the BIOS reports for it: metal's values are text.
func (c *Client) applyBios(ctx context.Context, args map[string]any) (map[string]any, error) {
	want, _ := args["settings"].(map[string]any)
	if len(want) == 0 {
		return nil, fail("invalid-args", "no settings")
	}
	path, b, err := c.readBios(ctx)
	if err != nil {
		return nil, err
	}
	attributes := map[string]any{}
	names := make([]string, 0, len(want))
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		text := fmt.Sprint(want[name])
		current, ok := b.Attributes[name]
		if !ok {
			return nil, fail("invalid-args", "the BIOS has no attribute %q", name)
		}
		var typed any
		switch {
		case json.Unmarshal(current, new(bool)) == nil:
			v, err := strconv.ParseBool(text)
			if err != nil {
				return nil, fail("invalid-args", "BIOS attribute %s is a boolean, not %q", name, text)
			}
			typed = v
		case json.Unmarshal(current, new(json.Number)) == nil && !strings.HasPrefix(string(current), `"`):
			v, err := strconv.ParseInt(text, 10, 64)
			if err != nil {
				return nil, fail("invalid-args", "BIOS attribute %s is an integer, not %q", name, text)
			}
			typed = v
		default:
			typed = text
		}
		attributes[name] = typed
	}
	target := b.Settings.Object.ID
	if target == "" {
		target = path + "/Settings"
	}
	if err := c.call(ctx, http.MethodPatch, target, map[string]any{"Attributes": attributes}, nil); err != nil {
		return nil, err
	}
	return map[string]any{"pendingReboot": true, "changed": names}, nil
}

// storage is the system's first storage subsystem that has volumes (the RAID controller).
func (c *Client) storage(ctx context.Context) (path string, volumes string, drives []link, err error) {
	sys, err := c.systemPath(ctx)
	if err != nil {
		return "", "", nil, err
	}
	var col collection
	if err := c.call(ctx, http.MethodGet, sys+"/Storage", nil, &col); err != nil {
		return "", "", nil, err
	}
	for _, m := range col.Members {
		var s struct {
			Volumes link   `json:"Volumes"`
			Drives  []link `json:"Drives"`
		}
		if err := c.call(ctx, http.MethodGet, m.ID, nil, &s); err != nil {
			return "", "", nil, err
		}
		if s.Volumes.ID != "" {
			return m.ID, s.Volumes.ID, s.Drives, nil
		}
	}
	return "", "", nil, fail("unsupported", "the system has no RAID controller with volumes")
}

// levels maps metal's RAID levels to Redfish RAIDType and back.
var levels = map[string]string{"0": "RAID0", "1": "RAID1", "5": "RAID5", "6": "RAID6", "10": "RAID10"}

func (c *Client) raidLayout(ctx context.Context) (map[string]any, error) {
	_, volumesPath, _, err := c.storage(ctx)
	if err != nil {
		return nil, err
	}
	var col collection
	if err := c.call(ctx, http.MethodGet, volumesPath, nil, &col); err != nil {
		return nil, err
	}
	volumes := []map[string]any{}
	for _, m := range col.Members {
		var v struct {
			RAIDType      string `json:"RAIDType"`
			CapacityBytes int64  `json:"CapacityBytes"`
		}
		if err := c.call(ctx, http.MethodGet, m.ID, nil, &v); err != nil {
			return nil, err
		}
		level := strings.TrimPrefix(v.RAIDType, "RAID")
		volume := map[string]any{"level": level}
		if v.CapacityBytes > 0 {
			volume["sizeGiB"] = v.CapacityBytes >> 30
		}
		volumes = append(volumes, volume)
	}
	return map[string]any{"volumes": volumes}, nil
}

// clearVolumes deletes every volume of the controller (their data goes with them).
func (c *Client) clearVolumes(ctx context.Context, volumesPath string) (int, error) {
	var col collection
	if err := c.call(ctx, http.MethodGet, volumesPath, nil, &col); err != nil {
		return 0, err
	}
	for _, m := range col.Members {
		if err := c.call(ctx, http.MethodDelete, m.ID, nil, nil); err != nil {
			return 0, err
		}
	}
	return len(col.Members), nil
}

func (c *Client) raidClear(ctx context.Context) (map[string]any, error) {
	_, volumesPath, _, err := c.storage(ctx)
	if err != nil {
		return nil, err
	}
	n, err := c.clearVolumes(ctx, volumesPath)
	if err != nil {
		return nil, err
	}
	return map[string]any{"deleted": n}, nil
}

// applyRaid replaces the controller's volumes with the layout: every existing volume is deleted
// first (commissioning, before the wipe). Member disks are named by serial number or WWN.
func (c *Client) applyRaid(ctx context.Context, args map[string]any) (map[string]any, error) {
	raw, _ := json.Marshal(args["volumes"])
	var want []struct {
		Level   string   `json:"level"`
		SizeGiB int64    `json:"sizeGiB"`
		Disks   []string `json:"disks"`
	}
	if err := json.Unmarshal(raw, &want); err != nil || len(want) == 0 {
		return nil, fail("invalid-args", "volumes must be a non-empty list of {level, sizeGiB?, disks?}")
	}
	for _, v := range want {
		if levels[v.Level] == "" {
			return nil, fail("invalid-args", "RAID level %q is not 0, 1, 5, 6 or 10", v.Level)
		}
	}
	_, volumesPath, drives, err := c.storage(ctx)
	if err != nil {
		return nil, err
	}
	// Serial numbers and WWNs of the controller's drives.
	byName := map[string]string{}
	for _, d := range drives {
		var drive struct {
			SerialNumber string `json:"SerialNumber"`
			Identifiers  []struct {
				DurableName string `json:"DurableName"`
			} `json:"Identifiers"`
		}
		if c.call(ctx, http.MethodGet, d.ID, nil, &drive) != nil {
			continue
		}
		if drive.SerialNumber != "" {
			byName[strings.ToLower(drive.SerialNumber)] = d.ID
		}
		for _, id := range drive.Identifiers {
			if id.DurableName != "" {
				byName[strings.ToLower(id.DurableName)] = d.ID
			}
		}
	}
	bodies := make([]map[string]any, 0, len(want))
	for _, v := range want {
		body := map[string]any{"RAIDType": levels[v.Level]}
		if v.SizeGiB > 0 {
			body["CapacityBytes"] = v.SizeGiB << 30
		}
		if len(v.Disks) > 0 {
			members := make([]link, 0, len(v.Disks))
			for _, disk := range v.Disks {
				id, ok := byName[strings.ToLower(disk)]
				if !ok {
					return nil, fail("invalid-args", "no drive with serial number or WWN %q on the controller", disk)
				}
				members = append(members, link{ID: id})
			}
			body["Links"] = map[string]any{"Drives": members}
		}
		bodies = append(bodies, body)
	}
	if _, err := c.clearVolumes(ctx, volumesPath); err != nil {
		return nil, err
	}
	for _, body := range bodies {
		if err := c.call(ctx, http.MethodPost, volumesPath, body, nil); err != nil {
			return nil, err
		}
	}
	return map[string]any{"volumes": len(bodies)}, nil
}

// updateFirmware asks the BMC to fetch and apply one component's image (UpdateService.SimpleUpdate).
// imageURL is where the BMC fetches it: the site agent's verified cache, never an unverified source.
func (c *Client) updateFirmware(ctx context.Context, component, imageURL string) (map[string]any, error) {
	if component == "" || imageURL == "" {
		return nil, fail("invalid-args", "firmware.update needs a component and an image")
	}
	var col collection
	if err := c.call(ctx, http.MethodGet, "/redfish/v1/UpdateService/FirmwareInventory", nil, &col); err != nil {
		return nil, err
	}
	target := ""
	for _, m := range col.Members {
		var fw struct {
			ID string `json:"Id"`
		}
		if c.call(ctx, http.MethodGet, m.ID, nil, &fw) == nil && fw.ID == component {
			target = m.ID
		}
	}
	if target == "" {
		return nil, fail("invalid-args", "the BMC has no firmware component %q", component)
	}
	protocol := "HTTPS"
	if strings.HasPrefix(imageURL, "http://") {
		protocol = "HTTP"
	}
	body := map[string]any{"ImageURI": imageURL, "Targets": []string{target}, "TransferProtocol": protocol}
	if err := c.call(ctx, http.MethodPost, "/redfish/v1/UpdateService/Actions/UpdateService.SimpleUpdate", body, nil); err != nil {
		return nil, err
	}
	return map[string]any{"started": true, "component": component}, nil
}
