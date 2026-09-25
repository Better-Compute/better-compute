// Domain types (PLAN.md §2). Records carry epoch-millisecond timestamps; nullable columns are
// optional properties. Tenant-scoped records always carry `tenantId` (or `ownerTenantId`).

import type { Duration } from './duration.js';
import type { DriverConcern, RunsOn } from './extension.js';
import type { ErrorCode } from './errors.js';
import type {
  CommandState,
  Connectivity,
  InstanceDesiredState,
  InstanceState,
  ProvisionState,
  ReservationState,
  StepState,
  WorkflowState,
} from './states.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A delivery phase of the roadmap (§16). */
export type Phase = 'v0.1' | 'v0.2' | 'v0.3' | 'v0.4' | 'v0.5' | 'v1.0';

/** The certificate role an agent runs under (`bcd node`, `bcd site`, `bcd ramdisk`). */
export type AgentRole = 'node' | 'site' | 'ramdisk';

/** Half-open time range `[start, end)` in epoch milliseconds (a `tstzrange`). */
export interface TimeRange {
  start: number;
  end: number;
}

// --- Regions, sites, pools, offerings -----------------------------------------------------------

/** A geographic label in better-iam's region-name grammar; sites store it as `iamRegion`. */
export interface Region {
  name: string;
  iamRegion?: string;
}

/** `shared` and `dedicated` sites are the platform's; `custom` sites hold a tenant's own hardware (D11). */
export type SiteKind = 'shared' | 'dedicated' | 'custom';

/** A boot and failure domain served by at least one `bcd site` agent. */
export interface Site {
  id: string;
  ownerTenantId: string;
  kind: SiteKind;
  region: string;
  iamRegion?: string;
  version: number;
}

export type PoolClass = 'metal-host' | 'metal-dedicated' | 'vps-host' | 'provider';
export type SharingMode = 'exclusive' | 'mig' | 'timeslice' | 'mps';
/** `bcd`: machines run the daemon; `none`: reached only through the provider API (`provider-api/v1`). */
export type PoolAgent = 'bcd' | 'none';

/** One acceptance check a node must pass before it is schedulable, e.g. `{ kind: 'diag.nvml' }`. */
export interface AcceptanceCheck {
  kind: string;
  with?: Record<string, Json>;
}

export interface PoolPolicy {
  /** Run on adoption and before `ready`; v0.1 supports `diag.nvml`. */
  acceptance?: AcceptanceCheck[];
  /** Overcommit ratios for scalar resources (`vcpu`, `memoryGiB`, …). GPUs are never overcommitted. */
  overcommit?: Record<string, number>;
  /** When an unreachable node counts as lost; never applied automatically to metal (P6). */
  lostAfter?: Duration;
  /** Fraction of the pool that remediation, drains and rollouts may disrupt at once (default 0.05). */
  disruptionBudget?: number;
  admission?: {
    /** `meter` also calls `iam.billing.check` on each admission (+1 lock acquisition). */
    budgetCheck?: 'none' | 'meter';
  };
  /** How long a reservation may stay `pending` before it fails. */
  maxPending?: Duration;
  /** The hardware profile per-node driver bindings inherit from. */
  hardwareProfile?: string;
  /**
   * Fractional-GPU parameters for `timeslice` and `mps` pools (§10.6): slot atoms per GPU
   * (defaults: timeslice 4, mps 10). Ignored by `exclusive` and `mig` pools.
   */
  sharing?: { replicas?: number };
  /** `mig` pools: the MIG layout the `mig-layout` config unit applies (e.g. `all-1g.10gb`, `mixed:3g.40gb+2x2g.20gb`). */
  migLayout?: string;
  /**
   * `dedicated-root` pools (v0.5): reservations may use `binding: 'node'`; nodes are leased whole
   * and deployed by metal with the reservation's profile, then wiped on release.
   */
  tenantRoot?: boolean;
}

/** A scheduling and policy domain in one site, with exactly one GPU model. */
export interface Pool {
  id: string;
  ownerTenantId: string;
  siteId: string;
  class: PoolClass;
  gpuModel?: string;
  sharing: SharingMode;
  agent: PoolAgent;
  /** Set when the pool's backend is a provider account; absent means the platform's own fleet. */
  providerAccountId?: string;
  policy: PoolPolicy;
  version: number;
}

