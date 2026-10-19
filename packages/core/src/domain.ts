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
   * Bare metal: bind a PXE MAC found by PXE discovery at once, without `metal.confirmMac`. Only for a
   * provisioning network no untrusted host can reach: any host on it can claim a machine's UUID from its
   * own MAC and boot the machine's ramdisk with its discovery token (the ramdisk's inventory is still
   * checked against the machine's UUID before anything is written).
   */
  trustProvisioningNetwork?: boolean;
  /**
   * Fractional-GPU parameters for `timeslice` and `mps` pools (§10.6): slot atoms per GPU
   * (defaults: timeslice 4, mps 10). Ignored by `exclusive` and `mig` pools.
   */
  sharing?: { replicas?: number };
  /** `mig` pools: the MIG layout the `mig-layout` config unit applies (e.g. `all-1g.10gb`, `mixed:3g.40gb+2x2g.20gb`). */
  migLayout?: string;
  /**
   * (platform compute billing) How provider instances in this pool are billed. Default: `metered`, or
   * `platform-fee` for a provider account owned by a tenant other than the root.
   */
  billing?: { mode: 'metered' | 'platform-fee' | 'none' };
  /**
   * `dedicated-root` pools (v0.5): reservations may use `binding: 'node'`; nodes are leased whole
   * and deployed by metal with the reservation's profile, then wiped on release.
   */
  tenantRoot?: boolean;
  /** (v0.3) The vps runtime driver this pool's hosted instances run on (default: vps()'s first runtime). */
  runtime?: string;
  /** (v0.3) Only one tenant besides the owner may be offered this pool; set for container runtimes (§13). */
  singleTenant?: boolean;
  /**
   * (v0.5) Hosted instances may get workload identity tokens from their host's IMDS (§12.2, §13);
   * off by default.
   */
  workloadIdentity?: boolean;
  /**
   * (v1.1 §3.8) What each host keeps for itself, out of its bookable CPU and memory (default 2 CPUs
   * and 8 GiB); hugepage pools come out of memory on top of it.
   */
  hostReserve?: { vcpu?: number; memoryGiB?: number };
  /**
   * (v1.1 §3.8) The CPU and memory a GPU reservation gets per GPU when it asks for none (default: the
   * node's allocatable CPU and memory divided by its bookable GPUs).
   */
  perGpu?: { vcpu?: number; memoryGiB?: number };
  /** (v1.1 §3.8) Hugepage pools the `hugepages` config unit reserves on each host (per NUMA node when `perNuma`). */
  hugepages?: { size: '2Mi' | '1Gi'; count: number; perNuma?: boolean };
  /**
   * (v1.1 §3.8) The `cpu` config unit on each host: the cpufreq governor, and CPUs isolated from the kernel
   * scheduler (cpulist, never CPU 0; effective after a reboot) that pinned VMs and holds book first.
   */
  cpu?: { governor?: 'performance' | 'schedutil' | 'ondemand' | 'powersave'; isolate?: string };
  /**
   * (v0.5 §13) The attestors that may admit a machine into this pool, by id (`join-token`, `tpm`, `x509pop`, …):
   * a join or reclaim admitted by any other is refused (`security.join.refused`, reason `pool-attestor`), and a
   * node moves into the pool only with an attestor binding (`node_bindings`) by one of them. Unset: any.
   */
  joinAttestors?: string[];
  /** (v1.1 §3.8) The `iommu` config unit: the IOMMU for GPU passthrough to VMs (effective after a reboot). */
  iommu?: { passthrough?: boolean };
  /** (v1.1 §3.8) The `gpu-settings` config unit: each GPU's power cap and ECC mode. */
  gpu?: { powerLimitWatts?: number; ecc?: boolean };
  /**
   * (v1.1 §3.8) The pool's machines join this Kubernetes cluster (the `k8s-join` config unit), and
   * reservations may use `binding: 'kubernetes'`: their devices go to the kubelet through bcd's device
   * plugin, and only those. `joinTokenRef` is a `secret://` ref of a kubeadm bootstrap token.
   */
  kubernetes?: {
    /**
     * The cluster the machines join (the `k8s-join` unit): `apiServer`, `caCertSha256` and `joinTokenRef`
     * together, or none of them for a pool whose bcd runs as a DaemonSet inside the cluster already
     * (provider-kubernetes).
     */
    apiServer?: string;
    /** `sha256:<hex>` of the cluster CA's public key (kubeadm's `--discovery-token-ca-cert-hash`). */
    caCertSha256?: string;
    joinTokenRef?: string;
    /** Extra labels for the machines' Node objects (keys under `bcd.dev/` are bcd's own). */
    labels?: Record<string, string>;
    /** Taints as `key=value:Effect`. */
    taints?: string[];
    /** The kubelet/kubeadm release the `k8s-join` unit installs, e.g. `1.34.1` (default: the node's packages). */
    kubernetesVersion?: string;
    /** GPUs through containerd's NVIDIA runtime and CDI (default true). */
    gpu?: boolean;
    /**
     * How bound GPUs reach pods: bcd's kubelet device plugins (`bcd.dev/gpu[.mig|.slot]`, the default)
     * or its DRA driver `gpu.bcd.dev` (ResourceSlices of only the bound devices; Kubernetes ≥ 1.32).
     * A node runs one of them, never both.
     */
    gpuApi?: 'device-plugin' | 'dra';
    /**
     * The platform runs this cluster: a bcd DaemonSet joining with a `hosted: 'kubernetes'` token lands its
     * node at the pool's trust instead of `tenant-controlled` (core/0027). Only the pool decides it, never
     * the node or the token alone.
     */
    platformOperated?: boolean;
  };
  /** (v1.1) Where the pool's hosts export GPU and host metrics (OTLP); wins over the deployment's. */
  telemetry?: TelemetrySpec;
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
  /** What a spent budget does to this offer (`suspend`: stop its running instances and refuse new work). */
  onBudgetExceeded?: 'notify' | 'stop-new' | 'drain' | 'suspend';
  /** Set while the offer is suspended: new work is refused with `SPEND_LIMIT_REACHED`. */
  suspendedAt?: number;
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

