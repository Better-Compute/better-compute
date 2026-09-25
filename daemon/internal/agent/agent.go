// Package agent is bcd's node agent (PLAN.md §6, §7): the Session stream to the gateway, the journal
// behind it, the dispatcher that admits and runs commands, the converger that applies desired state,
// inventory, events and certificate renewal. One Agent runs per daemon process.
//
// Concurrency: frames are read by one goroutine per session and handled in order; everything that
// sends (handlers, the converger, heartbeats) pushes into the session's bounded outbox, which one
// writer goroutine drains. State shared between them is guarded by Agent.mu; journal writes happen
// under it, so a command is durably accepted before anything else can observe it. A full outbox drops
// the session rather than blocking: results and events are journaled and replayed after the redial.
package agent

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"github.com/better-compute/better-compute/daemon/internal/session"
)

// Stream is one Session stream (connect's BidiStreamForClient in production).
type Stream interface {
	Send(*agentv1.AgentFrame) error
	Receive() (*agentv1.ServerFrame, error)
	CloseRequest() error
	CloseResponse() error
}

// Dialer opens a Session stream; the stream ends when ctx is cancelled.
type Dialer func(ctx context.Context) (Stream, error)

// Renewer calls AgentGateway.Renew with the current certificate.
type Renewer interface {
	Renew(ctx context.Context, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error)
}

// ErrRevoked is returned by Run after a RevocationNotice: the certificate must not be used again.
var ErrRevoked = errors.New("agent: this node's certificate was revoked")

// Options configure an Agent.
type Options struct {
	State   *State
	Key     *ecdsa.PrivateKey
	DataDir string
	Journal journal.Journal
	Host    Host
	Dial    Dialer
	// Renewer renews the certificate at ~60% of its lifetime; nil disables renewal.
	Renewer Renewer
	// OnRenewed is called after a renewal is stored (the caller rebuilds its mTLS client).
	OnRenewed func(*State, *ecdsa.PrivateKey)
	// SignerPin is join_signing_key_pin: Welcome trust bundles must be signed by that key.
	SignerPin []byte
	Version   string
	Log       *slog.Logger
	// Backoff is the redial schedule (default 1 s → 60 s).
	Backoff session.Backoff
	// Lanes sizes credits and workers (default dispatch.DefaultLanes).
	Lanes map[dispatch.Lane]dispatch.LaneConfig
	// ConvergeRetry re-runs a converger pass that is still progressing (default 30 s).
	ConvergeRetry time.Duration
	// WelcomeTimeout drops a session that sends no Welcome (default 30 s).
	WelcomeTimeout time.Duration
	// Kinds replaces the built-in command kinds (tests).
	Kinds []*Kind
	// HTTPClient uploads logs.collect bundles (default: a client with a 5 minute timeout).
	HTTPClient *http.Client
	// ImageCache is the site image cache's base URL a ramdisk tries before an image's source.
	ImageCache string
	// CacheMaxBytes is the site image cache's byte budget (0 = unbounded).
	CacheMaxBytes uint64
	// Drivers are the drivers the agent's bcx plugins serve (driver.invoke; advertised in Hello).
	Drivers []HostedDriver
	// Runtimes are the instance runtimes this host runs (VPS hosts; none elsewhere).
	Runtimes []runtime.Runtime
	// DialTunnel opens Tunnel streams; nil refuses every OpenTunnel.
	DialTunnel TunnelDialer
	// TunnelProgram runs a tunnel's program (default DefaultTunnelProgram).
	TunnelProgram TunnelProgramFactory
	// HealthInterval is how often host pressure is sampled and reported (default 30 s).
	HealthInterval time.Duration
}

