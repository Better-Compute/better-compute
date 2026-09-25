package bootparams

import (
	"strings"
	"testing"
)

func TestRenderParseRoundTrip(t *testing.T) {
	p := Params{
		Gateway: "https://gw.example.com", ServerName: "gw.internal", Site: "site_1",
		ServingCAPin: "sha256/AAA+/=", JoinSigningPin: "sha256/BBB=", JoinEncryptionPin: "sha256/CCC=",
		JWK: []byte(`{"kty":"EC","crv":"P-256","x":"x","y":"y"}`), Token: "bcjt_disc_01k5w0000000000000000000000.secret",
		Assertion: []byte{0, 1, 2, 250},
	}
	cmdline := "BOOT_IMAGE=/vmlinuz console=ttyS0 " + strings.Join(Render(p), " ") + " quiet"
	got, err := Parse(cmdline)
	if err != nil {
		t.Fatal(err)
	}
	if got.Gateway != p.Gateway || got.ServerName != p.ServerName || got.Site != p.Site || got.ServingCAPin != p.ServingCAPin ||
		got.JoinEncryptionPin != p.JoinEncryptionPin || string(got.JWK) != string(p.JWK) || got.Token != p.Token || string(got.Assertion) != string(p.Assertion) {
		t.Fatalf("round trip = %+v", got)
	}
	if _, err := Parse("console=ttyS0 bc.gateway=https://gw bc.site=s"); err == nil {
		t.Fatal("parsed a command line without pins, key, token or assertion")
	}
	if _, err := Parse(strings.Replace(cmdline, "bc.pins=", "bc.pins=only-one,", 1)); err == nil {
		t.Fatal("four pins accepted")
	}
}
