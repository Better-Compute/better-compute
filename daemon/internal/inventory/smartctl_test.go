package inventory

import "testing"

func TestParseSmartctl(t *testing.T) {
	ata := `{"smartctl":{"exit_status":0},"device":{"name":"/dev/sda","type":"sat","protocol":"ATA"},
"smart_status":{"passed":true},
"ata_smart_attributes":{"revision":16,"table":[
 {"id":5,"name":"Reallocated_Sector_Ct","value":100,"worst":100,"thresh":10,"raw":{"value":8,"string":"8"}},
 {"id":177,"name":"Wear_Leveling_Count","value":93,"worst":93,"thresh":0,"raw":{"value":120,"string":"120"}},
 {"id":197,"name":"Current_Pending_Sector","value":100,"worst":100,"thresh":0,"raw":{"value":2,"string":"2"}},
 {"id":198,"name":"Offline_Uncorrectable","value":100,"worst":100,"thresh":0,"raw":{"value":1,"string":"1"}}]}}`
	s := parseSmartctl([]byte(ata))
	if s == nil || !s.Healthy || s.WearPercent == nil || *s.WearPercent != 7 || s.MediaErrors == nil || *s.MediaErrors != 3 {
		t.Fatalf("ata = %+v", s)
	}

	// The device statistics' Percentage Used wins over a vendor attribute; exit bit 3 is failing.
	devstat := `{"smartctl":{"exit_status":8},"smart_status":{"passed":true},"endurance_used":{"current_percent":41},
"ata_smart_attributes":{"table":[{"id":233,"value":80,"raw":{"value":0}}]}}`
	if s := parseSmartctl([]byte(devstat)); s == nil || s.Healthy || *s.WearPercent != 41 || s.MediaErrors != nil {
		t.Fatalf("devstat = %+v", s)
	}
	// A hard disk without wear attributes has none.
	if s := parseSmartctl([]byte(`{"smart_status":{"passed":false},"ata_smart_attributes":{"table":[{"id":197,"value":100,"raw":{"value":0}}]}}`)); s == nil || s.Healthy || s.WearPercent != nil {
		t.Fatalf("failed hdd = %+v", s)
	}

	sas := `{"smartctl":{"exit_status":0},"device":{"protocol":"SCSI"},"smart_status":{"passed":true},
"scsi_percentage_used_endurance_indicator":2,"scsi_grown_defect_list":0,
"scsi_error_counter_log":{"read":{"total_uncorrected_errors":1},"write":{"total_uncorrected_errors":0},"verify":{"total_uncorrected_errors":2}}}`
	if s := parseSmartctl([]byte(sas)); s == nil || !s.Healthy || *s.WearPercent != 2 || *s.MediaErrors != 3 {
		t.Fatalf("sas = %+v", s)
	}

	// No verdict (SMART unsupported, a device that would not open), or not JSON: nothing.
	for _, out := range []string{`{"smartctl":{"exit_status":2}}`, `not json`, ``} {
		if parseSmartctl([]byte(out)) != nil {
			t.Fatalf("%q gave a verdict", out)
		}
	}
	for _, bad := range []string{"../sda", "sda1", "nvme0n1", "/dev/sda", "sdabcd", ""} {
		if SmartctlHealth(bad) != nil {
			t.Fatalf("SmartctlHealth(%q) ran", bad)
		}
	}
}