/**
 * `hold`: CDI devices for an operator-run workload manager (v0.1); `instance`: VPS; `node`: tenant deploy
 * (v0.5); `kubernetes`: given to the node's kubelet on a pool with `policy.kubernetes` (v1.1 §3.8).
 */
export type ReservationBinding = 'hold' | 'instance' | 'node' | 'kubernetes';

/**
 * (v1.1 §3.8) Host scalars booked with a reservation's devices, by resource name: `vcpu` (logical
 * CPUs, the same resource vps hosts book), `memoryGiB`, `hugepages1Gi` (pages). A record, as
 * capacity books any `node_resources` name.
 */
export type ReservationResources = Record<string, number>;

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
  /**
   * (v1.1 §3.8) Host CPU and memory to book with the devices (per node for gangs); absent: the pool's
   * `policy.perGpu` share. Enforced on the node (cgroup limits for holds, the kubelet for Kubernetes).
   */
  resources?: ReservationResources;
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
/**
 * What a reservation stores of its request (the admission-only fields removed), plus `hostShare`:
 * the host CPU and memory its GPUs carry without quota (the pool's per-GPU share at creation, §3.8);
 * `resources` above it are charged to quota.
 */
export type ReservationSpec = Omit<ReservationRequest, 'tenantId' | 'idempotencyKey' | 'wait'> & {
  hostShare?: ReservationResources;
};

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
  /**
   * (v1.1 §3.8) The cgroup-v2 slice the workload must run in to get the booked CPU, memory and
   * hugepages (e.g. `bcd-alloc-<allocation>.slice`); absent when the reservation booked none.
   */
  cgroupParent?: string;
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
  /** `volume` (v1.1, agent memory): a persistent volume's disk, scalar resources only. */
  owner: { kind: 'reservation' | 'instance' | 'volume'; id: string };
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
  /**
   * (platform compute billing) A whole-shape meter (`flavor.<…>.hours`, one unit per hour) that replaces the
   * composed vCPU, memory and GPU lines.
   */
  billing?: { meter?: string };
  /**
   * (v1.1 §3.8) Where the guest lives on the host: `numaAffine` keeps vCPUs and memory on one NUMA node
   * (its GPUs' when it has any), `pinned` gives each vCPU its own host CPU, `hugepages` backs guest
   * memory with hugepages of that size. Sandbox templates inherit their flavor's.
   */
  placement?: { numaAffine?: boolean; pinned?: boolean; hugepages?: '2Mi' | '1Gi' };
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
  /** `attached`: a provider machine that existed before (`instances.attach`); default `created`. */
  origin?: 'created' | 'attached';
  /** What deleting does to a provider machine: `delete` it, or `detach` (it keeps running). */
  onDelete?: 'delete' | 'detach';
  /** The tenant network (`networks.create`) the instance's machine is on. */
  networkId?: string;
  /** The subnet of that network it is in. */
  subnetId?: string;
  /** Provider labels the tenant asked for at create (provider pools; better-compute's own are not shown). */
  labels?: Record<string, string>;
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
  /** (v1.1 §3.8) The CPU, memory and hugepages booked with the devices, enforced by the host. */
  limits?: ResourceLimits;
}

/** (v1.1 §3.8) Host resources an allocation may use, as bcd applies them (cgroup v2). */
export interface ResourceLimits {
  /** cpuset.cpus, cpulist form. */
  cpus?: string;
  /** cpuset.mems: the NUMA nodes memory comes from. */
  mems?: string;
  /** cpu.max, in thousandths of a CPU. */
  cpuMillis?: number;
  /** memory.max (memory.high is set at 90%). */
  memoryBytes?: number;
  hugepages2Mi?: number;
  hugepages1Gi?: number;
}

