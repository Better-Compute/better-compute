// Package bootparams is the kernel command line contract between `bcd site`, which renders a PXE
// machine's iPXE script, and `bcd ramdisk`, which boots from it (PLAN.md §3.5). The ramdisk has no
// config.toml: everything it needs to join rides the command line.
//
//	bc.gateway=https://gw.example.com   the gateway the ramdisk dials
//	bc.server_name=gw.example.com       optional: the name its certificate carries
//	bc.site=<site id>
//	bc.pins=<serving CA>,<join signing>,<join encryption>   sha256/<base64> SPKI pins
//	bc.jwk=<base64url of the JoinService encryption key's public JWK>
//	bc.token=bcjt_…                     the single-use, MAC-bound discovery join token (15 min)
//	bc.assertion=<base64url of a SignedDiscoveryAssertion>  the site agent vouching for this boot
//
// The token is readable in /proc/cmdline by anything on the ramdisk, which runs nothing but bcd; it
// is single-use and bound to the machine's MAC, and support bundles redact it.
package bootparams

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Params are the ramdisk's boot parameters.
type Params struct {
	Gateway    string
	ServerName string
	Site       string
	// ServingCAPin, JoinSigningPin and JoinEncryptionPin are "sha256/<base64>" pins.
	ServingCAPin      string
	JoinSigningPin    string
	JoinEncryptionPin string
	// JWK is the JoinService encryption key's public JWK (JSON).
	JWK       []byte
	Token     string
	Assertion []byte
}

var b64 = base64.RawURLEncoding

// Render returns the kernel arguments for p, in a fixed order.
func Render(p Params) []string {
	args := []string{"bc.gateway=" + p.Gateway}
	if p.ServerName != "" {
		args = append(args, "bc.server_name="+p.ServerName)
	}
	return append(args,
		"bc.site="+p.Site,
		"bc.pins="+p.ServingCAPin+","+p.JoinSigningPin+","+p.JoinEncryptionPin,
		"bc.jwk="+b64.EncodeToString(p.JWK),
		"bc.token="+p.Token,
		"bc.assertion="+b64.EncodeToString(p.Assertion),
	)
}

// Parse reads the bc.* arguments of a kernel command line; other arguments are ignored.
func Parse(cmdline string) (Params, error) {
	var p Params
	for _, arg := range strings.Fields(cmdline) {
		key, value, ok := strings.Cut(arg, "=")
		if !ok || !strings.HasPrefix(key, "bc.") {
			continue
		}
		var err error
		switch key {
		case "bc.gateway":
			p.Gateway = value
		case "bc.server_name":
			p.ServerName = value
		case "bc.site":
			p.Site = value
		case "bc.pins":
			pins := strings.Split(value, ",")
			if len(pins) != 3 {
				return p, errors.New("bootparams: bc.pins needs three pins")
			}
			p.ServingCAPin, p.JoinSigningPin, p.JoinEncryptionPin = pins[0], pins[1], pins[2]
		case "bc.jwk":
			p.JWK, err = b64.DecodeString(value)
		case "bc.token":
			p.Token = value
		case "bc.assertion":
			p.Assertion, err = b64.DecodeString(value)
		}
		if err != nil {
			return p, fmt.Errorf("bootparams: %s: %w", key, err)
		}
	}
	u, err := url.Parse(p.Gateway)
	switch {
	case err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http"):
		return p, errors.New("bootparams: bc.gateway must be the gateway URL")
	case p.Site == "":
		return p, errors.New("bootparams: bc.site is missing")
	case p.ServingCAPin == "" || p.JoinSigningPin == "" || p.JoinEncryptionPin == "":
		return p, errors.New("bootparams: bc.pins is missing")
	case len(p.JWK) == 0:
		return p, errors.New("bootparams: bc.jwk is missing")
	case p.Token == "":
		return p, errors.New("bootparams: bc.token is missing")
	case len(p.Assertion) == 0:
		return p, errors.New("bootparams: bc.assertion is missing")
	}
	return p, nil
}
