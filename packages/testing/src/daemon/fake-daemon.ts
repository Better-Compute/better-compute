import { createHash, type KeyObject } from 'node:crypto';
import { create, equals, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import { ComputeError, isComputeError } from '@better-compute/core';
import {
  createSecretRequest,
  createWorkloadTokenRequest,
  openSecretResponse,
  openWorkloadTokenResponse,
  signAttestedReport,
  signCommandUpdate,
  approverSetDigest,
  approverSetOf,
  approverSetTransition,
  batchSubject,
  verifyBatchCommand,
  verifyBatchProof,
  verifyCommand,
  verifyDesiredState,
  verifyTrustBundle,
  type ApproverKey,
  type ReplayCache,
  type SignerTrust,
} from '@better-compute/pki';
import {
  AccessSectionSchema,
  AgentFrameSchema,
  AgentRole,
  AttestedReportBodySchema,
  Binding,
  batchLeafInput,
  CommandErrorSchema,
  CommandRejectReason,
  CommandState,
  CommandUpdateSchema,
  ConditionStatus,
  DaemonSectionSchema,
  DesiredStateBodySchema,
  DevicesSectionSchema,
  EventSchema,
  HeartbeatSchema,
  HostSectionSchema,
  InstancesSectionSchema,
  Lane,
  NodeRebootResultSchema,
  NodeSpecSchema,
  PROTOCOL_VERSION,
  SectionState,
  SignatureSchema,
  SpecRequestReason,
  TelemetrySectionSchema,
  commandKinds,
  encodeCommandResult,
  isCommandKind,
  site,
  unwrapCommand,
  unwrapDesiredState,
  wrapAttestedReport,
  type AgentFrame,
  type AttestedReport,
  type Cancel,
  type Command,
  type CommandBody,
  type CommandUpdate,
  ConditionSchema,
  type Condition,
  type DesiredState,
  type DevicesSection,
  type DiscoveredMachineSchema,
  type DriverManifestSchema,
  type Event,
  type HelloSchema,
  type HostPressureSchema,
  type NodeSpec,
  type ProtocolRange,
  type SectionStatusSchema,
  type ServerFrame,
  type StatusReportSchema,
  type Welcome,
} from '@better-compute/protocol';
import type { EventLog, LogValue } from '../event-log.js';
import { encodeInventorySections, fakeHardware, type EncodedSection, type FakeHardware } from '../fake-hw.js';
import type { AgentConn, CloseInfo } from '../frame-conn.js';
import { createRng, type Rng } from '../rng.js';
import type { Scheduler, Timer } from '../scheduler.js';
import type { DaemonFact, FactSink } from './facts.js';
import { FakeHypervisor, type FakeHypervisorOptions, type UserDataFetch } from './instances.js';
import { FakeImds } from './imds.js';
import {
  newTunnelJtiCache,
  startTunnel,
  type FakeTunnelOptions,
  type TunnelOutcome,
} from './tunnels.js';
import {
  COMMAND_TTL_MS,
  JournalError,
  MemoryJournal,
  accept,
  ackResult,
  complete,
  markRunning,
  recordRejection,
  recover,
  resolve,
  sweep,
  type Delivery,
  type EventClass,
  type JournalCommand,
  type JournalResult,
  type RuleHooks,
  type Runtime,
} from './journal.js';
import {
  DEFAULT_CREDITS,
  DEFAULT_WORKERS,
  defaultFakeKinds,
  fakeInstanceSnapshot,
  type FakeDaemonKnobs,
  type FakeKind,
  type FakeKindContext,
  type FakeKindOutcome,
} from './kinds.js';
import type { DaemonProfile } from './profiles.js';

/** Lifecycle of a fake node's daemon process. */
export type FakeDaemonState = 'stopped' | 'running' | 'rebooting';

export interface FakeDaemonOptions {
  /** Must equal the node id in the certificate (the gateway checks Hello.node_id against it). */
  nodeId: string;
  scheduler: Scheduler;
  /** Seeds ids (boot, journal, incarnation) and reconnect jitter (default: seeded from nodeId). */
  rng?: Rng;
  role?: AgentRole;
  /** The node's hardware (default: `fakeHardware({ seed: nodeId })`, an HGX H100). */
  hardware?: FakeHardware;
  /** Opens a Session stream to the gateway; `undefined` means unreachable. Without it, call `connect()`. */
  dial?: () => AgentConn | undefined;
  daemonVersion?: string;
  capabilities?: readonly string[];
  drivers?: readonly MessageInitShape<typeof DriverManifestSchema>[];
  protocol?: ProtocolRange;
  /** The daemon's clock minus the server's (the Welcome offset corrects for it). */
  clockSkewMs?: number;
  /** Kinds this daemon runs, merged over the v0.1 defaults; `null` removes one. */
  kinds?: Record<string, FakeKind | null>;
  /** Worker pool per lane (default control 4, provision 2, bulk 1). */
  workers?: Partial<Record<Lane, number>>;
  /** Journal caps (default 64 MiB / 10k events). */
  journal?: { maxEvents?: number; maxBytes?: number };
  knobs?: Partial<FakeDaemonKnobs>;
  /** How long a reboot keeps the node down (default 60 s). */
  rebootDurationMs?: number;
  /** Reconnect backoff with full jitter (default 1 s → 60 s). */
  backoff?: { minMs: number; maxMs: number };
  /** HTTP/2 PING period and timeout (default 20 s each). */
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** A session without Welcome after this long is dropped (default 30 s). */
  welcomeTimeoutMs?: number;
  /** Retry period of a section that is still progressing (default 30 s). */
  convergeRetryMs?: number;
  /** Where uploads (logs.collect) land (default: `daemon.uploads`). */
  objectStore?: Map<string, Uint8Array>;
  facts?: FactSink;
  log?: EventLog;
  /**
   * The node key the daemon joined with. Results of kinds whose outcome asks for it (`attest`) carry
   * `node_sig` made with it, as bcd signs wipe and diagnostics results, and so do its attested
   * reports (AllocationBound/Released). Without a key they go unsigned.
   */
  nodeKey?: KeyObject;
  /**
   * Tunnels (v0.3, §7.6): how the daemon opens its `Tunnel` stream and what runs in it. Without it
   * an `OpenTunnel` is ignored (the gateway's open times out), as a daemon without tunnels would.
   */
  tunnels?: FakeTunnelOptions;
  /**
   * Signed intent (§6, §13; v0.2), as bcd enforces it: destructive kinds need a worker signature
   * chaining to a command-signing root, and any signature present is checked; a failure is
   * `BAD_SIGNATURE`. `roots` come from `JoinResponse.trust`; a newer `Welcome.trust` (verified with
   * `trustSigner`, the pinned join-signing key) replaces them. Without this option the daemon runs
   * v0.1-style and checks nothing (bcd from v0.2 always enforces).
   */
  intent?: {
    roots: readonly Uint8Array[];
    version?: bigint;
    trustSigner?: SignerTrust;
    /**
     * Desired state (signed NodeSpecs, §7.7). Default `'always'`: with command-signing roots every spec must be
     * signed, since an unsigned one could raise the applied generation and freeze all later specs. `'access'`
     * requires a signature only for specs that change the `access` section (a v0.2 control plane that signs
     * nothing else). A present signature is always checked. A refused spec is not applied (see
     * `specRejections`).
     */
    signedSpecs?: 'access' | 'always';
    /**
     * (v1.0, §13) The destructive-batch quorum as the join's trust bundle sets it (a newer Welcome.trust replaces
     * it): a destructive command with a batch_id runs only with a BatchApproval of enough distinct approver keys
     * whose scope proves it (else BATCH_UNAPPROVED); destructive commands without one run at most
     * `unbatchedPerHour` times per rolling hour (else UNBATCHED_LIMIT; default 0).
     */
    quorum?: FakeQuorumTrust;
    /** The deployment's trust domain (JoinResponseBody.trust_domain), for a quorum a Welcome bundle brings. */
    trustDomain?: string;
    /**
     * (review 7 M2) SHA-256 of the approver set this daemon must first take (config.toml approver_set_sha256, from
     * the install script): while it holds no approver keys it takes only a matching set, and refuses destructive
     * commands (BATCH_UNAPPROVED) until it has one, so a compromised api cannot hand a new node its own set.
     */
    approverSetSha256?: Uint8Array;
  };
  /**
   * A VPS host (v0.3): the `instances` section is converged on a fake hypervisor (options, or one
   * the test holds), user data is fetched with SecretRequests signed by `nodeKey`, and every
   * StatusReport lists the runtimes' whole inventory. Without it the section is UNSUPPORTED.
   */
  instances?: FakeHypervisorOptions | FakeHypervisor;
  /**
   * Self-update (§6, v0.4): the `daemon` section is converged by swapping to its version (A/B slots) and
   * restarting, so the next Hello reports it. A version in `badVersions` crashes on start and the daemon comes
   * back on its previous slot, reporting the section FAILED for that version from then on. The release signature
   * is not checked (bcd verifies it against its pins). Without this option the section is UNSUPPORTED.
   */
  selfUpdate?: { badVersions?: readonly string[]; swapMs?: number };
  /**
   * Version skew (§7.6): behave like an older bcd (`daemonSkewProfiles`). It sets the defaults of
   * `daemonVersion`, `protocol` and `capabilities`, and removes what that build lacks: its missing
   * kinds are rejected UNSUPPORTED, its missing spec sections reported SectionUnsupported, its missing
   * inventory sections never collected and its missing Hello fields never sent. Without it: the
   * current build.
   */
  profile?: DaemonProfile;
}

interface Session {
  readonly conn: AgentConn;
  welcomed: boolean;
  epoch: number;
  credits: Map<Lane, number>;
  heartbeatIntervalMs: number;
  heartbeats: number;
  upgradeRequired: boolean;
  reconnectAfterMs: number | undefined;
  readonly timers: Timer[];
}

interface Exec {
  readonly id: string;
  readonly body: CommandBody;
  readonly kind: FakeKind;
  readonly lane: Lane;
  phase: 'queued' | 'delay' | 'running';
  timer: Timer | undefined;
  cancelRequested: boolean;
}

interface Process {
  readonly incarnation: string;
  readonly timers: Set<Timer>;
  readonly execs: Map<string, Exec>;
  readonly queues: Map<Lane, Exec[]>;
  readonly busyWorkers: Map<Lane, number>;
  readonly creditsInUse: Map<Lane, number>;
  readonly deferred: Map<string, { body: CommandBody; timer: Timer | undefined }>;
  readonly overflow: { class: EventClass; kind: string; payload: Uint8Array }[];
  readonly failedAllocations: Map<string, number>;
  session: Session | undefined;
  reconnectTimer: Timer | undefined;
  reconnectAttempt: number;
  offsetMs: number;
  /** A Welcome set `offsetMs` in this process (before that, server time is only the journal's mark). */
  serverTimeKnown: boolean;
  spec: NodeSpec | undefined;
  observedGeneration: number;
  lastStatus: MessageInitShape<typeof StatusReportSchema> | undefined;
  collected: { sections: EncodedSection[]; at: number };
  convergeTimer: Timer | undefined;
}

const LANES = [Lane.CONTROL, Lane.PROVISION, Lane.BULK] as const;
const SECTION_ORDER = ['host', 'devices', 'instances', 'access', 'telemetry', 'daemon'] as const;
const SECTION_FIELD: Record<string, number> = {
  host: 1,
  devices: 2,
  instances: 3,
  access: 4,
  telemetry: 5,
  daemon: 6,
  site: 7,
};
const SECTION_SCHEMA = {
  host: HostSectionSchema,
  devices: DevicesSectionSchema,
  instances: InstancesSectionSchema,
  access: AccessSectionSchema,
  telemetry: TelemetrySectionSchema,
  daemon: DaemonSectionSchema,
  site: site.SiteSpecSchema,
} as const;
const REJECT_REASONS: Record<string, CommandRejectReason> = {
  UNSUPPORTED: CommandRejectReason.UNSUPPORTED,
  BAD_SIGNATURE: CommandRejectReason.BAD_SIGNATURE,
  EXPIRED: CommandRejectReason.EXPIRED,
  STALE_GENERATION: CommandRejectReason.STALE_GENERATION,
  BUSY: CommandRejectReason.BUSY,
  BATCH_UNAPPROVED: CommandRejectReason.BATCH_UNAPPROVED,
  UNBATCHED_LIMIT: CommandRejectReason.UNBATCHED_LIMIT,
};
const OUTCOME_STATE = {
  succeeded: CommandState.SUCCEEDED,
  failed: CommandState.FAILED,
  rejected: CommandState.REJECTED,
  cancelled: CommandState.CANCELLED,
} as const;
const EVENT_BATCH = 64;
/** How far a Welcome may move server time back from the latest seen (clock skew between gateways). */
const SERVER_TIME_ROLLBACK_MS = 5 * 60_000;
const CDI_DIR = '/etc/cdi/';
const ENV_DIR = '/run/bcd/allocations/';

/** Where the CDI hold of an allocation lives. */
export const cdiSpecPath = (allocationId: string): string => `${CDI_DIR}bcd-${allocationId}.json`;
/** Where the env file of an allocation lives (tmpfs: gone after a reboot, rewritten by the converger). */
export const envFilePath = (allocationId: string): string => `${ENV_DIR}${allocationId}.env`;

/** The precheck verdict (Go: dispatch.Verdict). */
export type Verdict = { reject: string } | { defer: true } | { accept: true };

/** The quorum part of a TrustBundle, as the daemon enforces it. */
export interface FakeQuorumTrust {
  approverKeys: readonly ApproverKey[];
  /** The deployment's trust domain approvals are signed for (JoinResponseBody.trust_domain). */
  trustDomain: string;
  threshold: number;
  tiers?: readonly { maxScopeSize: number; threshold: number }[];
  unbatchedPerHour?: number;
  /** The epoch of this set (TrustBundle.approver_set_epoch; default 0): a changed set needs a higher one. */
  epoch?: bigint;
}

const rejectionCode = (reason: string | undefined): CommandRejectReason =>
  REJECT_REASONS[reason ?? ''] ?? CommandRejectReason.UNSPECIFIED;

/**
 * The daemon side of PLAN.md §7 in TypeScript, for tests and the fleet simulator. It mirrors the Go
 * skeleton (daemon/internal/{journal,dispatch,session,converge}): the journal and its command rules,
 * the acceptance checks in Go's `Precheck` order, lanes with credits and worker pools, Hello from the
 * journal, heartbeats, reconnect with full-jitter backoff, desired state (full and patch) with a real
 * devices converger (CDI holds as an in-memory file map) and the v0.1 command kinds.
 *
 * Everything runs on the given `Scheduler`; with a `SimScheduler` and a seeded `rng` it is
 * deterministic. A crash keeps the journal and the files (the disk); a reboot also changes boot_id and
 * clears /run; a journal loss starts a new journal_id.
 */
export class FakeDaemon {
  readonly nodeId: string;
  readonly role: AgentRole;
  /** The running build; a self-update (`selfUpdate`) changes it. */
  daemonVersion: string;
  readonly knobs: FakeDaemonKnobs;
  /** logs.collect uploads, by URL (unless `objectStore` was given). */
  readonly uploads: Map<string, Uint8Array>;
  /** Side effects started per command id, over the node's whole life (survives crashes). */
  readonly executions = new Map<string, number>();
  /** The key `node_sig` is made with; tests may swap it (a stolen or wrong identity). */
  nodeKey: KeyObject | undefined;
  /** Commands whose result is node-signed, also when a journal replay reports it again. */
  private readonly attestedResults = new Set<string>();
  /** Every `OpenTunnel` this node answered, in order: opened, or refused and why. */
  readonly tunnelOutcomes: TunnelOutcome[] = [];
  /** The daemon's jti set (survives reconnects, like bcd's in-memory set). */
  private readonly tunnelJti: ReplayCache;
  /** The VPS host's runtimes (`instances` option); they outlive daemon crashes. */
  readonly hypervisor: FakeHypervisor | undefined;
  /** SecretRequests in flight: request id → the ref and the one-time key that opens the answer. */
  private readonly secretRequests = new Map<string, { ref: string; key: KeyObject }>();
  /** The VPS host's metadata service (v0.5): `handleImds(request, instanceId)` answers a guest. */
  private imdsService: FakeImds | undefined;
  /** WorkloadTokenRequests in flight: request id → the instance, the one-time key, the waiter. */
  private readonly workloadRequests = new Map<
    string,
    { instanceId: string; key: KeyObject; settle(result: { token: string } | { error: string }): void }
  >();

  private readonly scheduler: Scheduler;
  private readonly rng: Rng;
  private readonly options: FakeDaemonOptions;
  private readonly kinds: Map<string, FakeKind>;
  /** Command-signing roots in force (signed intent), and their trust-bundle version. */
  private intentRoots: readonly Uint8Array[] | undefined;
  private intentVersion: bigint | undefined;
  /** Commands whose signature failed (precheck answers BAD_SIGNATURE in its place). */
  private readonly badSignatures = new Set<string>();
  /** (v1.0) The destructive-batch quorum in force, and commands it refused (precheck answers in its place). */
  private quorum: FakeQuorumTrust | undefined;
  private readonly batchVerdicts = new Map<string, 'BATCH_UNAPPROVED' | 'UNBATCHED_LIMIT'>();
  /** Unbatched destructive commands admitted: id → server time, for the rolling-hour cap. */
  private readonly unbatched = new Map<string, number>();
  /** Batch leaves used: the leaf's hex hash → the command that used it (each leaf runs once). */
  private readonly batchLeaves = new Map<string, string>();
  /**
   * What an admitted command will use of the quorum: its batch leaf, or an unbatched slot. Recorded only when the
   * command is accepted, so deliveries rejected for a bad signature, another node or a past deadline use nothing.
   */
  /** The approver-set epoch held (TrustBundle.approver_set_epoch); kept through a signed removal of the quorum. */
  private approverEpoch = 0n;
  private readonly quorumClaims = new Map<string, { leaf: string } | { unbatched: true }>();
  /** Desired states refused by signed intent, in arrival order. */
  private readonly specRejectionsValue: { generation: number; reason: string }[] = [];
  private readonly fs = new Map<string, string>();
  /**
   * Released Kubernetes holds whose pods still have the devices (knobs.kubePodReleaseMs): claimed until
   * `until`, then AllocationReleased. On the daemon, not the process: bcd keeps them in releasing.json.
   */
  private readonly kubeReleasing = new Map<string, { deviceIds: string[]; generation: number; until: number }>();
  private hw: FakeHardware;
  private journalValue: MemoryJournal;
  private bootIdValue: string;
  private stateValue: FakeDaemonState = 'stopped';
  private revokedValue = false;
  private proc: Process | undefined;
  /** XIDs injected with `injectXid`, for the boot they happened in. */
  private faults: { bootId: string; conditions: Condition[] } | undefined;
  /** Self-update: the version being swapped to, and versions whose build crashed (never retried). */
  private swapping: string | undefined;
  private readonly failedUpdates = new Set<string>();
  private rebootTimer: Timer | undefined;
  private readonly hooks: RuleHooks = {
    rebootedPayload: (entry) =>
      entry.kind === 'node.reboot'
        ? encodeCommandResult('node.reboot', create(NodeRebootResultSchema, { previousBootId: entry.bootId ?? '' }))
        : undefined,
  };

  constructor(options: FakeDaemonOptions) {
    if (!options.nodeId) throw new TypeError('FakeDaemon needs a nodeId');
    this.options = options;
    this.nodeId = options.nodeId;
    if (options.intent) {
      this.intentRoots = [...options.intent.roots];
      this.intentVersion = options.intent.version;
      this.quorum = options.intent.quorum;
      this.approverEpoch = options.intent.quorum?.epoch ?? 0n;
    }
    this.role = options.role ?? AgentRole.NODE;
    this.daemonVersion = options.daemonVersion ?? options.profile?.daemonVersion ?? '0.1.0';
    this.scheduler = options.scheduler;
    this.rng = options.rng ?? createRng(`fake-daemon/${options.nodeId}`);
    this.hw = options.hardware ?? fakeHardware({ seed: options.nodeId });
    this.uploads = options.objectStore ?? new Map();
    this.knobs = { diag: {}, logs: {}, cdiWriteFailures: 0, ...options.knobs };
    this.kinds = new Map(Object.entries(defaultFakeKinds));
    for (const name of options.profile?.withoutKinds ?? []) this.kinds.delete(name);
    for (const [name, kind] of Object.entries(options.kinds ?? {}))
      if (kind === null) this.kinds.delete(name);
      else this.kinds.set(name, kind);
    this.bootIdValue = this.rng.uuid();
    this.journalValue = this.newJournal();
    this.nodeKey = options.nodeKey;
    this.tunnelJti = options.tunnels?.jtiCache ?? newTunnelJtiCache();
    this.hypervisor =
      options.instances instanceof FakeHypervisor
        ? options.instances
        : options.instances
          ? new FakeHypervisor(options.instances)
          : undefined;
    // A VPS host runs the vps module's `instance.snapshot` (sandboxes, v0.5) unless told otherwise.
    if (
      this.hypervisor &&
      !Object.hasOwn(options.kinds ?? {}, 'instance.snapshot') &&
      !options.profile?.withoutKinds?.includes('instance.snapshot')
    )
      this.kinds.set('instance.snapshot', fakeInstanceSnapshot);
  }

  // ---- observation ------------------------------------------------------------------------------

  get state(): FakeDaemonState {
    return this.stateValue;
  }
  /** Desired states refused by signed intent (`intent.signedSpecs`): generation and reason. */
  get specRejections(): readonly { generation: number; reason: string }[] {
    return this.specRejectionsValue;
  }
  /** The certificate was revoked: the daemon does not redial. */
  get revoked(): boolean {
    return this.revokedValue;
  }
  get bootId(): string {
    return this.bootIdValue;
  }
  get incarnation(): string | undefined {
    return this.proc?.incarnation;
  }
  get journal(): MemoryJournal {
    return this.journalValue;
  }
  get journalId(): string {
    return this.journalValue.meta().journalId;
  }
  get hardware(): FakeHardware {
    return this.hw;
  }
  /** The node's files that the daemon manages (CDI specs, env files). */
  get files(): ReadonlyMap<string, string> {
    return this.fs;
  }
  get connected(): boolean {
    return this.proc?.session !== undefined && !this.proc.session.conn.closed;
  }
  get welcomed(): boolean {
    return this.proc?.session?.welcomed === true;
  }
  /** (`intent`) The trust bundle in force: its version, command-signing roots and quorum (undefined: none). */
  get trust(): { version: bigint | undefined; roots: readonly Uint8Array[]; quorum: FakeQuorumTrust | undefined } {
    return { version: this.intentVersion, roots: this.intentRoots ?? [], quorum: this.quorum };
  }
  /** The epoch of the last Welcome (journal meta last_epoch). */
  get epoch(): number {
    return this.journalValue.meta().lastEpoch;
  }
  get appliedGeneration(): number {
    return this.journalValue.meta().appliedGeneration;
  }
  get observedGeneration(): number {
    return this.proc?.observedGeneration ?? 0;
  }
  /** The spec the daemon enforces (decoded from the journal). */
  get spec(): NodeSpec | undefined {
    return this.proc?.spec;
  }
  /** Commands waiting for a newer spec (min_generation). */
  get deferred(): string[] {
    return [...(this.proc?.deferred.keys() ?? [])];
  }
  /** Credits held per lane. */
  creditsInUse(lane: Lane): number {
    return this.proc?.creditsInUse.get(lane) ?? 0;
  }
  /** Allocation ids with a CDI hold on disk, sorted. */
  boundAllocations(): string[] {
    return [...this.observedAllocations().keys()].sort();
  }
  /** Device ids held by a CDI hold. */
  assignedDevices(): Set<string> {
    const out = new Set<string>();
    for (const hold of this.observedAllocations().values()) for (const id of hold.deviceIds) out.add(id);
    return out;
  }
  /**
   * The approver set this daemon enforces, as Hello and StatusReport carry it beside the trust version (review 10 M5):
   * a bundle's version can be taken while its quorum part is refused.
   */
  private heldApproverSet(): { approverSetEpoch: bigint; approverSetSha256: Uint8Array } {
    const held = this.quorum;
    return {
      approverSetEpoch: this.approverEpoch,
      approverSetSha256: held
        ? approverSetDigest({
            approverKeys: held.approverKeys,
            approverThreshold: held.threshold,
            quorumTiers: held.tiers ?? [],
            unbatchedDestructivePerHour: held.unbatchedPerHour ?? 0,
          })
        : new Uint8Array(),
    };
  }

  /** Server time as the daemon sees it (local clock + Welcome offset). */
  serverNow(): number {
    return this.localNow() + (this.proc?.offsetMs ?? 0);
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  /**
   * Starts a daemon process: new incarnation, journal recovery (SUCCEEDED{rebooted} and
   * FAILED{interrupted}), TTL sweep, inventory collection, the journaled spec enforced, then dial.
   */
  start(): void {
    if (this.stateValue === 'running') throw new Error(`${this.nodeId} is already running`);
    this.rebootTimer?.cancel();
    this.rebootTimer = undefined;
    const proc: Process = {
      incarnation: `inc_${this.rng.hex(16)}`,
      timers: new Set(),
      execs: new Map(),
      queues: new Map(LANES.map((lane) => [lane, []])),
      busyWorkers: new Map(),
      creditsInUse: new Map(),
      deferred: new Map(),
      overflow: [],
      failedAllocations: new Map(),
      session: undefined,
      reconnectTimer: undefined,
      reconnectAttempt: 0,
      offsetMs: 0,
      serverTimeKnown: false,
      spec: undefined,
      observedGeneration: 0,
      lastStatus: undefined,
      collected: { sections: [], at: 0 },
      convergeTimer: undefined,
    };
    this.proc = proc;
    this.stateValue = 'running';
    this.log('process.start', { boot: this.bootIdValue, incarnation: proc.incarnation, journal: this.journalId });
    this.fact({ type: 'process.started', at: this.scheduler.now(), nodeId: this.nodeId, bootId: this.bootIdValue, incarnation: proc.incarnation, reason: 'start' });

    const rt = this.runtime();
    for (const entry of recover(this.journalValue, rt, this.hooks)) {
      this.log('command.recovered', { id: entry.id, outcome: entry.result?.outcome, reason: entry.result?.reason ?? null, rebooted: entry.result?.rebooted === true });
      if (entry.result?.rebooted)
        this.fact({ type: 'execution.ended', ...this.identity(entry), outcome: 'succeeded', rebooted: true });
    }
    sweep(this.journalValue, this.localNow(), COMMAND_TTL_MS);
    this.collect(true);
    const spec = this.journalValue.spec();
    if (spec) {
      const body = fromBinary(DesiredStateBodySchema, spec.body);
      proc.spec = body.spec.case === 'full' ? body.spec.value : create(NodeSpecSchema);
      this.converge('start');
    }
    this.every(60 * 60 * 1000, () => sweep(this.journalValue, this.localNow(), COMMAND_TTL_MS));
    if (this.options.dial && !this.revokedValue) this.dialNow();
  }

  /** The daemon process dies. The journal and the files stay; everything in memory is lost. */
  crash(reason = 'crash'): void {
    if (this.stateValue === 'rebooting') {
      this.rebootTimer?.cancel();
      this.rebootTimer = undefined;
      this.stateValue = 'stopped';
      return;
    }
    const proc = this.proc;
    if (!proc) return;
    this.log('process.crash', { reason });
    this.fact({ type: 'process.stopped', at: this.scheduler.now(), nodeId: this.nodeId, bootId: this.bootIdValue, incarnation: proc.incarnation, reason });
    this.proc = undefined;
    this.stateValue = 'stopped';
    for (const timer of proc.timers) timer.cancel();
    proc.timers.clear();
    // A dead process's sockets close: the gateway sees a reset after one latency.
    proc.session?.conn.abort(reason);
  }

  /** `start()` after a crash. */
  restart(): void {
    this.start();
  }

  /**
   * Reboots the node: the process dies, boot_id changes, /run is cleared, and the daemon starts
   * again after `durationMs` (default `rebootDurationMs`). With `loseJournal`, the journal is lost
   * too (a ramdisk reboot or a reinstall).
   */
  reboot(options: { durationMs?: number; loseJournal?: boolean; reason?: string } = {}): void {
    this.crash(options.reason ?? 'reboot');
    this.bootIdValue = this.rng.uuid();
    for (const path of [...this.fs.keys()]) if (path.startsWith('/run/')) this.fs.delete(path);
    this.hypervisor?.powerLoss();
    if (options.loseJournal) this.loseJournal();
    this.stateValue = 'rebooting';
    this.log('node.reboot', { boot: this.bootIdValue });
    this.rebootTimer = this.scheduler.after(options.durationMs ?? this.options.rebootDurationMs ?? 60_000, () => {
      this.rebootTimer = undefined;
      if (this.stateValue !== 'rebooting') return;
      this.stateValue = 'stopped';
      this.start();
    });
  }

  /** Replaces the journal with an empty one (new journal_id). The daemon must not be running. */
  loseJournal(): void {
    if (this.stateValue === 'running') throw new Error('loseJournal() needs a stopped daemon: crash() first');
    const oldJournalId = this.journalId;
    this.journalValue = this.newJournal();
    this.log('journal.lost', { old: oldJournalId, journal: this.journalId });
    this.fact({ type: 'journal.lost', at: this.scheduler.now(), nodeId: this.nodeId, oldJournalId, newJournalId: this.journalId });
  }

  /** Swaps the hardware (e.g. a GPU falls off the bus); picked up by the next rescan or start. */
  setHardware(hardware: FakeHardware): void {
    this.hw = hardware;
  }

  /** Opens a session on `conn`: sends Hello from the journal and waits for Welcome. */
  connect(conn: AgentConn): void {
    const proc = this.requireProcess();
    if (proc.session) proc.session.conn.abort('replaced');
    proc.reconnectTimer?.cancel();
    proc.reconnectTimer = undefined;
    const session: Session = {
      conn,
      welcomed: false,
      epoch: 0,
      credits: new Map(),
      heartbeatIntervalMs: 10_000,
      heartbeats: 0,
      upgradeRequired: false,
      reconnectAfterMs: undefined,
      timers: [],
    };
    proc.session = session;
    conn.onFrame((frame) => this.onServerFrame(session, frame));
    conn.onClose((info) => this.onSessionClosed(session, info));
    this.log('session.open', { conn: conn.id });
    conn.send(create(AgentFrameSchema, { msg: { case: 'hello', value: this.hello() } }));
    session.timers.push(
      this.later(this.options.welcomeTimeoutMs ?? 30_000, () => {
        if (proc.session === session && !session.welcomed) this.dropSession(session, 'welcome-timeout');
      }),
    );
    const pingEvery = this.options.pingIntervalMs ?? 20_000;
    const ping = () => {
      if (proc.session !== session || conn.closed) return;
      conn.ping(this.options.pingTimeoutMs ?? 20_000, (alive) => {
        if (!alive && proc.session === session && !conn.closed) this.dropSession(session, 'ping-timeout');
      });
      session.timers.push(this.later(pingEvery, ping));
    };
    session.timers.push(this.later(pingEvery, ping));
  }

  /** Resets the current session (the daemon redials when it has `dial`). */
  disconnect(reason = 'disconnect'): void {
    const session = this.proc?.session;
    if (session) this.dropSession(session, reason);
  }

  /**
   * Sim: NVML reports XID `xid` on `gpuUuid`. It is reported as an active device condition `Xid<n>` in every
   * StatusReport of this boot (a reboot clears it, as bcd's kmsg/NVML state does); the current one is re-sent now.
   */
  injectXid(gpuUuid: string, xid: number, message = `Xid ${xid}`): void {
    const proc = this.requireProcess();
    if (this.faults?.bootId !== this.bootIdValue) this.faults = { bootId: this.bootIdValue, conditions: [] };
    const condition = create(ConditionSchema, {
      type: `Xid${xid}`,
      status: ConditionStatus.TRUE,
      deviceId: gpuUuid,
      reason: `Xid${xid}`,
      message,
    });
    this.faults.conditions.push(condition);
    if (proc.lastStatus) {
      const conditions: MessageInitShape<typeof ConditionSchema>[] = [...(proc.lastStatus.conditions ?? []), condition];
      proc.lastStatus = { ...proc.lastStatus, conditions } as MessageInitShape<typeof StatusReportSchema>;
      this.sendStatus();
    }
  }

  /**
   * The `daemon` section with `selfUpdate`: swaps to the spec's version after `swapMs` (a restart; the next Hello
   * reports the new version), or, for a bad build, crashes and comes back on the old slot.
   */
  private convergeDaemon(section: NodeSpec['daemon']): { state: SectionState; reason?: string; message?: string } {
    const target = section?.version?.replace(/^v/, '');
    if (!target || target === this.daemonVersion) return { state: SectionState.CONVERGED };
    if (this.failedUpdates.has(target))
      return { state: SectionState.FAILED, reason: 'UpdateFailed', message: `bcd ${target} did not start; running ${this.daemonVersion}` };
    if (this.swapping !== target) {
      this.swapping = target;
      this.scheduler.after(this.options.selfUpdate?.swapMs ?? 2_000, () => {
        if (this.swapping !== target) return;
        this.swapping = undefined;
        if (this.stateValue !== 'running') return;
        const bad = this.options.selfUpdate?.badVersions?.some((version) => version.replace(/^v/, '') === target) ?? false;
        this.crash(bad ? 'update-crashed' : 'update-swap');
        if (bad) this.failedUpdates.add(target);
        else this.daemonVersion = target;
        this.log('daemon.update', { target, ok: !bad, running: this.daemonVersion });
        this.start();
      });
    }
    return { state: SectionState.PROGRESSING, reason: 'Updating' };
  }

  private activeFaults(): Condition[] {
    return this.faults?.bootId === this.bootIdValue ? this.faults.conditions : [];
  }

  /** Journals a metric-like event (droppable when the journal is full). Sim-only: v1 Events carry no metric body. */
  emitMetric(kind = 'metric.sample'): void {
    this.requireProcess();
    this.emitEvent('metric', kind, { case: undefined });
  }

  /** Runs the converger once over the enforced spec. */
  converge(cause = 'manual'): void {
    const proc = this.proc;
    if (!proc) return;
    proc.convergeTimer?.cancel();
    proc.convergeTimer = undefined;
    const spec = proc.spec;
    const generation = this.appliedGeneration;
    if (!spec) return;
    const sections: MessageInitShape<typeof SectionStatusSchema>[] = [];
    const conditions: MessageInitShape<typeof ConditionSchema>[] = [];
    let progressing = false;
    const unsupported = (section: string, no: number) => {
      sections.push({ section, state: SectionState.UNSUPPORTED, generation: BigInt(generation), reason: 'SectionUnsupported' });
      conditions.push({ type: 'SectionUnsupported', status: ConditionStatus.TRUE, reason: String(no), message: `section ${section} is not supported by bcd ${this.daemonVersion}` });
    };
    const trivial = (name: keyof typeof SECTION_SCHEMA, value: unknown) => {
      if (value === undefined || toBinary(SECTION_SCHEMA[name] as never, value as never).byteLength === 0)
        sections.push({ section: name, state: SectionState.CONVERGED, generation: BigInt(generation) });
      else unsupported(name, SECTION_FIELD[name]!);
    };
    let instances: ReturnType<FakeHypervisor['converge']> | undefined;
    const lacks = new Set<string>(this.options.profile?.withoutSections ?? []);
    for (const name of SECTION_ORDER) {
      // A section this build predates: only an empty one converges, as for any section it cannot act on.
      if (lacks.has(name)) trivial(name, spec[name]);
      else if (name === 'instances' && this.hypervisor) {
        instances = this.hypervisor.converge(spec.instances, (request) => this.fetchUserData(request));
        if (instances.state === SectionState.PROGRESSING) progressing = true;
        sections.push({
          section: 'instances',
          generation: BigInt(generation),
          state: instances.state,
          ...(instances.reason ? { reason: instances.reason } : {}),
          ...(instances.message ? { message: instances.message } : {}),
        });
      } else if (name === 'devices') {
        const report = this.convergeDevices(spec.devices, generation);
        if (report.state === SectionState.PROGRESSING) progressing = true;
        sections.push({ section: 'devices', generation: BigInt(generation), ...report });
      } else if (name === 'daemon' && this.options.selfUpdate) {
        const report = this.convergeDaemon(spec.daemon);
        if (report.state === SectionState.PROGRESSING) progressing = true;
        sections.push({ section: 'daemon', generation: BigInt(generation), ...report });
      } else if (name === 'telemetry') {
        // Recorded as the OTLP target; nothing to materialize in the fake.
        sections.push({ section: 'telemetry', state: SectionState.CONVERGED, generation: BigInt(generation) });
      } else trivial(name, spec[name]);
    }
    if (spec.site !== undefined) trivial('site', spec.site);
    const unknown = [...new Set((spec.$unknown ?? []).map((field) => field.no))].sort((a, b) => a - b);
    for (const no of unknown) unsupported(String(no), no);
    if (!progressing && generation > proc.observedGeneration) proc.observedGeneration = generation;
    proc.lastStatus = {
      observedGeneration: BigInt(proc.observedGeneration),
      appliedGeneration: BigInt(generation),
      appliedSpecHash: this.journalValue.spec()?.hash ?? new Uint8Array(),
      sections,
      conditions: [...conditions, ...this.activeFaults()],
      ...(instances ? { instances: instances.statuses, instancesComplete: true } : {}),
    };
    this.log('converge', { cause, generation, observed: proc.observedGeneration, progressing });
    this.sendStatus();
    if (progressing)
      proc.convergeTimer = this.later(this.options.convergeRetryMs ?? 30_000, () => this.converge('retry'));
  }

  // ---- session ----------------------------------------------------------------------------------

  private hello(): MessageInitShape<typeof HelloSchema> {
    const proc = this.requireProcess();
    const meta = this.journalValue.meta();
    if (meta.nodeId && meta.nodeId !== this.nodeId)
      throw new Error(`the journal belongs to node ${meta.nodeId}, not ${this.nodeId}`);
    const unacked: CommandUpdate[] = [];
    const running: string[] = [];
    for (const entry of this.journalValue.commands()) {
      if (entry.state === 'done' && !entry.resultAcked) unacked.push(this.updateOf(entry.id, entry.result!));
      else if (entry.state !== 'done' && entry.incarnation === proc.incarnation) running.push(entry.id);
    }
    const range = this.options.protocol ?? this.options.profile?.protocol ?? PROTOCOL_VERSION;
    const lacks = new Set<string>(this.options.profile?.withoutHello ?? []);
    return {
      nodeId: this.nodeId,
      bootId: this.bootIdValue,
      journalId: meta.journalId,
      role: this.role,
      daemonVersion: this.daemonVersion,
      protoMin: range.min,
      protoMax: range.max,
      capabilities: [
        ...(this.options.capabilities ??
          this.options.profile?.capabilities ?? [
          // devices.limits and binding.kubernetes: this build enforces DeviceAssignment.limits and hands
          // KUBERNETES bindings to the kubelet (§3.8); capacity books host resources and Kubernetes only here.
          ...(this.hw.gpuUuids.length > 0 ? ['cdi', 'nvml', 'devices.limits', 'binding.kubernetes'] : []),
          // Instance tcp/ssh tunnels reach the instance's own address (the tunnel program stands in for it), never
          // the host's loopback: tunnels.open requires this before opening one.
          ...(this.options.tunnels ? ['tunnel.instance-dial'] : []),
          // A VPS host enforces InstanceSpec.network_policy (the fake hypervisor records it), as bcd does
          // since 13f784f: vps places private/none sandboxes only on hosts that say so.
          ...(this.hypervisor ? ['instance.network-policy'] : []),
          // And ssh_from_host_only and placement: vps places sandboxes and placed flavors only there.
          ...(this.hypervisor ? ['instance.ssh-host-only', 'instance.placement', 'instance.volumes'] : []),
        ]),
      ],
      drivers: [
        ...(lacks.has('drivers')
          ? []
          : this.options.drivers ??
          (this.hw.gpuUuids.length > 0
            ? [{ id: 'nvidia', version: this.daemonVersion, kinds: ['config'], configSchemaJson: '{"type":"object"}' }]
            : [])),
      ],
      lastEpoch: BigInt(meta.lastEpoch),
      appliedGeneration: BigInt(meta.appliedGeneration),
      unackedResults: unacked,
      runningCommandIds: running,
      lastEventSeq: BigInt(meta.eventSeq),
      inventoryHashes: Object.fromEntries(proc.collected.sections.map((s) => [s.name, s.sha256])),
      appliedSpecHash: this.journalValue.spec()?.hash ?? new Uint8Array(),
      // The TrustBundle version held: a command-root switch waits until every node reports the new one (§13).
      ...(this.intentVersion !== undefined && !lacks.has('trustVersion') ? { trustVersion: this.intentVersion, ...this.heldApproverSet() } : {}),
    };
  }

  private dialNow(): void {
    const proc = this.proc;
    if (!proc || proc.session || this.revokedValue || !this.options.dial) return;
    proc.reconnectTimer = undefined;
    const conn = this.options.dial();
    if (!conn) {
      this.log('session.dial-failed', { attempt: proc.reconnectAttempt });
      this.scheduleReconnect();
      return;
    }
    this.connect(conn);
  }

  private scheduleReconnect(delayMs?: number): void {
    const proc = this.proc;
    if (!proc || !this.options.dial || this.revokedValue || proc.reconnectTimer) return;
    let delay = delayMs;
    if (delay === undefined) {
      const { minMs, maxMs } = this.options.backoff ?? { minMs: 1_000, maxMs: 60_000 };
      let ceiling = minMs;
      for (let i = 0; i < proc.reconnectAttempt && ceiling < maxMs; i++) ceiling *= 2;
      ceiling = Math.min(ceiling, maxMs);
      delay = ceiling <= 0 ? 0 : Math.floor(this.rng.next() * (ceiling + 1));
      proc.reconnectAttempt++;
    }
    this.log('session.redial', { in: delay });
    proc.reconnectTimer = this.later(delay, () => this.dialNow());
  }

  private dropSession(session: Session, reason: string): void {
    this.log('session.drop', { reason });
    session.conn.abort(reason);
  }

  private onSessionClosed(session: Session, info: CloseInfo): void {
    const proc = this.proc;
    for (const timer of session.timers) timer.cancel();
    if (!proc || proc.session !== session) return;
    proc.session = undefined;
    this.log('session.closed', { reason: info.reason, by: info.by });
    // A refusal that says when to come back (gRPC retry pushback) is followed exactly, and the doubling restarts:
    // the gateway spreads a herd over the time it needs, instead of every daemon backing off to the cap.
    if (info.retryAfterMs !== undefined && session.reconnectAfterMs === undefined) {
      proc.reconnectAttempt = 0;
      this.scheduleReconnect(Math.max(0, info.retryAfterMs));
      return;
    }
    this.scheduleReconnect(session.reconnectAfterMs);
  }

  private send(session: Session | undefined, msg: AgentFrame['msg']): boolean {
    if (!session || !session.welcomed || session.conn.closed) return false;
    return session.conn.send(create(AgentFrameSchema, { msg }));
  }

  private onServerFrame(session: Session, frame: ServerFrame): void {
    const proc = this.proc;
    if (!proc || proc.session !== session) return;
    const msg = frame.msg;
    if (msg.case === 'welcome') return this.onWelcome(session, msg.value);
    if (!session.welcomed) {
      this.dropSession(session, `protocol: ${msg.case ?? 'empty frame'} before Welcome`);
      return;
    }
    switch (msg.case) {
      case 'command':
        return this.onCommand(session, msg.value);
      case 'cancel':
        return this.onCancel(session, msg.value);
      case 'desired':
        return this.onDesired(session, msg.value);
      case 'ack': {
        // Go: session.ApplyAck.
        const meta = this.journalValue.meta();
        if (msg.value.journalId === meta.journalId) this.journalValue.ackEvents(Number(msg.value.eventSeq));
        for (const id of msg.value.commandIds) {
          const entry = this.journalValue.command(id);
          if (!entry || entry.state !== 'done' || entry.resultAcked) continue;
          ackResult(this.journalValue, id);
        }
        this.retryOverflow();
        return;
      }
      case 'drain':
        this.log('session.drain', { after: msg.value.reconnectAfterMs });
        session.reconnectAfterMs = msg.value.reconnectAfterMs;
        session.conn.close('drain');
        return;
      case 'revoked':
        this.log('session.revoked', { reason: msg.value.reason });
        this.revokedValue = true;
        session.conn.close('revoked');
        return;
      case 'workloadToken': {
        const pending = this.workloadRequests.get(msg.value.requestId);
        if (!pending) {
          this.log('frame.ignored', { case: 'workloadToken', why: 'unknown request' });
          return;
        }
        try {
          const token = openWorkloadTokenResponse(msg.value, pending.key, {
            requestId: msg.value.requestId,
            instanceId: pending.instanceId,
            now: this.serverNow(),
          });
          pending.settle({ token });
        } catch (error) {
          pending.settle({
            error: isComputeError(error) ? String(error.details?.refusal ?? 'access-denied') : 'access-denied',
          });
        }
        return;
      }
      case 'secret': {
        const pending = this.secretRequests.get(msg.value.requestId);
        if (!pending || !this.hypervisor) {
          this.log('frame.ignored', { case: 'secret', why: 'unknown request' });
          return;
        }
        this.secretRequests.delete(msg.value.requestId);
        try {
          const value = openSecretResponse(msg.value, pending.key, {
            ref: pending.ref,
            requestId: msg.value.requestId,
            now: this.serverNow(),
          });
          this.hypervisor.provideUserData(pending.ref, { value });
          this.log('secret.received', { ref: pending.ref });
        } catch (error) {
          const refusal = isComputeError(error) ? String(error.details?.refusal ?? error.message) : String(error);
          this.hypervisor.provideUserData(pending.ref, { error: refusal });
          this.log('secret.refused', { ref: pending.ref, refusal });
        }
        this.converge('user-data');
        return;
      }
      case 'openTunnel': {
        const tunnels = this.options.tunnels;
        if (!tunnels) {
          this.log('frame.ignored', { case: 'openTunnel', why: 'no tunnels' });
          return;
        }
        const outcome = startTunnel({
          nodeId: this.nodeId,
          tunnelId: msg.value.tunnelId,
          ticket: msg.value.ticket,
          jwksJson: proc.spec?.access?.execTicketJwksJson ?? '',
          now: this.serverNow(),
          jtiCache: this.tunnelJti,
          options: tunnels,
        });
        this.tunnelOutcomes.push(outcome);
        this.log(
          outcome.opened ? 'tunnel.opened' : 'tunnel.refused',
          outcome.opened
            ? { tunnelId: outcome.tunnelId }
            : { tunnelId: outcome.tunnelId, reason: outcome.reason },
        );
        return;
      }
      default:
        this.log('frame.ignored', { case: msg.case ?? null });
    }
  }

  private onWelcome(session: Session, welcome: Welcome): void {
    const proc = this.requireProcess();
    if (session.welcomed) {
      this.log('frame.ignored', { case: 'welcome', why: 'duplicate' });
      return;
    }
    // Server time never goes back (beyond clock skew): Welcome.server_time is unsigned, and a gateway
    // that could rewind it would make expired commands and worker certificates valid again.
    const meta = this.journalValue.meta();
    const serverTime = welcome.serverTime ? timestampMs(welcome.serverTime) : undefined;
    if (
      serverTime !== undefined &&
      meta.serverTimeMs !== undefined &&
      serverTime < meta.serverTimeMs - SERVER_TIME_ROLLBACK_MS
    ) {
      this.dropSession(session, 'protocol: server time went backwards');
      return;
    }
    session.welcomed = true;
    session.epoch = Number(welcome.epoch);
    // Go: session.ApplyWelcome.
    // The working clock never moves back either: a Welcome within the skew allowance keeps the later time, or a
    // ticket whose jti was already pruned (at its expiry) would verify again.
    if (serverTime !== undefined) {
      const floor = Math.max(meta.serverTimeMs ?? -Infinity, proc.serverTimeKnown ? this.serverNow() : -Infinity);
      proc.offsetMs = Math.max(serverTime, floor) - this.localNow();
      proc.serverTimeKnown = true;
    }
    this.journalValue.saveMeta({
      ...meta,
      lastEpoch: session.epoch,
      ...(serverTime !== undefined ? { serverTimeMs: serverTime } : {}),
    });
    this.journalValue.ackEvents(Number(welcome.ackedEventSeq));
    for (const lane of LANES) session.credits.set(lane, DEFAULT_CREDITS[lane]);
    for (const credit of welcome.credits) session.credits.set(credit.lane, credit.credits);
    session.heartbeatIntervalMs = welcome.heartbeatIntervalMs > 0 ? welcome.heartbeatIntervalMs : 10_000;
    session.upgradeRequired = welcome.upgradeRequired;
    // Go: intent.ApplyTrustBundle. Only a bundle signed by the pinned join key, and newer.
    if (this.options.intent?.trustSigner && welcome.trust) {
      try {
        const bundle = verifyTrustBundle(welcome.trust, this.options.intent.trustSigner, this.intentVersion);
        this.intentRoots = [...bundle.commandSigningRoots];
        this.intentVersion = bundle.version;
        // The quorum part (common.proto, review 10 M3): holding (H, e), take (N, e') only when e' > e and k-of-H signed
        // (e', N, the own trust domain), N == H included. Refused, the held quorum stays while the rest of the bundle
        // (roots, version) applies. A signed removal keeps its epoch, so an older set is never taken back.
        const held = this.quorum;
        const heldSet = held
          ? {
              approverKeys: held.approverKeys,
              approverThreshold: held.threshold,
              quorumTiers: held.tiers ?? [],
              unbatchedDestructivePerHour: held.unbatchedPerHour ?? 0,
              epoch: held.epoch ?? 0n,
            }
          : this.approverEpoch > 0n
            ? { approverKeys: [], approverThreshold: 0, quorumTiers: [], unbatchedDestructivePerHour: 0, epoch: this.approverEpoch }
            : undefined;
        // A keyless daemon with a pin takes only the pinned set (never the api's word for the first one).
        const pin = this.options.intent.approverSetSha256;
        const transition =
          !held && pin && Buffer.compare(approverSetDigest(approverSetOf(bundle)), pin) !== 0
            ? { adopt: false, approvers: [], reason: 'pin-mismatch' }
            : approverSetTransition(heldSet, {
                ...approverSetOf(bundle),
                epoch: bundle.approverSetEpoch,
                approverSetSignatures: bundle.approverSetSignatures,
                // The deployment's own trust domain, as for batch approvals.
                trustDomain: held?.trustDomain ?? this.options.intent.trustDomain,
              });
        if (transition.adopt) {
          // The quorum travels in the same signed bundle: a signed one without approver keys lifts it.
          this.quorum = bundle.approverKeys.length
            ? {
                approverKeys: bundle.approverKeys.map((key) => ({ kid: key.kid, spkiDer: key.spkiDer })),
                threshold: bundle.approverThreshold,
                tiers: bundle.quorumTiers.map((tier) => ({ maxScopeSize: tier.maxScopeSize, threshold: tier.threshold })),
                unbatchedPerHour: bundle.unbatchedDestructivePerHour,
                // The deployment's own trust domain (absent: every approval fails, closed).
                trustDomain: this.quorum?.trustDomain ?? this.options.intent.trustDomain ?? '',
                epoch: bundle.approverSetEpoch,
              }
            : undefined;
          this.approverEpoch = bundle.approverSetEpoch;
        } else if (transition.reason)
          this.log('trust.quorum-refused', { version: Number(bundle.version), reason: transition.reason });
        this.log('trust.updated', { version: Number(bundle.version), roots: bundle.commandSigningRoots.length });
      } catch (error) {
        this.log('trust.ignored', {
          reason: isComputeError(error) ? String(error.details?.reason ?? error.message) : String(error),
        });
      }
    }
    proc.reconnectAttempt = 0;
    this.log('session.welcome', { epoch: session.epoch, acked: Number(welcome.ackedEventSeq), sections: welcome.requestSections });
    const wanted = new Set(welcome.requestSections);
    this.sendInventory(proc.collected.sections.filter((s) => wanted.has(s.name)));
    this.sendUnackedEvents(session);
    this.sendStatus();
    // User-data fetches that went out on a closed session are asked again on this one.
    this.secretRequests.clear();
    if (this.hypervisor?.retryFetches() && proc.spec) this.converge('welcome');
    const beat = () => {
      if (proc.session !== session || session.conn.closed) return;
      this.heartbeat(session);
      session.timers.push(this.later(session.heartbeatIntervalMs, beat));
    };
    session.timers.push(this.later(session.heartbeatIntervalMs, beat));
  }

  private heartbeat(session: Session): void {
    const proc = this.requireProcess();
    session.heartbeats++;
    this.journalValue.saveMeta({ ...this.journalValue.meta(), serverTimeMs: this.serverNow() });
    let running = 0;
    for (const count of proc.busyWorkers.values()) running += count;
    const memory = this.hw.inventory.memory?.totalBytes ?? 0n;
    this.send(session, {
      case: 'heartbeat',
      value: create(HeartbeatSchema, {
        credits: LANES.map((lane) => ({
          lane,
          credits: Math.max(0, (session.credits.get(lane) ?? 0) - (proc.creditsInUse.get(lane) ?? 0)),
        })),
        load: {
          loadAverage1m: running * 0.5,
          memoryAvailableBytes: memory / 2n,
          runningCommands: running,
          pendingEvents: this.journalValue.eventStats().count,
        },
        // Every 10th heartbeat carries the inventory hashes (PLAN.md §10.1).
        inventoryHashes:
          session.heartbeats % 10 === 0
            ? Object.fromEntries(proc.collected.sections.map((s) => [s.name, s.sha256]))
            : {},
        appliedGeneration: BigInt(this.appliedGeneration),
      }),
    });
  }

  // ---- commands ---------------------------------------------------------------------------------

  private onCommand(session: Session, command: Command): void {
    let body: CommandBody;
    try {
      body = unwrapCommand(command);
    } catch (error) {
      this.log('command.undecodable', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!body.id) {
      this.log('command.undecodable', { error: 'missing id' });
      return;
    }
    // Go: intent.VerifyCommand. The verdict is applied by precheck, in its place in the order.
    if (this.intentRoots) {
      // Once command-signing roots are in force EVERY kind must be signed (review 7 HIGH-1): an unsigned
      // "harmless" kind is a gateway's way in (site.httpProxy reaches any BMC of the site). The control plane
      // signs every command it enqueues.
      try {
        verifyCommand(command, { roots: this.intentRoots, now: this.serverNow(), nodeId: this.nodeId, required: true });
        this.badSignatures.delete(body.id);
      } catch (error) {
        this.badSignatures.add(body.id);
        this.log('command.bad-signature', {
          id: body.id,
          kind: body.kind,
          reason: isComputeError(error) ? String(error.details?.reason ?? error.message) : String(error),
        });
      }
    }
    this.checkQuorum(command, body);
    const delivery = this.deliveryOf(body);
    const decision = resolve(this.journalValue, delivery, this.runtime(), this.hooks);
    this.log('command.deliver', { id: body.id, kind: body.kind, attempt: command.attempt, action: decision.action });
    switch (decision.action) {
      case 'resend':
      case 'report':
        this.sendResult(session, body.id, decision.result!);
        return;
      case 'reattach':
        return;
      case 'execute':
      case 'reexecute':
        this.admit(body, false);
    }
  }

  /**
   * (v1.0, §13) The destructive-batch quorum, bcd's intent.CheckBatch: with approver keys in force, a destructive
   * command with a batch_id needs a BatchApproval of enough distinct approver keys whose scope proves its
   * (subject, kind); one without a batch_id counts against the unbatched hourly cap. The verdict is applied by
   * precheck, after the signature check.
   */
  private checkQuorum(command: Command, body: CommandBody): void {
    const quorum = this.quorum;
    const kind = this.kinds.get(body.kind);
    const destructive = kind?.destructive ?? (isCommandKind(body.kind) && commandKinds[body.kind].destructive);
    if (!quorum) {
      // Pinned to a set it has not received yet: fail closed (review 7 M2).
      if (destructive && this.options.intent?.approverSetSha256) {
        this.batchVerdicts.set(body.id, 'BATCH_UNAPPROVED');
        this.log('command.batch-unapproved', { id: body.id, batch: body.batchId, reason: 'awaiting-pinned-set' });
      }
      return;
    }
    if (!destructive) return;
    // Approvals expire in server time; the unbatched hourly window counts on the local clock, which a gateway
    // cannot move forward (a Welcome can).
    const now = this.serverNow();
    const local = this.localNow();
    if (body.batchId) {
      try {
        // The subject comes from the signed body: this node for its own kinds, the BMC or proxied node a site
        // agent acts on for relayed ones (precheck has already required body.nodeId to be this node).
        const subject = batchSubject(body);
        // The leaf may bind this exact payload (its digest) or any payload of the kind.
        const payloadSha256 = body.payload
          ? new Uint8Array(createHash('sha256').update(body.payload.value).digest())
          : undefined;
        verifyBatchCommand(
          { batchId: body.batchId, subject, kind: body.kind, payloadSha256 },
          command.batchApproval,
          command.batchProof,
          {
            approverKeys: quorum.approverKeys,
            threshold: quorum.threshold,
            ...(quorum.tiers ? { tiers: quorum.tiers } : {}),
            now,
            trustDomain: quorum.trustDomain,
          },
        );
        // Each leaf runs at most once per batch: an approval for N machines is N operations, not N
        // kinds of operation to repeat. A redelivery of the same command keeps its leaf. Keyed by the
        // leaf's hash, as bcd does (its batch_id is inside), so another approval of the same batch id
        // with a different tree cannot move a used leaf to a fresh index.
        const bound =
          payloadSha256 !== undefined &&
          verifyBatchProof({
            batchId: body.batchId,
            subject,
            kind: body.kind,
            payloadSha256,
            proof: command.batchProof!,
            root: command.batchApproval!.scopeRoot,
            size: command.batchApproval!.scopeSize,
          });
        const leaf = createHash('sha256')
          .update(batchLeafInput(body.batchId, subject, body.kind, bound ? payloadSha256 : undefined))
          .digest('hex');
        const holder = this.batchLeaves.get(leaf);
        if (holder !== undefined && holder !== body.id)
          throw new ComputeError('ACCESS_DENIED', 'This batch leaf already ran', undefined, { reason: 'leaf-used' });
        this.quorumClaims.set(body.id, { leaf });
        this.batchVerdicts.delete(body.id);
      } catch (error) {
        this.batchVerdicts.set(body.id, 'BATCH_UNAPPROVED');
        this.log('command.batch-unapproved', {
          id: body.id,
          batch: body.batchId,
          reason: isComputeError(error) ? String(error.details?.reason ?? error.message) : String(error),
        });
      }
      return;
    }
    // A redelivery of an admitted command does not count again.
    if (this.unbatched.has(body.id)) return;
    for (const [id, at] of this.unbatched) if (at <= local - 3_600_000) this.unbatched.delete(id);
    if (this.unbatched.size >= (quorum.unbatchedPerHour ?? 0)) {
      this.batchVerdicts.set(body.id, 'UNBATCHED_LIMIT');
      this.log('command.unbatched-limit', { id: body.id, kind: body.kind });
      return;
    }
    this.quorumClaims.set(body.id, { unbatched: true });
    this.batchVerdicts.delete(body.id);
  }

  /**
   * Records what an accepted command uses of the quorum, checking again first (another command may have taken the
   * leaf or the last slot since it was delivered). Returns the rejection when it no longer fits.
   */
  private claimQuorum(id: string): 'BATCH_UNAPPROVED' | 'UNBATCHED_LIMIT' | undefined {
    const claim = this.quorumClaims.get(id);
    if (!claim) return undefined;
    this.quorumClaims.delete(id);
    if ('leaf' in claim) {
      const holder = this.batchLeaves.get(claim.leaf);
      if (holder !== undefined && holder !== id) return 'BATCH_UNAPPROVED';
      this.batchLeaves.set(claim.leaf, id);
      return undefined;
    }
    if (this.unbatched.has(id)) return undefined;
    const local = this.localNow();
    for (const [other, at] of this.unbatched) if (at <= local - 3_600_000) this.unbatched.delete(other);
    if (this.unbatched.size >= (this.quorum?.unbatchedPerHour ?? 0)) return 'UNBATCHED_LIMIT';
    this.unbatched.set(id, local);
    return undefined;
  }

  /** Go: dispatch.Precheck, in its order. */
  precheck(body: CommandBody, deferred: boolean): Verdict {
    if (body.nodeId !== this.nodeId) return { reject: 'UNSUPPORTED' };
    if (this.proc?.session?.upgradeRequired && body.kind !== 'daemon.upgrade') return { reject: 'UNSUPPORTED' };
    const kind = this.kinds.get(body.kind);
    if (!kind || !kind.roles.includes(this.role)) return { reject: 'UNSUPPORTED' };
    const notAfter = body.notAfter ? timestampMs(body.notAfter) : 0;
    const pastDeadline = !(this.serverNow() < notAfter);
    if (Number(body.minGeneration) > this.appliedGeneration) {
      if (!pastDeadline) return { defer: true };
      if (deferred) return { reject: 'STALE_GENERATION' };
    }
    if (pastDeadline) return { reject: 'EXPIRED' };
    if (this.badSignatures.has(body.id)) return { reject: 'BAD_SIGNATURE' };
    const batch = this.batchVerdicts.get(body.id);
    if (batch) return { reject: batch };
    return { accept: true };
  }

  private admit(body: CommandBody, deferred: boolean): void {
    const proc = this.requireProcess();
    const session = proc.session;
    const known = proc.deferred.get(body.id);
    if (known && !deferred) return; // a duplicate of a command already waiting for its spec
    const verdict = this.precheck(body, deferred);
    const delivery = this.deliveryOf(body);
    if ('defer' in verdict) {
      if (known) return;
      const notAfter = body.notAfter ? timestampMs(body.notAfter) : 0;
      const timer = this.later(Math.max(0, notAfter - this.serverNow()), () => {
        if (proc.deferred.has(body.id)) this.admit(body, true);
      });
      proc.deferred.set(body.id, { body, timer });
      this.log('command.defer', { id: body.id, min: Number(body.minGeneration), applied: this.appliedGeneration });
      this.send(session, {
        case: 'specRequest',
        value: { haveGeneration: BigInt(this.appliedGeneration), reason: SpecRequestReason.MIN_GENERATION },
      } as AgentFrame['msg']);
      return;
    }
    if (known) {
      known.timer?.cancel();
      proc.deferred.delete(body.id);
    }
    if ('reject' in verdict) {
      const result = recordRejection(this.journalValue, delivery, verdict.reject, this.runtime(), this.bootIdValue);
      this.log('command.reject', { id: body.id, reason: verdict.reject });
      this.sendResult(session, body.id, result);
      return;
    }
    const kind = this.kinds.get(body.kind)!;
    const lane = kind.lane;
    const limit = session?.credits.get(lane) ?? DEFAULT_CREDITS[lane];
    const inUse = proc.creditsInUse.get(lane) ?? 0;
    if (inUse >= limit || proc.overflow.length > 0) {
      this.log('command.busy', { id: body.id, lane, inUse, limit, journalFull: proc.overflow.length > 0 });
      this.send(session, {
        case: 'update',
        value: { commandId: body.id, state: CommandState.REJECTED, rejectReason: CommandRejectReason.BUSY, bootId: this.bootIdValue },
      } as AgentFrame['msg']);
      return;
    }
    const lost = this.claimQuorum(body.id);
    if (lost) {
      const result = recordRejection(this.journalValue, delivery, lost, this.runtime(), this.bootIdValue);
      this.log('command.reject', { id: body.id, reason: lost });
      this.sendResult(session, body.id, result);
      return;
    }
    accept(this.journalValue, delivery, this.runtime());
    proc.creditsInUse.set(lane, inUse + 1);
    this.fact({ type: 'command.accepted', ...this.identityOf(body) });
    this.log('command.accept', { id: body.id, kind: body.kind, lane });
    this.sendUpdate(body.id, CommandState.ACKED);
    const exec: Exec = { id: body.id, body, kind, lane, phase: 'queued', timer: undefined, cancelRequested: false };
    proc.execs.set(body.id, exec);
    proc.queues.get(lane)!.push(exec);
    this.pump(lane);
  }

  private pump(lane: Lane): void {
    const proc = this.requireProcess();
    const queue = proc.queues.get(lane)!;
    const workers = this.options.workers?.[lane] ?? DEFAULT_WORKERS[lane];
    while (queue.length > 0 && (proc.busyWorkers.get(lane) ?? 0) < workers) {
      const exec = queue.shift()!;
      proc.busyWorkers.set(lane, (proc.busyWorkers.get(lane) ?? 0) + 1);
      this.startExec(exec);
    }
  }

  private startExec(exec: Exec): void {
    const duration =
      typeof exec.kind.durationMs === 'function' ? exec.kind.durationMs(exec.body) : (exec.kind.durationMs ?? 1_000);
    if (exec.kind.effect === 'reboot') {
      // Self-terminating: running{boot_id} is journaled immediately before the side effect.
      exec.phase = 'delay';
      exec.timer = this.later(duration, () => {
        exec.phase = 'running';
        this.run(exec);
        this.reboot({ reason: `node.reboot ${exec.id}` });
      });
      return;
    }
    exec.phase = 'running';
    this.run(exec);
    exec.timer = this.later(duration, () => this.finishExec(exec));
  }

  /** Journals running{boot_id} and records the side effect's start. */
  private run(exec: Exec): void {
    markRunning(this.journalValue, exec.id, this.runtime());
    this.executions.set(exec.id, (this.executions.get(exec.id) ?? 0) + 1);
    this.fact({ type: 'execution.started', ...this.identityOf(exec.body) });
    this.log('command.run', { id: exec.id, kind: exec.body.kind });
    this.sendUpdate(exec.id, CommandState.RUNNING);
  }

  private finishExec(exec: Exec): void {
    const proc = this.requireProcess();
    const outcome = exec.kind.run?.(this.kindContext(exec.body)) ?? { outcome: 'succeeded' as const };
    if (outcome instanceof Promise) {
      // An asynchronous side effect (a bcx driver call): completes when it settles, unless the
      // process died meanwhile (the journal's running entry then recovers as interrupted).
      void outcome
        .catch((error: unknown): FakeKindOutcome => ({
          outcome: 'failed',
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
        }))
        .then((settled) => {
          if (this.proc === proc && proc.execs.get(exec.id) === exec) this.completeExec(exec, settled);
        });
      return;
    }
    this.completeExec(exec, outcome);
  }

  private completeExec(exec: Exec, outcome: FakeKindOutcome): void {
    const proc = this.requireProcess();
    const result: JournalResult =
      outcome.outcome === 'succeeded'
        ? { outcome: 'succeeded', bootId: this.bootIdValue }
        : { outcome: 'failed', reason: outcome.code, bootId: this.bootIdValue };
    if (outcome.outcome === 'failed' && outcome.message) result.message = outcome.message;
    if (outcome.result) result.payload = outcome.result;
    if (outcome.attest) this.attestedResults.add(exec.id);
    complete(this.journalValue, exec.id, result, this.localNow());
    this.fact({ type: 'execution.ended', ...this.identityOf(exec.body), outcome: result.outcome, rebooted: false });
    this.log('command.done', { id: exec.id, outcome: result.outcome, reason: result.reason ?? null, cancelRequested: exec.cancelRequested });
    this.release(exec);
    this.sendResult(proc.session, exec.id, result);
    this.pump(exec.lane);
  }

  private release(exec: Exec): void {
    const proc = this.requireProcess();
    proc.execs.delete(exec.id);
    proc.creditsInUse.set(exec.lane, Math.max(0, (proc.creditsInUse.get(exec.lane) ?? 0) - 1));
    if (exec.phase !== 'queued')
      proc.busyWorkers.set(exec.lane, Math.max(0, (proc.busyWorkers.get(exec.lane) ?? 0) - 1));
  }

  private onCancel(session: Session, cancel: Cancel): void {
    const proc = this.requireProcess();
    const id = cancel.commandId;
    const exec = proc.execs.get(id);
    const cancelled = (): JournalResult => ({ outcome: 'cancelled', reason: cancel.reason || 'cancelled', bootId: this.bootIdValue });
    if (exec) {
      if (exec.phase === 'running') {
        // The side effect started: its real outcome is reported (never hidden).
        exec.cancelRequested = true;
        this.log('command.cancel', { id, effect: 'too-late' });
        return;
      }
      if (exec.phase === 'queued') {
        const queue = proc.queues.get(exec.lane)!;
        queue.splice(queue.indexOf(exec), 1);
      }
      exec.timer?.cancel();
      const result = cancelled();
      complete(this.journalValue, id, result, this.localNow());
      this.log('command.cancel', { id, effect: 'cancelled' });
      this.release(exec);
      this.sendResult(session, id, result);
      this.pump(exec.lane);
      return;
    }
    const waiting = proc.deferred.get(id);
    if (waiting) {
      waiting.timer?.cancel();
      proc.deferred.delete(id);
      const result = cancelled();
      this.journalValue.putCommand({
        ...this.deliveryOf(waiting.body),
        state: 'done',
        incarnation: proc.incarnation,
        result,
        resultAcked: false,
        updatedAt: this.localNow(),
      });
      this.log('command.cancel', { id, effect: 'cancelled-deferred' });
      this.sendResult(session, id, result);
      return;
    }
    this.log('command.cancel', { id, effect: 'unknown' });
  }

  /** A journaled result as the CommandUpdate that reports (or replays) it. */
  private updateOf(id: string, result: JournalResult): CommandUpdate {
    const update = create(CommandUpdateSchema, {
      commandId: id,
      state: OUTCOME_STATE[result.outcome],
      result: result.payload ?? new Uint8Array(),
      bootId: result.bootId ?? this.bootIdValue,
      rebooted: result.rebooted === true,
    });
    if (result.outcome === 'rejected') update.rejectReason = rejectionCode(result.reason);
    if (result.outcome === 'failed')
      update.error = create(CommandErrorSchema, { code: result.reason ?? 'internal', message: result.message ?? '' });
    // "This node says" (§6, §13): the node key signs the update, so the gateway cannot alter it.
    if (this.attestedResults.has(id) && this.nodeKey)
      update.nodeSig = signCommandUpdate(this.nodeKey, { commandId: id, state: update.state, result: update.result });
    return update;
  }

  private sendResult(session: Session | undefined, id: string, result: JournalResult): void {
    this.send(session, { case: 'update', value: this.updateOf(id, result) } as AgentFrame['msg']);
  }

  private sendUpdate(id: string, state: CommandState): void {
    this.send(this.proc?.session, {
      case: 'update',
      value: { commandId: id, state, bootId: this.bootIdValue },
    } as AgentFrame['msg']);
  }

  // ---- desired state ----------------------------------------------------------------------------

  private onDesired(session: Session, desired: DesiredState): void {
    const proc = this.requireProcess();
    let body;
    try {
      body = unwrapDesiredState(desired);
    } catch (error) {
      this.log('spec.undecodable', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (body.nodeId !== this.nodeId) {
      this.log('spec.ignored', { why: 'node-id', nodeId: body.nodeId });
      return;
    }
    const generation = Number(body.generation);
    const applied = this.appliedGeneration;
    if (generation <= applied) {
      this.log('spec.ignored', { why: 'stale', generation, applied });
      return;
    }
    let spec: NodeSpec;
    if (body.spec.case === 'patch') {
      if (Number(body.baseGeneration) !== applied || !proc.spec) {
        this.log('spec.patch-mismatch', { base: Number(body.baseGeneration), applied });
        this.send(session, {
          case: 'specRequest',
          value: { haveGeneration: BigInt(applied), reason: SpecRequestReason.PATCH_BASE_MISMATCH },
        } as AgentFrame['msg']);
        return;
      }
      spec = mergeSpec(proc.spec, body.spec.value);
    } else spec = body.spec.case === 'full' ? body.spec.value : create(NodeSpecSchema);
    // Go: intent.VerifyDesiredState. A gateway can relay a spec but not forge or alter one (P14).
    if (this.intentRoots) {
      const accessChanged = !equals(
        AccessSectionSchema,
        spec.access ?? create(AccessSectionSchema),
        proc.spec?.access ?? create(AccessSectionSchema),
      );
      // Any spec moves the applied generation forward, and a stale-generation check drops everything below
      // it: an unsigned spec with a huge generation would freeze the node's specs for good. So with roots
      // (the server signs every generation once it has a command-signing root) every spec must be signed;
      // 'access' is only for a control plane that still signs access changes alone.
      const required =
        this.options.intent?.signedSpecs === 'access' ? accessChanged : this.intentRoots.length > 0;
      try {
        verifyDesiredState(desired, {
          roots: this.intentRoots,
          now: this.serverNow(),
          nodeId: this.nodeId,
          required,
        });
      } catch (error) {
        const reason = isComputeError(error) ? String(error.details?.reason ?? error.message) : String(error);
        this.specRejectionsValue.push({ generation, reason });
        this.log('spec.bad-signature', { generation, reason });
        return;
      }
    }
    const full = create(DesiredStateBodySchema, {
      nodeId: body.nodeId,
      generation: body.generation,
      baseGeneration: 0n,
      specHash: body.specHash,
      spec: { case: 'full', value: spec },
      traceparent: body.traceparent,
    });
    this.journalValue.saveSpec({
      generation,
      hash: body.specHash,
      body: toBinary(DesiredStateBodySchema, full),
      signature: desired.signature ? toBinary(SignatureSchema, desired.signature) : new Uint8Array(),
    });
    this.journalValue.saveMeta({ ...this.journalValue.meta(), appliedGeneration: generation });
    proc.spec = spec;
    this.log('spec.apply', { generation, patch: body.spec.case === 'patch' });
    this.converge('spec');
    for (const { body: waiting } of [...proc.deferred.values()]) this.admit(waiting, true);
  }

  private observedAllocations(): Map<string, { deviceIds: string[]; generation: number; reservationId: string; kubernetes: boolean }> {
    const out = new Map<string, { deviceIds: string[]; generation: number; reservationId: string; kubernetes: boolean }>();
    for (const [path, text] of this.fs) {
      if (!path.startsWith(CDI_DIR)) continue;
      const spec = JSON.parse(text) as {
        annotations: Record<string, string>;
        devices: { name: string }[];
      };
      const id = spec.annotations['bcd.dev/allocation-id'];
      if (!id) continue;
      out.set(id, {
        deviceIds: spec.devices.map((d) => d.name),
        generation: Number(spec.annotations['bcd.dev/generation'] ?? 0),
        reservationId: spec.annotations['bcd.dev/reservation-id'] ?? '',
        kubernetes: spec.annotations['bcd.dev/binding'] === 'kubernetes',
      });
    }
    return out;
  }

  /**
   * The devices converger: releases holds no longer desired, keeps the ones still desired (rewriting
   * a missing env file), and binds new ones in spec order unless a device is missing or already
   * held (overlap → AllocationFailed, section FAILED). It never drops a hold on its own (P6).
   */
  private convergeDevices(
    section: DevicesSection | undefined,
    generation: number,
  ): { state: SectionState; reason?: string; message?: string } {
    const proc = this.requireProcess();
    const desired = section?.assignments ?? [];
    const observed = this.observedAllocations();
    const wantedIds = new Set(desired.map((a) => a.allocationId));
    const now = this.scheduler.now();
    const released = (allocationId: string, deviceIds: string[], gen: number) => {
      this.log('alloc.released', { allocation: allocationId, generation: gen });
      this.fact({ type: 'allocation.unbound', at: this.scheduler.now(), nodeId: this.nodeId, allocationId, deviceIds, generation: gen });
      this.emitEvent('transition', 'allocation.released', {
        case: 'attested',
        value: this.attested({ case: 'allocationReleased', value: { allocationId, generation: BigInt(gen), deviceIds } }),
      });
    };
    // Kubernetes releases whose pods let go: reported now (bcd's fail-closed InUse).
    for (const [allocationId, pending] of [...this.kubeReleasing]) {
      if (pending.until > now) continue;
      this.kubeReleasing.delete(allocationId);
      released(allocationId, pending.deviceIds, pending.generation);
    }
    for (const [allocationId, hold] of [...observed].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (wantedIds.has(allocationId)) continue;
      this.fs.delete(cdiSpecPath(allocationId));
      this.fs.delete(envFilePath(allocationId));
      observed.delete(allocationId);
      if (hold.kubernetes) {
        // Withdrawn from the kubelet at once; pods may keep the devices a while (claimed meanwhile).
        this.fact({ type: 'kube.withdrawn', at: now, nodeId: this.nodeId, allocationId, deviceIds: hold.deviceIds });
        const podMs = this.knobs.kubePodReleaseMs ?? 0;
        if (podMs > 0) {
          this.kubeReleasing.set(allocationId, { deviceIds: hold.deviceIds, generation, until: now + podMs });
          this.log('alloc.releasing', { allocation: allocationId, generation, podMs });
          this.later(podMs, () => this.converge('kube-release'));
          continue;
        }
      }
      released(allocationId, hold.deviceIds, generation);
    }
    const claimed = new Map<string, string>();
    for (const [allocationId, pending] of this.kubeReleasing)
      for (const id of pending.deviceIds) claimed.set(id, allocationId);
    for (const a of desired) {
      const hold = observed.get(a.allocationId);
      if (hold) for (const id of hold.deviceIds) claimed.set(id, a.allocationId);
    }
    const gpus = new Set(this.hw.gpuUuids);
    const failures: string[] = [];
    let progressing = false;
    const fail = (allocationId: string, reason: string, message: string) => {
      failures.push(`${allocationId}: ${reason}`);
      if (proc.failedAllocations.get(allocationId) === generation) return;
      proc.failedAllocations.set(allocationId, generation);
      this.log('alloc.failed', { allocation: allocationId, reason, generation });
      this.emitEvent('transition', 'allocation.failed', {
        case: 'allocationFailed',
        value: { allocationId, generation: BigInt(generation), reason, message },
      });
    };
    for (const assignment of desired) {
      const allocationId = assignment.allocationId;
      const ids = assignment.devices.map((d) => d.id);
      const hold = observed.get(allocationId);
      if (hold) {
        if (!this.fs.has(envFilePath(allocationId))) this.fs.set(envFilePath(allocationId), envFile(assignment));
        continue;
      }
      // A Kubernetes binding holds exactly like a hold; bcd's device plugin hands it to the kubelet.
      if (assignment.binding !== Binding.HOLD && assignment.binding !== Binding.KUBERNETES) {
        fail(allocationId, 'unsupported-binding', `binding ${Binding[assignment.binding]} is not supported in v0.1`);
        continue;
      }
      const foreign = assignment.devices.find((d) => d.deviceClass !== '' && d.deviceClass !== 'gpu');
      if (foreign) {
        fail(allocationId, 'unsupported-device', `device class ${foreign.deviceClass} cannot be held`);
        continue;
      }
      const missing = ids.filter((id) => !gpus.has(id));
      if (missing.length > 0) {
        fail(allocationId, 'device-missing', `${missing.join(', ')} not present`);
        continue;
      }
      const overlap = ids.find((id) => claimed.has(id) && claimed.get(id) !== allocationId);
      if (overlap !== undefined || new Set(ids).size !== ids.length) {
        fail(
          allocationId,
          'overlap',
          overlap !== undefined ? `${overlap} is assigned to ${claimed.get(overlap)}` : 'a device is listed twice',
        );
        continue;
      }
      if (this.knobs.cdiWriteFailures > 0) {
        this.knobs.cdiWriteFailures--;
        progressing = true;
        this.log('alloc.cdi-write-failed', { allocation: allocationId });
        continue;
      }
      this.fs.set(cdiSpecPath(allocationId), cdiSpec(assignment, generation));
      this.fs.set(envFilePath(allocationId), envFile(assignment));
      for (const id of ids) claimed.set(id, allocationId);
      proc.failedAllocations.delete(allocationId);
      this.log('alloc.bound', { allocation: allocationId, generation, devices: ids.length });
      this.fact({ type: 'allocation.bound', at: this.scheduler.now(), nodeId: this.nodeId, allocationId, deviceIds: ids, generation });
      if (assignment.binding === Binding.KUBERNETES)
        this.fact({ type: 'kube.advertised', at: this.scheduler.now(), nodeId: this.nodeId, allocationId, deviceIds: ids });
      this.emitEvent('transition', 'allocation.bound', {
        case: 'attested',
        value: this.attested({
          case: 'allocationBound',
          value: {
            allocationId,
            generation: BigInt(generation),
            deviceIds: ids,
            cdiDevices: ids.map((id) => `bcd.dev/gpu=${id}`),
            cdiSpecPath: cdiSpecPath(allocationId),
            envFile: envFilePath(allocationId),
          },
        }),
      });
    }
    if (progressing) return { state: SectionState.PROGRESSING, reason: 'CdiWriteFailed', message: 'retrying' };
    if (failures.length > 0) return { state: SectionState.FAILED, reason: 'AllocationFailed', message: failures.join('; ') };
    return { state: SectionState.CONVERGED };
  }

  /**
   * An AttestedReport for an allocation, signed with the node key when the daemon has one (as bcd
   * signs them from v0.2, so a gateway cannot forge a binding); unsigned otherwise (v0.1).
   */
  private attested(report: MessageInitShape<typeof AttestedReportBodySchema>['report']): AttestedReport {
    const body = create(AttestedReportBodySchema, { nodeId: this.nodeId, bootId: this.bootIdValue, report });
    return this.nodeKey ? signAttestedReport(this.nodeKey, body) : wrapAttestedReport(body);
  }

  // ---- events, status, inventory ----------------------------------------------------------------

  private emitEvent(cls: EventClass, kind: string, body: MessageInitShape<typeof EventSchema>['body']): void {
    const proc = this.requireProcess();
    const payload = toBinary(
      EventSchema,
      create(EventSchema, { observedAt: timestampFromMs(Math.floor(this.serverNow())), body }),
    );
    if (proc.overflow.length > 0 && cls !== 'metric') {
      proc.overflow.push({ class: cls, kind, payload });
      return;
    }
    try {
      const event = this.journalValue.appendEvent({ class: cls, kind, payload });
      this.sendEvents(proc.session, [event]);
    } catch (error) {
      if (!(error instanceof JournalError) || error.code !== 'FULL') throw error;
      if (cls === 'metric') {
        this.log('event.dropped', { kind });
        return;
      }
      proc.overflow.push({ class: cls, kind, payload });
      this.log('event.overflow', { kind, pending: proc.overflow.length });
    }
  }

  private retryOverflow(): void {
    const proc = this.requireProcess();
    while (proc.overflow.length > 0) {
      const next = proc.overflow[0]!;
      try {
        const event = this.journalValue.appendEvent(next);
        proc.overflow.shift();
        this.sendEvents(proc.session, [event]);
      } catch (error) {
        if (error instanceof JournalError && error.code === 'FULL') return;
        throw error;
      }
    }
  }

  private sendUnackedEvents(session: Session): void {
    this.sendEvents(session, this.journalValue.unackedEvents());
  }

  private sendEvents(session: Session | undefined, events: readonly { seq: number; payload: Uint8Array }[]): void {
    if (!session?.welcomed || events.length === 0) return;
    const journalId = this.journalId;
    for (let i = 0; i < events.length; i += EVENT_BATCH) {
      const batch: Event[] = events.slice(i, i + EVENT_BATCH).map((e) => {
        const event = fromBinary(EventSchema, e.payload);
        event.seq = BigInt(e.seq);
        return event;
      });
      this.send(session, { case: 'events', value: { journalId, events: batch } } as AgentFrame['msg']);
    }
  }

  /**
   * The VPS host's IMDS (§12.2, §13; v0.5) answering a request from `instanceId`'s own interface:
   * IMDSv2-style session tokens bound to that instance, and its workload token, minted by the control
   * plane through a WorkloadTokenRequest on this node's session. A host answers only instances it
   * runs (404 otherwise), and never for another instance than the one the request came from.
   */
  async handleImds(request: Request, instanceId: string): Promise<Response> {
    const domain = this.hypervisor?.domains.get(instanceId);
    if (!domain?.managed || domain.state !== 'running')
      return new Response('No such instance on this host', { status: 404 });
    this.imdsService ??= new FakeImds({
      now: () => this.serverNow(),
      mint: (mint) => this.requestWorkloadToken(mint.instanceId, mint.audience),
    });
    return this.imdsService.handle(request, instanceId);
  }

  /** Asks the control plane for an instance's workload token (sealed to a one-time key). */
  private requestWorkloadToken(
    instanceId: string,
    audience?: string,
  ): Promise<{ token: string } | { error: string }> {
    const session = this.proc?.session;
    if (!session?.welcomed || session.conn.closed || !this.nodeKey) return Promise.resolve({ error: 'unavailable' });
    const { request, ephemeralKey } = createWorkloadTokenRequest({
      nodeKey: this.nodeKey,
      instanceId,
      ...(audience !== undefined ? { audience } : {}),
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.workloadRequests.delete(request.requestId);
        resolve({ error: 'unavailable' });
      }, 10_000);
      this.workloadRequests.set(request.requestId, {
        instanceId,
        key: ephemeralKey,
        settle: (result) => {
          clearTimeout(timer);
          this.workloadRequests.delete(request.requestId);
          resolve(result);
        },
      });
      this.log('workload.request', { instance: instanceId, audience: audience ?? '' });
      if (!this.send(session, { case: 'workloadTokenRequest', value: request }))
        this.workloadRequests.get(request.requestId)?.settle({ error: 'unavailable' });
    });
  }

  /**
   * Sends a SecretRequest for an instance's user data (signed with the node key, bound to its
   * allocation); false while it cannot (no session yet, or no node key to sign with).
   */
  private fetchUserData(request: UserDataFetch): boolean {
    const session = this.proc?.session;
    if (!session?.welcomed || session.conn.closed || !this.nodeKey) return false;
    const { request: frame, ephemeralKey } = createSecretRequest({
      nodeKey: this.nodeKey,
      ref: request.ref,
      ...(request.allocationId ? { allocationId: request.allocationId } : {}),
    });
    this.secretRequests.set(frame.requestId, { ref: request.ref, key: ephemeralKey });
    this.log('secret.request', { ref: request.ref, instance: request.instanceId });
    return this.send(session, { case: 'secretRequest', value: frame });
  }

  private sendStatus(): void {
    const proc = this.proc;
    if (!proc?.lastStatus) return;
    const value = {
      ...proc.lastStatus,
      ...(this.pressure ? { pressure: this.pressure } : {}),
      ...(this.discovered ? { discovered: this.discovered } : {}),
      // A VPS host with a volume store reports it (bcd: its data directory's filesystem).
      ...(this.hypervisor?.volumeStorage() ? { volumeStorage: this.hypervisor.volumeStorage() } : {}),
      // A bundle applied from Welcome.trust after Hello is acknowledged here, without a reconnect.
      ...(this.intentVersion !== undefined && !this.options.profile?.withoutHello?.includes('trustVersion')
        ? { trustVersion: this.intentVersion, ...this.heldApproverSet() }
        : {}),
    };
    this.send(proc.session, { case: 'status', value } as AgentFrame['msg']);
  }

  private pressure: MessageInitShape<typeof HostPressureSchema> | undefined;

  /**
   * Sim: the host's PSI and CPU steal (`StatusReport.pressure`, §10.1 Disk/Memory/CpuPressure), in
   * every StatusReport from now on; `undefined` stops reporting it. The current report is re-sent.
   */
  setPressure(pressure: MessageInitShape<typeof HostPressureSchema> | undefined): void {
    this.pressure = pressure;
    this.sendStatus();
  }

  private discovered: MessageInitShape<typeof DiscoveredMachineSchema>[] | undefined;

  /**
   * Sim, site agents: the unknown machines that PXE-booted (`StatusReport.discovered`, bcd's
   * discovery list), in every StatusReport from now on; `undefined` stops reporting them. Times are
   * milliseconds since the epoch (default: now); the current report is re-sent.
   */
  setDiscovered(
    machines:
      | readonly {
          mac: string;
          productUuid?: string;
          arch?: string;
          firstSeen?: number;
          lastSeen?: number;
          count?: number;
          relay?: string;
        }[]
      | undefined,
  ): void {
    const now = Math.floor(this.serverNow());
    this.discovered = machines?.map((m) => ({
      mac: m.mac.toLowerCase(),
      productUuid: (m.productUuid ?? '').toLowerCase(),
      arch: m.arch ?? '',
      firstSeen: timestampFromMs(m.firstSeen ?? now),
      lastSeen: timestampFromMs(m.lastSeen ?? now),
      count: m.count ?? 1,
      relay: m.relay ?? '',
    }));
    this.sendStatus();
  }

  private collect(rescan: boolean): EncodedSection[] {
    const proc = this.requireProcess();
    if (rescan || proc.collected.sections.length === 0) {
      const lacks = new Set<string>(this.options.profile?.withoutInventory ?? []);
      const sections = encodeInventorySections(this.hw.inventory).filter((section) => !lacks.has(section.name));
      proc.collected = { sections, at: this.localNow() };
    }
    return proc.collected.sections;
  }

  private sendInventory(sections: readonly EncodedSection[]): void {
    const proc = this.requireProcess();
    for (const s of sections)
      this.send(proc.session, {
        case: 'inventory',
        value: {
          section: s.name,
          sha256: s.sha256,
          content: s.content,
          collectedAt: timestampFromMs(Math.floor(proc.collected.at + proc.offsetMs)),
          schemaVersion: 1,
        },
      } as AgentFrame['msg']);
  }

  private kindContext(body: CommandBody): FakeKindContext {
    return {
      nodeId: this.nodeId,
      bootId: this.bootIdValue,
      daemonVersion: this.daemonVersion,
      hardware: this.hw,
      knobs: this.knobs,
      body,
      now: () => this.serverNow(),
      collectInventory: (rescan) => this.collect(rescan),
      sendInventory: (sections) => this.sendInventory(sections),
      assignedDevices: () => this.assignedDevices(),
      upload: (url, bytes) => this.uploads.set(url, bytes),
      ...(this.hypervisor
        ? {
            snapshot: (instanceId: string, includeMemory: boolean) =>
              this.hypervisor!.snapshot(instanceId, includeMemory),
          }
        : {}),
    };
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private newJournal(): MemoryJournal {
    return new MemoryJournal(this.nodeId, {
      ...this.options.journal,
      newJournalId: () => `jrn_${this.rng.hex(16)}`,
    });
  }

  private localNow(): number {
    return this.scheduler.now() + (this.options.clockSkewMs ?? 0);
  }

  private runtime(): Runtime {
    return { bootId: this.bootIdValue, incarnation: this.requireProcess().incarnation, now: this.localNow() };
  }

  private deliveryOf(body: CommandBody): Delivery {
    return { id: body.id, kind: body.kind, retrySafe: body.retrySafe, selfTerminating: body.selfTerminating };
  }

  private identityOf(body: CommandBody) {
    return {
      at: this.scheduler.now(),
      nodeId: this.nodeId,
      commandId: body.id,
      kind: body.kind,
      retrySafe: body.retrySafe,
      selfTerminating: body.selfTerminating,
      journalId: this.journalId,
      incarnation: this.requireProcess().incarnation,
      bootId: this.bootIdValue,
    };
  }

  private identity(entry: JournalCommand) {
    return {
      at: this.scheduler.now(),
      nodeId: this.nodeId,
      commandId: entry.id,
      kind: entry.kind,
      retrySafe: entry.retrySafe,
      selfTerminating: entry.selfTerminating,
      journalId: this.journalId,
      incarnation: entry.incarnation,
      bootId: entry.bootId ?? this.bootIdValue,
    };
  }

  private requireProcess(): Process {
    if (!this.proc) throw new Error(`${this.nodeId}: the daemon is not running`);
    return this.proc;
  }

  /** A timer owned by the current process: cancelled on crash, and inert if the process changed. */
  private later(ms: number, fn: () => void): Timer {
    const proc = this.requireProcess();
    const timer = this.scheduler.after(ms, () => {
      proc.timers.delete(timer);
      if (this.proc !== proc) return;
      fn();
    });
    proc.timers.add(timer);
    return timer;
  }

  private every(ms: number, fn: () => void): void {
    const tick = () => {
      fn();
      this.later(ms, tick);
    };
    this.later(ms, tick);
  }

  private fact(fact: DaemonFact): void {
    this.options.facts?.record(fact);
  }

  private log(event: string, data?: Record<string, LogValue>): void {
    this.options.log?.add(this.nodeId, event, data);
  }
}

/** Section-level patch: every section SET in `patch` replaces the current one wholesale. */
export function mergeSpec(current: NodeSpec, patch: NodeSpec): NodeSpec {
  const merged = create(NodeSpecSchema);
  for (const field of NodeSpecSchema.fields) {
    const key = field.localName as keyof NodeSpec;
    const value = (patch[key] ?? current[key]) as never;
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  const patched = new Set((patch.$unknown ?? []).map((f) => f.no));
  const unknown = [...(current.$unknown ?? []).filter((f) => !patched.has(f.no)), ...(patch.$unknown ?? [])];
  if (unknown.length > 0) merged.$unknown = unknown;
  return merged;
}

/**
 * A hold's CDI spec, as bcd writes it (agent/devices.go): devices carry no env (several in one
 * container would each set NVIDIA_VISIBLE_DEVICES); a hold's spec sets the joined list once, and a
 * Kubernetes hold's spec none (the device plugin sets it per pod) but is marked bcd.dev/binding.
 */
function cdiSpec(
  assignment: { allocationId: string; reservationId: string; binding: Binding; devices: { id: string }[] },
  generation: number,
): string {
  const kubernetes = assignment.binding === Binding.KUBERNETES;
  const env = [`BCD_ALLOCATION_ID=${assignment.allocationId}`];
  if (!kubernetes) env.push(`NVIDIA_VISIBLE_DEVICES=${[...new Set(assignment.devices.map((d) => d.id))].join(',')}`);
  return JSON.stringify({
    cdiVersion: '0.6.0',
    kind: 'bcd.dev/gpu',
    annotations: {
      'bcd.dev/allocation-id': assignment.allocationId,
      'bcd.dev/reservation-id': assignment.reservationId,
      'bcd.dev/generation': String(generation),
      ...(kubernetes ? { 'bcd.dev/binding': 'kubernetes' } : {}),
    },
    devices: assignment.devices.map((d) => ({ name: d.id, containerEdits: {} })),
    containerEdits: { env },
  });
}

function envFile(assignment: { allocationId: string; reservationId: string; devices: { id: string }[]; env: string[] }): string {
  return [
    `BCD_ALLOCATION_ID=${assignment.allocationId}`,
    `BCD_RESERVATION_ID=${assignment.reservationId}`,
    `NVIDIA_VISIBLE_DEVICES=${assignment.devices.map((d) => d.id).join(',')}`,
    ...assignment.env,
    '',
  ].join('\n');
}
