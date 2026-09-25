package pki

import (
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Exec tickets (PLAN.md §7.6, §13): 60 s single-use ES256 JWTs for one node, issued after the API
// authorized a tunnel. The daemon re-verifies each one against the JWKS its NodeSpec pins
// (access.exec_ticket_jwks_json) and its own jti set, so neither a replayed ticket nor a compromised
// gateway opens a tunnel. Mirrors @better-compute/pki tickets.ts verifyExecTicket.

// ExecTicketType is the JWT typ of an exec ticket.
const ExecTicketType = "bc-exec+jwt"

// MaxExecTicketLifetime bounds exp - iat.
const MaxExecTicketLifetime = 60 * time.Second

// ExecTicketLeeway is the clock tolerance for iat and exp.
const ExecTicketLeeway = 5 * time.Second

// Tunnel ops.
var tunnelOps = map[string]bool{"exec": true, "console": true, "ssh": true, "tcp": true}

// ErrTicketRejected wraps every reason an exec ticket is refused.
var ErrTicketRejected = errors.New("pki: exec ticket rejected")

func denyTicket(reason string) error { return fmt.Errorf("%w: %s", ErrTicketRejected, reason) }

// ExecTicketClaims are an exec ticket's claims.
type ExecTicketClaims struct {
	Iss  string `json:"iss"`
	Aud  string `json:"aud"`
	Sub  string `json:"sub"`
	Sid  string `json:"sid"`
	Op   string `json:"op"`
	Jti  string `json:"jti"`
	Iat  int64  `json:"iat"`
	Exp  int64  `json:"exp"`
	Tnt  string `json:"tnt,omitempty"`
	Inst string `json:"inst,omitempty"`
	Port int    `json:"port,omitempty"`
	Ses  string `json:"ses,omitempty"`
	Act  string `json:"act,omitempty"`
	Agt  string `json:"agt,omitempty"`
	Dlg  string `json:"dlg,omitempty"`
}

// VerifyExecTicketOptions configure VerifyExecTicket.
type VerifyExecTicketOptions struct {
	// JWKS is access.exec_ticket_jwks_json.
	JWKS   string
	NodeID string
	// Now is server time.
	Now time.Time
	// Remember records a jti until expiresAt and reports whether it was new (the journal's ticket
	// set); it is called only for a ticket that passed every other check.
	Remember func(jti string, expiresAt time.Time) (bool, error)
}

type jwks struct {
	Keys []struct {
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
		Kid string `json:"kid"`
	} `json:"keys"`
}

// VerifyExecTicket checks typ, ES256 under a JWKS key (by kid), aud = node:<id>, a lifetime of at
// most 60 s that has not expired (5 s leeway), a known op, a sid and a jti never seen before.
func VerifyExecTicket(token string, o VerifyExecTicketOptions) (ExecTicketClaims, error) {
	var claims ExecTicketClaims
	if len(token) > 8192 {
		return claims, denyTicket("malformed")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims, denyTicket("malformed")
	}
	dec := base64.RawURLEncoding
	head, err1 := dec.DecodeString(parts[0])
	body, err2 := dec.DecodeString(parts[1])
	sig, err3 := dec.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return claims, denyTicket("malformed")
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
		Kid string `json:"kid"`
	}
	if json.Unmarshal(head, &header) != nil || json.Unmarshal(body, &claims) != nil {
		return claims, denyTicket("malformed")
	}
	if header.Alg != "ES256" {
		return claims, denyTicket("algorithm must be ES256")
	}
	if header.Typ != ExecTicketType {
		return claims, denyTicket("not an exec ticket")
	}
	var set jwks
	if o.JWKS == "" || json.Unmarshal([]byte(o.JWKS), &set) != nil {
		return claims, denyTicket("no pinned JWKS")
	}
	var key *ecdsa.PublicKey
	for _, k := range set.Keys {
		if k.Kid == header.Kid && k.Kty == "EC" && k.Crv == "P-256" {
			if pub, err := (JWK{Kty: k.Kty, Crv: k.Crv, X: k.X, Y: k.Y}).PublicKey(); err == nil {
				key = pub
			}
			break
		}
	}
	if key == nil {
		return claims, denyTicket("unknown key")
	}
	if !VerifyP1363(key, []byte(parts[0]+"."+parts[1]), sig) {
		return claims, denyTicket("bad signature")
	}
	if claims.Aud != "node:"+o.NodeID {
		return claims, denyTicket("ticket for another node")
	}
	if claims.Exp <= claims.Iat || time.Duration(claims.Exp-claims.Iat)*time.Second > MaxExecTicketLifetime {
		return claims, denyTicket("lifetime too long")
	}
	if time.Unix(claims.Iat, 0).After(o.Now.Add(ExecTicketLeeway)) {
		return claims, denyTicket("issued in the future")
	}
	if !time.Unix(claims.Exp, 0).After(o.Now.Add(-ExecTicketLeeway)) {
		return claims, denyTicket("expired")
	}
	if !tunnelOps[claims.Op] {
		return claims, denyTicket("op not allowed")
	}
	if claims.Jti == "" || claims.Sid == "" {
		return claims, denyTicket("malformed")
	}
	if o.Remember == nil {
		return claims, denyTicket("no jti set")
	}
	fresh, err := o.Remember(claims.Jti, time.Unix(claims.Exp, 0).Add(ExecTicketLeeway))
	if err != nil || !fresh {
		return claims, denyTicket("replayed")
	}
	return claims, nil
}
