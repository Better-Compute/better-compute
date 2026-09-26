package helper

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// HostIntent is the signed spec a host.unit request rests on: the DesiredStateBody that last set
// the node's host section, exactly as the control plane signed it (a full spec, or a patch that
// sets host), its worker signature, and the command-signing roots the signature chains to. The
// helper trusts none of it until each root matches a pin in root's config.toml
// (command_root_sha256), the signature verifies, the body names this node, and the unit's settings
// are exactly the body's: bcd node can ask for what the control plane signed, nothing else.
type HostIntent struct {
	Body      []byte   `json:"body"`
	Signature []byte   `json:"signature"`
	Roots     [][]byte `json:"roots"`
}

// IntentRecord is where the helper keeps, as root, what it last accepted: the node it serves (the
// first signed spec names it) and the newest host-section body, which also stands verified after
// its worker certificate expires (a spec unchanged for days keeps its first signature).
const IntentRecord = hostconfig.StateDir + "/helper-intent.json"

type intentRecord struct {
	NodeID     string `json:"nodeId"`
	Generation uint64 `json:"generation"`
	BodySHA256 string `json:"bodySha256"`
}

// maxIntent bounds the signed spec a request carries (roots and body).
const maxIntent = 1 << 20

// checkIntent decides whether the signed spec allows this host.unit request. Without pins there is
// nothing to check against (an install without signed intent).
func (s *Server) checkIntent(req Request) error {
	if len(s.CommandRootPins) == 0 {
		return nil
	}
	in := req.Intent
	if in == nil {
		return errors.New("host.unit needs the signed spec that asks for it (command_root_sha256 is set)")
	}
	size := len(in.Body) + len(in.Signature)
	for _, r := range in.Roots {
		size += len(r)
	}
	if size > maxIntent || len(in.Roots) == 0 || len(in.Roots) > 16 {
		return errors.New("host.unit: malformed signed spec")
	}
	for _, root := range in.Roots {
		sum := sha256.Sum256(root)
		if !pinned(s.CommandRootPins, sum[:]) {
			return errors.New("host.unit: a command-signing root is not pinned in command_root_sha256")
		}
	}
	body := &agentv1.DesiredStateBody{}
	sig := &commonv1.Signature{}
	if proto.Unmarshal(in.Body, body) != nil || proto.Unmarshal(in.Signature, sig) != nil {
		return errors.New("host.unit: unreadable signed spec")
	}
	rec, err := s.readIntentRecord()
	if err != nil {
		return err
	}
	if body.GetNodeId() == "" || (rec.NodeID != "" && body.GetNodeId() != rec.NodeID) {
		return fmt.Errorf("host.unit: the signed spec is for node %q, not this node", body.GetNodeId())
	}
	if body.GetGeneration() < rec.Generation {
		return fmt.Errorf("host.unit: the signed spec (generation %d) is older than one already applied (%d)", body.GetGeneration(), rec.Generation)
	}
	digest := sha256.Sum256(in.Body)
	known := hex.EncodeToString(digest[:]) == rec.BodySHA256
	if !known {
		now := time.Now
		if s.Now != nil {
			now = s.Now
		}
		if err := pki.VerifyIntent(pki.PurposeDesiredState, in.Body, sig, in.Roots, now()); err != nil {
			return fmt.Errorf("host.unit: %w", err)
		}
	}
	var host *agentv1.HostSection
	switch spec := body.GetSpec().(type) {
	case *agentv1.DesiredStateBody_Full:
		host = spec.Full.GetHost()
	case *agentv1.DesiredStateBody_Patch:
		if spec.Patch.Host == nil {
			return errors.New("host.unit: the signed patch does not set the host section")
		}
		host = spec.Patch.GetHost()
	default:
		return errors.New("host.unit: the signed body holds no spec")
	}
	var signed []byte
	found := false
	for _, u := range host.GetUnits() {
		if u.GetUnit() == req.Unit {
			signed, found = []byte(u.GetConfigJson()), true
		}
	}
	switch {
	case req.Settings == nil && found:
		return fmt.Errorf("host.unit: the signed spec still asks for %s", req.Unit)
	case req.Settings != nil && !found:
		return fmt.Errorf("host.unit: the signed spec does not ask for %s", req.Unit)
	case req.Settings != nil && !bytes.Equal(bytes.TrimSpace(req.Settings), bytes.TrimSpace(signed)):
		return fmt.Errorf("host.unit: the settings of %s are not the signed spec's", req.Unit)
	}
	if !known || rec.NodeID == "" {
		next := intentRecord{NodeID: body.GetNodeId(), Generation: body.GetGeneration(), BodySHA256: hex.EncodeToString(digest[:])}
		if err := s.writeIntentRecord(next); err != nil {
			return fmt.Errorf("host.unit: record the signed spec: %w", err)
		}
	}
	return nil
}

func pinned(pins [][]byte, sum []byte) bool {
	for _, p := range pins {
		if bytes.Equal(p, sum) {
			return true
		}
	}
	return false
}

func (s *Server) readIntentRecord() (intentRecord, error) {
	var rec intentRecord
	raw, err := s.HostSystem.ReadFile(IntentRecord)
	if errors.Is(err, fs.ErrNotExist) {
		return rec, nil
	}
	if err != nil {
		return rec, err
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		return rec, fmt.Errorf("host.unit: %s is unreadable: %w", IntentRecord, err)
	}
	return rec, nil
}

func (s *Server) writeIntentRecord(rec intentRecord) error {
	raw, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return s.HostSystem.WriteFile(IntentRecord, append(raw, '\n'), 0o644)
}