/** A `pool_offers` row: makes a pool exist in a tenant's view, with quota and priority. */
export interface Offering {
  poolId: string;
  tenantId: string;
  includeDescendants: boolean;
  /** Maximum per resource (`gpu`, `vcpu`, …); a missing resource grants 0. */
  quota: Record<string, number>;
  priority?: number;
  /** IAM regions the tenant's data may live in, until better-iam has `tenant.region`. */
  allowedRegions?: string[];
  onBudgetExceeded?: 'notify' | 'stop-new' | 'drain';
}

// --- Nodes and devices --------------------------------------------------------------------------

export type NodeRole = 'unassigned' | 'host' | 'dedicated' | 'site';
export type NodeTrust = 'platform' | 'tenant-owned' | 'tenant-controlled';
export type PowerState = 'on' | 'off' | 'unknown';
/** Power actions (Redfish `ResetType`: On, ForceOff, GracefulShutdown, ForceRestart, GracefulRestart, PowerCycle, Nmi). */
export type PowerAction =
  | 'on'
  | 'off'
  | 'graceful-off'
  | 'reset'
  | 'graceful-restart'
  | 'cycle'
  | 'nmi';
/** How a release or commissioning erases disks. */
export type WipeMode = 'none' | 'quick' | 'secure-erase' | 'crypto-erase';

/** A condition such as `GpuCountMismatch`, `NodeUnreachable` or `ClockSkew`. */
export interface Condition {
  type: string;
  status: 'true' | 'false' | 'unknown';
  reason?: string;
  message?: string;
  since: number;
}

export type LabelSource = 'inventory' | 'operator' | 'system';
export interface Label {
  key: string;
  value: string;
  source: LabelSource;
}

/** A driver binding: a driver id, or a driver id with its config (validated by the driver's manifest). */
export type DriverBinding = string | { driver: string; config?: Record<string, Json> };
/** Per-concern driver bindings, inherited from the pool's hardware profile. */
export type NodeDriverBindings = Partial<Record<DriverConcern | (string & {}), DriverBinding>>;

/**
 * A machine: a server running `bcd` (or a site agent, `role: 'site'`). Its axes are orthogonal:
 * `provisionState` × `maintenance` × `cordoned` × `power` × `connectivity` × `conditions`.
 */
export interface Node {
  id: string;
  siteId: string;
  /** Absent for site agents and unassigned machines. */
  poolId?: string;
  ownerTenantId: string;
  role: NodeRole;
  provisionState: ProvisionState;
  /** Set while `provisionState` is `failed`: where the failure happened. */
  failedFrom?: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  power: PowerState;
  connectivity: Connectivity;
  conditions: Condition[];
  /** NoSchedule taints and conditions, written in the same transaction as their cause. */
  noScheduleReasons: string[];
  labels: Label[];
  trust: NodeTrust;
  /** The node adapter that reaches it: `bcd/v1`, `provider-api/v1`, later `agentless-ssh/v1`. */
  adapter: string;
  drivers: NodeDriverBindings;
  /** Hex sha256 of the normalized hardware identifiers (§8.3). */
  hardwareKey?: string;
  hardwareKeyTrusted: boolean;
  /** Desired-state generation, and the generation the node last reported converged. */
  generation: number;
  observedGeneration: number;
  version: number;
}
/** A stored node, as node adapters and module hooks receive it. */
export type NodeRecord = Node;
/** The minimal identification of a node for drivers and tunnels. */
export interface NodeRef {
  id: string;
  siteId: string;
  poolId?: string;
}

export type DeviceClass = 'gpu' | 'gpu.mig' | 'gpu.slot' | 'nic.vf' | 'disk' | 'node';
/** Typed device attributes (`gpuProduct`, `gpuModel`, `vramGiB`, `numaNode`, …). */
export type DeviceAttributes = Record<string, string | number | boolean>;

/**
 * A DRA-style device. MIG instances are `<gpuUuid>/gi<g>/ci<c>`, time-slice and MPS slots
 * `<gpuUuid>/s<k>`. Only atoms (`bookable`) are ever booked; a partitioned parent is not bookable.
 */
export interface Device {
  id: string;
  nodeId: string;
  parentId?: string;
  class: DeviceClass;
  bookable: boolean;
  healthy: boolean;
  attributes: DeviceAttributes;
}
/** A bookable device. */
export type Atom = Device & { bookable: true };

// --- Requests, reservations, allocations ---------------------------------------------------------

