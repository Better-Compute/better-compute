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
// sets host), its worker signature, and where the command-signing roots it chains to come from:
// Roots, each of which must match a pin in root's config.toml (command_root_sha256), or, without
// those pins, TrustBundle, the SignedTrustBundle the JoinService key signed (checked against root's
// join_signing_key_pin, so a root rotation needs no new pin). The helper trusts none of it until the
// roots check out, the signature verifies, the body names this node, and the unit's settings are
// exactly the body's: bcd node can ask for what the control plane signed, nothing else.
type HostIntent struct {
	Body        []byte   `json:"body"`
	Signature   []byte   `json:"signature"`
	Roots       [][]byte `json:"roots,omitempty"`
	TrustBundle []byte   `json:"trustBundle,omitempty"`
}

// IntentRecord is where the helper keeps, as root, what it last accepted: the node it serves (root's
// JoinRecord names it; without one, the first signed spec), the newest host-section body (which also stands verified after its
// worker certificate expires: a spec unchanged for days keeps its first signature), and the newest
// trust bundle (an older one is a rollback) and whether its roots made signed intent mandatory.
const IntentRecord = hostconfig.StateDir + "/helper-intent.json"

type intentRecord struct {
	NodeID       string `json:"nodeId"`
	Generation   uint64 `json:"generation"`
	BodySHA256   string `json:"bodySha256"`
	TrustVersion uint64 `json:"trustVersion,omitempty"`
	// Signed is set once a trust bundle with command-signing roots was accepted: from then on a
	// host.unit without a signed spec is refused, whatever the node says.
	Signed bool `json:"signed,omitempty"`
}

// JoinRecord is where bcd join, run as root on a node under the helper, keeps the signed
// JoinResponse that issued the node's identity (WriteJoinRecord). The helper takes the node's id from
// it, checked against root's join_signing_key_pin, instead of trusting the first signed spec it sees.
const JoinRecord = hostconfig.StateDir + "/join-response.pb"

// WriteJoinRecord keeps a verified JoinResponse as root's join record.
func WriteJoinRecord(sys hostconfig.System, resp *agentv1.JoinResponse) error {
	raw, err := proto.Marshal(resp)
	if err != nil {
		return err
	}
	return sys.WriteFile(JoinRecord, raw, 0o600)
}

// Joined is what root's join record says, verified: the node it issued, and the trust bundle the
// JoinService key signed into the response (its command-signing roots make signed intent mandatory).
type Joined struct {
	NodeID string
	Trust  *commonv1.TrustBundle
}

// CommandRoots are the command-signing roots the join record carries (none: the record does not
// decide signed intent).
func (j *Joined) CommandRoots() [][]byte {
	if j == nil {
		return nil
	}
	return j.Trust.GetCommandSigningRoots()
}

// joined reads root's join record for host.unit: nil without one (a node joined before the record
// existed: the first signed spec names it). A record that does not verify refuses: it is root's, so
// something is wrong.
func (s *Server) joined() (*Joined, error) {
	j, err := ReadJoinRecord(s.HostSystem, s.JoinSigningPin)
	if err != nil {
		return nil, fmt.Errorf("host.unit: %w", err)
	}
	return j, nil
}

// ReadJoinRecord returns root's join record, checked against the join signing pin; nil and no
// error without a record.
func ReadJoinRecord(sys hostconfig.System, pin []byte) (*Joined, error) {
	raw, err := sys.ReadFile(JoinRecord)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", JoinRecord, err)
	}
	resp := &agentv1.JoinResponse{}
	body := &agentv1.JoinResponseBody{}
	if len(pin) == 0 || proto.Unmarshal(raw, resp) != nil ||
		!pki.VerifySignature(pki.PurposeJoinResponse, [][]byte{resp.GetBody()}, resp.GetSig(), pki.Trust{Pin: pin}) ||
		proto.Unmarshal(resp.GetBody(), body) != nil {
		return nil, fmt.Errorf("%s is not a JoinResponse signed by the pinned JoinService key", JoinRecord)
	}
	if body.GetNodeId() == "" || len(body.GetCertChain()) == 0 {
		return nil, fmt.Errorf("%s issued no identity", JoinRecord)
	}
	return &Joined{NodeID: body.GetNodeId(), Trust: body.GetTrust()}, nil
}

// maxIntent bounds the signed spec a request carries (roots, bundle and body).
const maxIntent = 1 << 20