// Agent is the node agent.
type Agent struct {
	o           Options
	log         *slog.Logger
	j           journal.Journal
	host        Host
	incarnation string
	bootID      string
	journalID   string
	kinds       map[string]*Kind
	reg         *dispatch.Registry
	lanes       *dispatch.Lanes
	laneConfig  map[dispatch.Lane]dispatch.LaneConfig
	devices     *devicesConverger
	boot        *BootEntries
	instances   *instancesConverger
	cache       *imageCache
	access      *accessConverger
	convergeCh  chan struct{}
	rng         *rand.Rand
	ctx         context.Context
	// key is the node key (read without mu: attested results are signed under it).
	key atomic.Pointer[ecdsa.PrivateKey]

	mu     sync.Mutex
	state  *State
	sess   *sess
	offset time.Duration
	// clockSet: a Welcome set offset in this process (its server clock is then a floor too).
	clockSet bool
	// trustPending: a newer trust bundle was applied and no status has carried it yet.
	trustPending bool
	// lease is the site:<id>:boot lease (site agents); lastContact the last frame from the gateway.
	lease       bootLease
	lastContact time.Time
	tokens      tokenCache
	execs       map[string]*execution
	deferred    map[string]*deferred
	overflow    []journal.Event
	spec        *agentv1.NodeSpec
	applied     uint64
	observed    uint64
	lastStatus  *agentv1.StatusReport
	revoked     bool
	// execJWKS is the applied access section's exec-ticket JWKS (tunnels).
	execJWKS string
	tunnels  int
	secrets  map[string]*pendingSecret
	// faults are this boot's active device conditions (XIDs); pressure the last PSI sample.
	faults []*agentv1.Condition
	// rootDisk is the disk deploy.image wrote (boot.kexec boots it).
	rootDisk      *inventory.Disk
	pressure      *agentv1.HostPressure
	workloads     map[string]*pendingWorkload
	upgradeNeeded bool

	invMu       sync.Mutex
	inv         *inventory.NodeInventory
	collected   []inventory.Section
	collectedAt time.Time
}