/** (v1.1 §3.8) Where a VM's vCPUs and memory live on its host. */
export interface InstancePlacement {
  /** Host CPUs for the vCPUs (cpulist); exactly `vcpu` of them pins vCPU i to the i-th. */
  cpus?: string;
  /** NUMA nodes the guest memory is bound to. */
  mems?: string;
  /** Hugepage backing: 2097152 or 1073741824. */
  hugepageSizeBytes?: number;
  /** A virtio balloon, never with hugepages. */
  balloon?: boolean;
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
  /** The instance's allocation: the host names it in SecretRequest to fetch `userData` (§6). */
  allocationId?: string;
  /** NICs with their IPAM addresses (CIDR form), in the guest's interface order. */
  nics?: InstanceNicSpec[];
  /**
   * (v0.5, sandboxes §3.7) Boot from this snapshot (an `instance.snapshot` upload) instead of
   * `image`: disk and, when captured, memory. The host verifies `sha256` and fails the instance on
   * a runtime or CPU model mismatch.
   */
  restoreFrom?: { url: string; sha256: string; imageId: string };
  /**
   * (v0.5, sandboxes §3.7) What the instance's NICs may reach, enforced by the host on its taps:
   * `egress` (the default: anything the pool's network allows), `private` (the pool's IPAM subnet
   * and the host) or `none` (the host only; tunnels still work).
   */
  networkPolicy?: 'egress' | 'private' | 'none';
  /**
   * (review 13 H2) After a restore: a secret ref of the guest's new identity material (SSH host keys,
   * machine id, workload credentials), delivered by bcd; it reports the ref back once the guest acked.
   */
  identityRebindRef?: string;
  /** (review 13 L5) The guest's port 22 is reachable from the host only (bcd's tunnel dial). */
  sshFromHostOnly?: boolean;
  /** (v1.1 §3.8) Pinned CPUs, NUMA-bound memory, hugepages, balloon. */
  placement?: InstancePlacement;
  /** (v1.1, agent memory) Host volumes attached as extra virtio disks, in order. */
  volumes?: { volumeId: string; readOnly?: boolean }[];
}
/** One instance NIC: the host bridge or network, its MAC and its IPAM addresses. */
export interface InstanceNicSpec {
  network: string;
  mac: string;
  addresses: string[];
  /** (v1.1) The IPAM range's gateway: the guest's default route. */
  gateway?: string;
  /** (v1.1) DNS servers; absent: the guest keeps its image's. */
  nameservers?: string[];
}
/** Empty in v0.1; from v0.3 the SSH CA principals and exec-ticket JWKS. */
export interface AccessSpec {
  sshCaPublicKeys?: string[];
  /** Certificate principals this node accepts (`<account>@<nodeId>`), so a certificate is node-bound. */
  sshPrincipals?: string[];
  /** Serials (decimal strings, uint64) of revoked, unexpired break-glass certificates: the node's KRL. */
  sshRevokedSerials?: string[];
  execTicketJwks?: Json;
}
export interface TelemetrySpec {
  otlpEndpoint?: string;
  intervalSeconds?: number;
  /** A `secret://` ref of the exporter's auth headers; bcd fetches it through the broker. */
  headersRef?: string;
  /** Extra OTLP resource attributes. */
  resourceAttributes?: Record<string, string>;
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
  /** (v0.2 §11.5) Verified catalog images the site cache pre-warms; `sha256` is hex. */
  cacheImages?: { url: string; sha256: string; format: ImageFormat }[];
  /**
   * (review 7 HIGH-1) The machines `site.httpProxy` may reach through this agent, with their
   * addresses (IP literals or DNS names, never a BMC). The agent refuses any other target.
   */
  proxyTargets?: { nodeId: string; addresses: string[] }[];
}

/**
 * One module's NodeSpec contribution. Sections merge across modules; `site` merges field by field
 * (SiteBoot contributes `boot`, provision `cacheImages`), the last contribution per field winning.
 */
export type NodeSpecPart = Omit<Partial<NodeSpec>, 'site'> & { site?: Partial<SiteSpec> };

/** Generation-numbered desired state; the daemon converges each section idempotently. */
export interface NodeSpec {
  generation: number;
  host?: HostSpec;
  devices?: DevicesSpec;
  instances?: InstanceSpec[];
  /**
   * (v1.1, agent memory) Persistent volumes kept on this host (the instances section's `volumes`):
   * bcd creates missing ones and destroys unlisted ones no instance attaches.
   */
  volumes?: HostVolumeSpec[];
  access?: AccessSpec;
  telemetry?: TelemetrySpec;
  daemon?: DaemonSpec;
  site?: SiteSpec;
}

/** (v1.1) A persistent volume on a host. */
export interface HostVolumeSpec {
  id: string;
  sizeBytes: number;
  /** virtio-blk serial, ≤20 bytes of [a-z0-9-]: the guest's /dev/disk/by-id/virtio-<serial>. */
  serial: string;
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