export type MatchOperator =
  | 'In'
  | 'NotIn'
  | 'Exists'
  | 'DoesNotExist'
  | 'Gt'
  | 'Gte'
  | 'Lt'
  | 'Lte';
export interface MatchExpression {
  /** A device attribute or node label, e.g. `gpuProduct` or `vramGiB`. */
  key: string;
  op: MatchOperator;
  values?: (string | number)[];
}
export interface DeviceSelector {
  matchExpressions: MatchExpression[];
}
/** How the devices of one request must be connected. */
export type Topology = 'any' | 'nvlink-all';

export interface DeviceRequest {
  class: DeviceClass;
  count: number;
  selector?: DeviceSelector;
  topology?: Topology;
  sharing?: SharingMode;
}

/** `hold`: CDI devices for an operator-run workload manager (v0.1); `instance`: VPS; `node`: tenant deploy (v0.5). */
export type ReservationBinding = 'hold' | 'instance' | 'node';

/** Wait for the operation to become terminal, up to `timeoutMs` (≤ 30000). */
export interface WaitOptions {
  timeoutMs: number;
}

/** The request body of `reservations.create`. */
/**
 * A multi-node (gang) request (§10.3): `devices` are per node, and the gang books `size` nodes that share one
 * value of the node label `topologyKey` (any nodes when unset), all or nothing, one allocation per node.
 */
export interface GangSpec {
  /** Nodes, 2..64. */
  size: number;
  /** A node label, e.g. `fabric.domain`, `rack`. */
  topologyKey?: string;
}

export interface ReservationRequest {
  tenantId: string;
  poolId: string;
  projectId?: string;
  devices: DeviceRequest[];
  topology?: Topology;
  gang?: GangSpec;
  /** Epoch milliseconds; absent means now. */
  start?: number;
  duration: Duration;
  binding?: ReservationBinding;
  /**
   * `binding: 'node'` (v0.5, tenantRoot pools): the metal profile deployed on the whole node for
   * the reservation's lifetime; `profileVersion` pins it (latest when absent).
   */
  node?: NodeBindingSpec;
  /** Makes the reservation renewable: `renew` must be called within every lease period. */
  leaseSeconds?: number;
  spot?: boolean;
  /** Scoped to `(tenant, caller identity)`. */
  idempotencyKey: string;
  wait?: WaitOptions;
}

/** What a `binding: 'node'` reservation deploys (metal `dedicated-root`). */
export interface NodeBindingSpec {
  profileId: string;
  profileVersion?: number;
}
/** What a reservation stores of its request (the admission-only fields removed). */
export type ReservationSpec = Omit<ReservationRequest, 'tenantId' | 'idempotencyKey' | 'wait'>;

export type OperationState = 'pending' | 'running' | 'succeeded' | 'failed';
/** The async operation behind a long call (§9.1); `wait` blocks until it is terminal. */
export interface Operation {
  id: string;
  state: OperationState;
  error?: { code: ErrorCode; message: string };
}

/** What `reservations.get` returns for a bound `hold`: CDI device names and the env file. */
export interface HoldBinding {
  nodeId: string;
  cdiDevices: string[];
  envFile: string;
}

export interface Reservation {
  id: string;
  tenantId: string;
  poolId: string;
  projectId?: string;
  state: ReservationState;
  request: ReservationSpec;
  /** The booked interval once placed. */
  during?: TimeRange;
  /** Renewable reservations: when the lease lapses unless renewed. */
  leaseExpiresAt?: number;
  ownerIdentityId: string;
  agentId?: string;
  delegationId?: string;
  idempotencyKey: string;
  conditions: Condition[];
  binding?: HoldBinding;
  operation?: Operation;
  version: number;
}

/** A placement on one node (one per node for gangs); owned by a reservation or an instance. */
export interface Allocation {
  id: string;
  tenantId: string;
  poolId: string;
  nodeId: string;
  owner: { kind: 'reservation' | 'instance'; id: string };
  /** Booked atom ids. */
  atoms: string[];
  /** Claimed scalar amounts (`vcpu`, `memoryGiB`, …). */
  resources: Record<string, number>;
  during: TimeRange;
}

/** One `device_bookings` row, guarded by `EXCLUDE (device_id WITH =, during WITH &&)`. */
export interface Booking {
  deviceId: string;
  allocationId: string;
  during: TimeRange;
}

// --- Instances, images, profiles, workflows -------------------------------------------------------

export interface Flavor {
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus?: number;
}

