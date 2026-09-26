package config

import "testing"

func TestInstancesBalloonFloor(t *testing.T) {
	cfg, err := Parse([]byte(required()))
	if err != nil || cfg.BalloonFloorPercent != 50 {
		t.Fatalf("default floor = %d (%v)", cfg.BalloonFloorPercent, err)
	}
	cfg, err = Parse([]byte(required() + "[instances]\nballoon_floor_percent = 80\n"))
	if err != nil || cfg.BalloonFloorPercent != 80 {
		t.Fatalf("floor = %d (%v)", cfg.BalloonFloorPercent, err)
	}
	for _, bad := range []string{"5", "101", "-1"} {
		if _, err := Parse([]byte(required() + "[instances]\nballoon_floor_percent = " + bad + "\n")); err == nil {
			t.Fatalf("balloon_floor_percent = %s was accepted", bad)
		}
	}
}