// New builds an agent over an opened journal and a joined identity.
func New(o Options) (*Agent, error) {
	if o.State == nil || o.Key == nil || o.Journal == nil || o.Host == nil || o.Dial == nil {
		return nil, errors.New("agent: state, key, journal, host and dial are required")
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Backoff.Max == 0 {
		o.Backoff = session.DefaultBackoff
	}
	if o.Lanes == nil {
		o.Lanes = dispatch.DefaultLanes()
	}
	if o.ConvergeRetry == 0 {
		o.ConvergeRetry = 30 * time.Second
	}
	if o.HealthInterval == 0 {
		o.HealthInterval = 30 * time.Second
	}
	if o.WelcomeTimeout == 0 {
		o.WelcomeTimeout = 30 * time.Second
	}
	bootID, err := o.Host.BootID()
	if err != nil {
		return nil, fmt.Errorf("agent: boot id: %w", err)
	}
	meta, err := o.Journal.Meta()
	if err != nil {
		return nil, err
	}
	if meta.NodeID != "" && meta.NodeID != o.State.NodeID {
		return nil, fmt.Errorf("agent: the journal belongs to node %s, not %s", meta.NodeID, o.State.NodeID)
	}
	if meta.NodeID == "" || meta.ServerTime.Before(o.State.ServerTime) {
		// A new (or lost) journal: it belongs to this node, and the server time never goes back.
		meta.NodeID = o.State.NodeID
		meta.ServerTime = o.State.ServerTime
		if err := o.Journal.SaveMeta(meta); err != nil {
			return nil, err
		}
	}
	lanes, err := dispatch.NewLanes(o.Lanes)
	if err != nil {
		return nil, err
	}
	a := &Agent{
		o:           o,
		log:         o.Log,
		j:           o.Journal,
		host:        o.Host,
		incarnation: journal.NewID("inc"),
		bootID:      bootID,
		journalID:   meta.JournalID,
		lanes:       lanes,
		laneConfig:  o.Lanes,
		convergeCh:  make(chan struct{}, 1),
		rng:         rand.New(rand.NewSource(time.Now().UnixNano())),
		state:       o.State,
		execs:       map[string]*execution{},
		deferred:    map[string]*deferred{},
		applied:     meta.AppliedGeneration,
	}
	kinds := o.Kinds
	if kinds == nil {
		kinds = builtinKinds(a)
	}
	a.kinds = make(map[string]*Kind, len(kinds))
	var reg []dispatch.Kind
	for _, k := range kinds {
		a.kinds[k.Name] = k
		reg = append(reg, dispatch.Kind{Name: k.Name, Lane: k.Lane, Roles: k.Roles, Destructive: k.Destructive, Handler: k})
	}
	if a.reg, err = dispatch.NewRegistry(reg...); err != nil {
		return nil, err
	}
	a.devices = &devicesConverger{a: a}
	a.instances = &instancesConverger{a: a}
	a.boot = newBootEntries(o.DataDir)
	a.cache = newImageCache(filepath.Join(o.DataDir, "cache"))
	a.cache.changed = a.refreshSections
	a.cache.maxBytes = o.CacheMaxBytes
	a.loadFaults()
	a.access = &accessConverger{a: a}
	a.key.Store(o.Key)
	return a, nil
}

// NodeID returns the node's id.
func (a *Agent) NodeID() string { return a.o.State.NodeID }

// runtime is the journal's view of this process.
func (a *Agent) runtime() journal.Runtime {
	return journal.Runtime{
		BootID:          a.bootID,
		Incarnation:     a.incarnation,
		Now:             time.Now(),
		RebootedPayload: a.rebootedPayload,
	}
}

// serverNow is the local clock corrected by the Welcome offset (dispatch.Env.Now).
func (a *Agent) serverNow() time.Time {
	a.mu.Lock()
	defer a.mu.Unlock()
	return time.Now().Add(a.offset)
}

func (a *Agent) serverNowLocked() time.Time { return time.Now().Add(a.offset) }

func (a *Agent) role() dispatch.Role { return dispatch.Role(a.o.State.Role) }

func wireRole(role string) commonv1.AgentRole {
	switch role {
	case "node":
		return commonv1.AgentRole_AGENT_ROLE_NODE
	case "site":
		return commonv1.AgentRole_AGENT_ROLE_SITE
	case "ramdisk":
		return commonv1.AgentRole_AGENT_ROLE_RAMDISK
	}
	return commonv1.AgentRole_AGENT_ROLE_UNSPECIFIED
}

// Run starts the agent: it recovers the journal, converges the stored spec and keeps a session to
// the gateway until ctx is done (nil) or the certificate is revoked (ErrRevoked).
func (a *Agent) Run(ctx context.Context) error {
	a.ctx = ctx
	a.mu.Lock()
	recovered, err := journal.Recover(a.j, a.runtime())
	a.mu.Unlock()
	if err != nil {
		return fmt.Errorf("agent: recover the journal: %w", err)
	}
	for _, c := range recovered {
		a.log.Info("command recovered", "id", c.ID, "kind", c.Kind, "outcome", string(c.Result.Outcome),
			"reason", c.Result.Reason, "rebooted", c.Result.Rebooted)
	}
	if n, err := journal.Sweep(a.j, time.Now(), journal.CommandTTL, a.incarnation); err != nil {
		a.log.Warn("journal sweep failed", "error", err.Error())
	} else if n > 0 {
		a.log.Info("journal swept", "removed", n)
	}
	if _, err := a.collect(true); err != nil {
		a.log.Warn("inventory collection failed", "error", err.Error())
	}
	if err := a.loadSpec(); err != nil {
		a.log.Warn("the stored spec is unusable; asking for a full one", "error", err.Error())
	}
	go a.convergeLoop(ctx)
	go a.sweepLoop(ctx)
	go a.healthLoop(ctx)
	go a.watchXids(ctx)
	if a.o.Renewer != nil {
		go a.renewLoop(ctx)
	}
	a.triggerConverge()

	attempt := 0
	for {
		welcomed, after, err := a.runSession(ctx)
		if ctx.Err() != nil {
			return nil
		}
		a.mu.Lock()
		revoked := a.revoked
		a.mu.Unlock()
		if revoked {
			return ErrRevoked
		}
		if welcomed {
			attempt = 0
		}
		delay := a.o.Backoff.Delay(attempt, a.rng)
		attempt++
		if after != nil {
			delay = *after
		}
		reason := "closed"
		if err != nil {
			reason = err.Error()
		}
		a.log.Info("session ended; redialing", "reason", reason, "in", delay.String())
		if err := sleepCtx(ctx, delay); err != nil {
			return nil
		}
	}
}

func (a *Agent) sweepLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.mu.Lock()
			_, err := journal.Sweep(a.j, time.Now(), journal.CommandTTL, a.incarnation)
			now := a.serverNowLocked()
			a.mu.Unlock()
			a.boot.Sweep(now)
			a.tokens.mu.Lock()
			a.tokens.tokens = nil
			a.tokens.mu.Unlock()
			if err != nil {
				a.log.Warn("journal sweep failed", "error", err.Error())
			}
		}
	}
}