export interface Instance {
  id: string;
  tenantId: string;
  poolId: string;
  projectId?: string;
  flavor: string;
  imageId: string;
  sshKeys: string[];
  state: InstanceState;
  desiredState: InstanceDesiredState;
  nodeId?: string;
  allocationId?: string;
  /** Provider pools: the provider's machine id. */
  externalId?: string;
  addresses: string[];
  ownerIdentityId: string;
  idempotencyKey: string;
  conditions: Condition[];
  operation?: Operation;
  version: number;
}

export type ImageFormat = 'raw' | 'qcow2' | 'iso';
export type ImageCompression = 'none' | 'zstd' | 'gzip';

/** A signed, content-addressed artifact. */
export interface Image {
  id: string;
  tenantId: string;
  /** `name@version`, e.g. `ubuntu-24.04-server@2026.09`. */
  ref: string;
  format: ImageFormat;
  compression: ImageCompression;
  sha256: string;
  sizeBytes?: number;
  visibility: 'private' | 'public';
  /** Digest and signature checked against the tenant's signer allowlist. */
  verified: boolean;
  version: number;
}

/** One step of a profile, e.g. `{ use: 'power.setPower', on: 'site', with: { action: 'cycle' } }`. */
export interface ProfileStep {
  use: string;
  on?: RunsOn;
  with?: Record<string, Json>;
  timeout?: Duration;
  retries?: number;
  /** Self-terminating steps complete when the agent rejoins. */
  await?: 'rejoin';
  onFailure?: 'fail' | 'rescue' | 'continue' | ProfileStep;
  fallback?: string;
  when?: string;
}

/** A versioned provisioning template, immutable once used (built with `defineProfile` in provision). */
export interface ProfileDocument {
  id: string;
  version: number;
  target: 'metal' | 'vps';
  description?: string;
  entry?: 'adopt' | 'deploy';
  role?: 'host' | 'dedicated';
  drivers?: NodeDriverBindings;
  image?: { ref: string; format?: ImageFormat; compression?: ImageCompression };
  userData?: { kind: 'cloud-init' | 'ignition' | 'talos'; template: string };
  /** Config units that become desired state after join (`nvidia-driver`, `mig-layout`, …). */
  hostConfig?: Record<string, Record<string, Json>>;
  steps?: ProfileStep[];
  acceptance?: ProfileStep[];
  cleanup?: ProfileStep[];
  /** VPS profiles. */
  runtime?: string;
  flavors?: Record<string, Flavor>;
  network?: { mode: string; ipam?: string };
}

export interface Profile {
  id: string;
  tenantId: string;
  document: ProfileDocument;
  visibility: 'private' | 'public';
  /** Set once a workflow used this version; it is immutable from then on. */
  usedAt?: number;
  version: number;
}

/** A profile expanded for one target. */
export interface Workflow {
  id: string;
  tenantId: string;
  nodeId?: string;
  instanceId?: string;
  profileId: string;
  profileVersion: number;
  state: WorkflowState;
  /** The step running or waiting now. */
  stepId?: string;
  version: number;
}

export interface WorkflowStep {
  workflowId: string;
  /** Unique within the workflow. */
  id: string;
  index: number;
  driver?: string;
  /** What the step does: `power.setPower`, `deploy.deploy`, … */
  action: string;
  runsOn: RunsOn;
  args: Record<string, Json>;
  state: StepState;
  attempt: number;
  /** `wf:<workflowId>:<stepId>`. */
  idempotencyKey: string;
  commandId?: string;
  deadline?: number;
  result?: Json;
  await?: 'rejoin';
}

// --- Commands and desired state -----------------------------------------------------------------

/** Daemon worker lanes: `control` (4 workers), `provision` (2), `bulk` (1). */
export type Lane = 'control' | 'provision' | 'bulk';

/**
 * Structural stand-in for a protobuf message descriptor (`DescMessage` from `@bufbuild/protobuf`
 * satisfies it), so core stays dependency-free.
 */
export interface MessageDescriptor {
  readonly kind: 'message';
  readonly typeName: string;
}

/** One entry of the command-kind registry (§7.4). */
export interface CommandKindSpec {
  kind: string;
  lane: Lane;
  /** Safe to re-execute after a crash between accept and completion. */
  retrySafe: boolean;
  /** Ends the agent's process or boot (`node.reboot`, `boot.kexec`, `daemon.upgrade`); completes on rejoin. */
  selfTerminating?: boolean;
  /** The result is node-signed and verified before any transition (v0.2). */
  attested?: boolean;
  /** Must be signed from v0.2 (`wipe`, `deploy.*`, `firmware.*`, …). */
  destructive?: boolean;
  timeout: Duration;
  /** Agent roles allowed to run it. */
  roles: AgentRole[];
  payload: MessageDescriptor;
}