// intentRoots decides which command-signing roots the request's spec must chain to: the install's
// pins alone when set; else root's join record's roots, which make signed intent mandatory whatever
// the node sends (review 2 MED: without them the node decided, by sending a trust bundle or not), and
// which a newer SignedTrustBundle the node presents may rotate, only forward. It returns none (and
// no error) only for an install without signed intent: no pins, no join record with roots, and no
// trust bundle with roots ever seen.
func (s *Server) intentRoots(in *HostIntent, rec *intentRecord, joined *Joined) ([][]byte, error) {
	if in != nil {
		size := len(in.Body) + len(in.Signature) + len(in.TrustBundle)
		for _, r := range in.Roots {
			size += len(r)
		}
		if size > maxIntent || len(in.Roots) > 16 {
			return nil, errors.New("host.unit: malformed signed spec")
		}
	}
	if len(s.CommandRootPins) > 0 {
		// The install's pins decide alone.
		if in == nil || len(in.Roots) == 0 {
			return nil, errors.New("host.unit needs the signed spec that asks for it (command_root_sha256 is set)")
		}
		for _, root := range in.Roots {
			sum := sha256.Sum256(root)
			if !pinned(s.CommandRootPins, sum[:]) {
				return nil, errors.New("host.unit: a command-signing root is not pinned in command_root_sha256")
			}
		}
		return in.Roots, nil
	}
	// Root's join record: the trust the JoinService key signed at the join, root's own copy. Its roots
	// stand until a newer bundle rotated them (then the node must present that bundle, or older roots
	// would come back).
	var recorded [][]byte
	var recordedVersion uint64
	if roots := joined.CommandRoots(); len(roots) > 0 {
		recorded, recordedVersion, rec.Signed = roots, joined.Trust.GetVersion(), true
	}
	if in == nil || len(in.TrustBundle) == 0 || len(s.JoinSigningPin) == 0 {
		if recorded != nil && recordedVersion >= rec.TrustVersion {
			rec.TrustVersion = recordedVersion
			return recorded, nil
		}
		if rec.Signed {
			return nil, fmt.Errorf("host.unit needs the signed spec that asks for it and the current trust bundle (version %d; this node's specs are signed)", rec.TrustVersion)
		}
		return nil, nil
	}
	if recordedVersion > rec.TrustVersion {
		rec.TrustVersion = recordedVersion
	}
	signed := &commonv1.SignedTrustBundle{}
	if proto.Unmarshal(in.TrustBundle, signed) != nil ||
		!pki.VerifySignature(pki.PurposeTrustBundle, [][]byte{signed.GetBody()}, signed.GetSignature(), pki.Trust{Pin: s.JoinSigningPin}) {
		return nil, errors.New("host.unit: the trust bundle is not signed by the pinned JoinService key")
	}
	bundle := &commonv1.TrustBundle{}
	if proto.Unmarshal(signed.GetBody(), bundle) != nil {
		return nil, errors.New("host.unit: unreadable trust bundle")
	}
	if bundle.GetVersion() < rec.TrustVersion {
		return nil, fmt.Errorf("host.unit: trust bundle version %d is older than %d, already accepted", bundle.GetVersion(), rec.TrustVersion)
	}
	roots := bundle.GetCommandSigningRoots()
	if len(roots) == 0 {
		if rec.Signed {
			return nil, errors.New("host.unit: a trust bundle without command-signing roots, after one with them")
		}
		return nil, nil
	}
	rec.TrustVersion, rec.Signed = bundle.GetVersion(), true
	return roots, nil
}

// checkIntent decides whether the signed spec allows this host.unit request.
func (s *Server) checkIntent(req Request) error {
	in := req.Intent
	rec, err := s.readIntentRecord()
	if err != nil {
		return err
	}
	before := rec
	joined, err := s.joined()
	if err != nil {
		return err
	}
	roots, err := s.intentRoots(in, &rec, joined)
	if err != nil {
		return err
	}
	if roots == nil {
		return nil // an install without signed intent
	}
	if in == nil || len(in.Body) == 0 {
		return errors.New("host.unit needs the signed spec that asks for it (this node's specs are signed)")
	}
	if joined != nil && rec.NodeID != joined.NodeID {
		// Root joined this machine (again): the node is the record's, and generations another
		// identity applied do not carry over.
		rec.NodeID, rec.Generation, rec.BodySHA256 = joined.NodeID, 0, ""
	}
	body := &agentv1.DesiredStateBody{}
	sig := &commonv1.Signature{}
	if proto.Unmarshal(in.Body, body) != nil || proto.Unmarshal(in.Signature, sig) != nil {
		return errors.New("host.unit: unreadable signed spec")
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
		if err := pki.VerifyIntent(pki.PurposeDesiredState, in.Body, sig, roots, now()); err != nil {
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
	rec.NodeID, rec.Generation, rec.BodySHA256 = body.GetNodeId(), body.GetGeneration(), hex.EncodeToString(digest[:])
	if rec != before {
		if err := s.writeIntentRecord(rec); err != nil {
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