/** A command as the control plane hands it to a node adapter. */
export interface CommandEnvelope<P = unknown> {
  id: string;
  nodeId: string;
  seq: number;
  kind: string;
  lane: Lane;
  payload: P;
  /** The encoded `CommandBody` and, for signed kinds, its signature. */
  body: Uint8Array;
  signature?: Uint8Array;
  state: CommandState;
  attempt: number;
  notBefore: number;
  notAfter: number;
  minGeneration?: number;
  retrySafe: boolean;
  selfTerminating: boolean;
  attested: boolean;
  idempotencyKey: string;
  traceparent?: string;
}

/** A device assignment in the `devices` section: what the daemon exposes through CDI. */
export interface DeviceAssignment {
  allocationId: string;
  deviceIds: string[];
  /** Assignments end here even if the node never hears the release. */
  until?: number;
}

export interface HostSpec {
  /** Config units (`nvidia-driver`, `container-toolkit`, `mig-layout`, …). */
  config?: Record<string, Record<string, Json>>;
}
export interface DevicesSpec {
  assignments: DeviceAssignment[];
}
export interface InstanceSpec {
  id: string;
  desiredState: InstanceDesiredState;
  runtime: string;
  flavor: Flavor;
  image: { url: string; sha256: string; format: ImageFormat };
  userData?: string;
  deviceIds?: string[];
}
/** Empty in v0.1; from v0.3 the SSH CA principals and exec-ticket JWKS. */
export interface AccessSpec {
  sshCaPublicKeys?: string[];
  execTicketJwks?: Json;
}
export interface TelemetrySpec {
  otlpEndpoint?: string;
  intervalSeconds?: number;
}
export interface DaemonSpec {
  version: string;
  url: string;
  sha256: string;
  signature?: string;
}
/** Site agents: whether this agent holds the site's boot lease. */
export interface SiteSpec {
  boot: { active: boolean; epoch: number };
}

/** Generation-numbered desired state; the daemon converges each section idempotently. */
export interface NodeSpec {
  generation: number;
  host?: HostSpec;
  devices?: DevicesSpec;
  instances?: InstanceSpec[];
  access?: AccessSpec;
  telemetry?: TelemetrySpec;
  daemon?: DaemonSpec;
  site?: SiteSpec;
}

// --- Admission, audit, events, projects ---------------------------------------------------------

/**
 * The IAM decision context recorded for each allowed mutation, because better-iam does not audit
 * allows. Asynchronous work acts on it, never on stored tokens.
 */
export interface AdmissionContext {
  tenantId: string;
  identityId: string;
  identityKind: 'user' | 'service' | 'agent';
  sessionId: string;
  sessionKind: 'user' | 'role' | 'api-key' | 'session-token' | 'delegated';
  agentId?: string;
  delegationId?: string;
  requestId?: string;
  action: string;
  resource: { type: string; id: string };
  decidedAt: number;
}

/** One `audit_events` row: a mutation with its admission context, or a command/step/security event. */
export interface AuditRecord {
  id: string;
  tenantId: string;
  time: number;
  action: string;
  resource: { type: string; id: string };
  admission?: AdmissionContext;
  details?: Record<string, Json>;
}

/** A CloudEvents-style event delivered from the outbox (subscribers, SSE, webhooks). */
export interface ComputeEvent<D = Json> {
  id: string;
  /** `node.*`, `gpu.*`, `reservation.placed`, `instance.*`, `workflow.*`, `security.*`, … */
  type: string;
  tenantId: string;
  /** The resource the event is about, e.g. `reservation/rsv_…`. */
  subject: string;
  /** RFC 3339 timestamp. */
  time: string;
  /** The outbox cursor (`Last-Event-ID`). */
  sequence: string;
  data: D;
}

/** An app-owned grouping of a tenant's work. */
export interface Project {
  id: string;
  tenantId: string;
  name: string;
  state: 'active' | 'archived';
  version: number;
}

/** A `selfCheck` finding (mirrors better-iam's). */
export interface Finding {
  check: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  fix: string;
  count?: number;
}
