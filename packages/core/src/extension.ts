// Extension contracts (PLAN.md §5). Code registers kinds with `define*`; data configures instances.
// Every seam is a typed contract with a conformance suite; nothing here imports an implementation.

import type { ComputeResourceKind, ComputeResourceType } from './catalog.js';
import type { Clock } from './clock.js';
import type {
  AdmissionContext,
  AgentRole,
  Allocation,
  Atom,
  CommandEnvelope,
  CommandKindSpec,
  ComputeEvent,
  AuditRecord,
  Device,
  DeviceRequest,
  Finding,
  GangSpec,
  ImageCompression,
  ImageFormat,
  Json,
  NodeRecord,
  NodeRef,
  NodeRole,
  NodeSpec,
  NodeSpecPart,
  NodeTrust,
  PowerAction,
  ProfileDocument,
  ProfileStep,
  TimeRange,
  Topology,
} from './domain.js';
import type { Duration } from './duration.js';
import type { Caller, Credential, IamPort, UsageEvent, UsageResult } from './iam.js';
import type { Manifest, SecretRef } from './manifest.js';
import type { Migration, SqlExecutor, SqlTx } from './sql.js';
import type { Connectivity, ProvisionState } from './states.js';

/** Where code runs: in the control plane, or as a command on a site agent, node or ramdisk. */
export type RunsOn = 'control-plane' | 'site' | 'node' | 'ramdisk';

/** The Ironic concerns a driver can implement (§2). */
export type DriverConcern =
  | 'power'
  | 'management'
  | 'boot'
  | 'deploy'
  | 'inspect'
  | 'console'
  | 'virtual-media'
  | 'bios'
  | 'raid'
  | 'firmware'
  | 'config'
  | 'runtime';

/** What `define*` helpers stamp on their result, so the registry can tell extensions apart. */
export type ExtensionKind =
  | 'driver'
  | 'step'
  | 'scheduler'
  | 'attestor'
  | 'sink'
  | 'provider'
  | 'image-source'
  | 'node-adapter'
  | 'pool-policy';

/** Anything a module contributes through `extensions`. `kind:id@version` must be unique. */
export interface Extension {
  readonly extension: ExtensionKind;
  readonly id: string;
  readonly version?: string;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Progress a long driver or step operation reports. */
export interface Progress {
  phase?: string;
  message?: string;
  /** 0–100. */
  percent?: number;
  bytes?: { done: number; total?: number };
}

/**
 * (v1.0) Whose resource a value is resolved for: a tenant-owned provider account resolves its
 * credentials with its own tenant here. A store given a context refuses (`ACCESS_DENIED`) a ref that
 * is not that tenant's; without one it serves the ref as before.
 */
export interface SecretResolveContext {
  tenantId: string;
}

/** Resolves a `SecretRef` just in time; values live only in memory. */
export interface SecretResolver {
  resolve(ref: SecretRef, context?: SecretResolveContext): Promise<string>;
}

// --- Drivers -------------------------------------------------------------------------------------

/**
 * The operations of each driver kind, keyed by concern. Empty here and opened by declaration
 * merging: `metal` adds `power`, `management`, `boot`, `deploy`, `inspect`, `virtual-media`, …;
 * `vps` adds `runtime`.
 *
 * ```ts
 * declare module '@better-compute/core' {
 *   interface DriverKinds { power: { getPower(): Promise<'on' | 'off' | 'unknown'> } }
 * }
 * ```
 */
export interface DriverKinds {}

export interface DriverContext {
  /** The node acted on, when there is one (provider drivers may act on an account). */
  node?: NodeRef;
  /** Stable across retries of the same operation. */
  idempotencyKey: string;
  signal: AbortSignal;
  /** Epoch ms the operation must finish by, when the caller set one (carried to bcx plugins). */
  deadline?: number;
  /** W3C trace context of the calling step (carried to bcx plugins). */
  traceparent?: string;
  clock: Clock;
  secrets: SecretResolver;
  log: Logger;
  emit(progress: Progress): void;
}

/** A driver as written: several kinds together make an Ironic hardware type. */
export interface DriverInput<C, K extends keyof DriverKinds> {
  id: string;
  version: string;
  runsOn: RunsOn;
  config: Manifest<C>;
  capabilities?: readonly string[];
  implements: {
    [P in K]: (config: C, context: DriverContext) => DriverKinds[P] | Promise<DriverKinds[P]>;
  };
  /** Per kind, the operations safe to retry after an interruption. */
  retrySafe?: Partial<Record<K, readonly string[]>>;
  validate?(config: C, context: DriverContext): Promise<void>;
}

/**
 * A declared driver. With the default `K` (no kinds) it is the type of any driver, whatever it
 * implements, as registries and `ComputeOptions.drivers` hold them.
 */
export interface DriverDefinition<C = any, K extends keyof DriverKinds = never>
  extends DriverInput<C, K>,
    Extension {
  readonly extension: 'driver';
  readonly id: string;
  readonly version: string;
}

/** Declares a driver (§5.4). */
export function defineDriver<C, K extends keyof DriverKinds>(
  definition: DriverInput<C, K>,
): DriverDefinition<C, K> {
  return Object.freeze({ ...definition, extension: 'driver' as const });
}

// --- Scheduling ----------------------------------------------------------------------------------

/** What the placer is asked to find room for. */
export interface PlacementRequest {
  tenantId: string;
  poolId: string;
  projectId?: string;
  /** Exactly one of these owns the resulting allocations. */
  reservationId?: string;
  instanceId?: string;
  /** (v1.1, agent memory) A persistent volume's disk (vps `sandboxVolumes`): scalar resources, no devices. */
  volumeId?: string;
  devices: readonly DeviceRequest[];
  topology?: Topology;
  /** Multi-node placement: `devices` per node, `size` nodes sharing one `topologyKey` value (§10.3). */
  gang?: GangSpec;
  /** Scalar claims (`vcpu`, `memoryGiB`, `diskGiB`), multiplied by the pool's overcommit. */
  resources?: Readonly<Record<string, number>>;
  /** The image the placement will boot (VPS instances), for the `image-cached` scorer (§10.3). */
  imageId?: string;
  during: TimeRange;
  priority?: number;
  /** Nodes to leave out (a replan after a conflict). */
  excludeNodes?: readonly string[];
  /**
   * The only nodes the placement may use (e.g. the host an instance's persistent volumes live on);
   * absent: any node of the pool. `excludeNodes` still applies within them.
   */
  onlyNodes?: readonly string[];
  /**
   * Labels every candidate node must carry, with exactly these values, or with any value where the
   * value is `'*'` (e.g. a runtime a host's bcd advertised in Hello.drivers:
   * `{ 'bc.dev/driver.kata': '*' }`); absent: no label constraint.
   */
  nodeLabels?: Readonly<Record<string, string>>;
}

/** A scalar resource of a node (`node_resources`). */
export interface ScalarResource {
  allocatable: number;
  ratio: number;
  allocated: number;
}

/** GPU interconnect between two devices, best first (`nvidia-smi topo` order). */
export type GpuLink = 'NV' | 'PIX' | 'PXB' | 'PHB' | 'NODE' | 'SYS';

/** A read-only view of one candidate node, as filters and scorers see it. */
export interface NodeView {
  id: string;
  siteId: string;
  poolId: string;
  ownerTenantId: string;
  role: NodeRole;
  provisionState: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  connectivity: Connectivity;
  trust: NodeTrust;
  labels: Readonly<Record<string, string>>;
  noScheduleReasons: readonly string[];
  /** Every device, including partitioned parents (for topology). */
  devices: readonly Device[];
  /** Atoms free for the request's interval. */
  free: readonly Atom[];
  resources: Readonly<Record<string, ScalarResource>>;
  /** `links[a][b]`: the interconnect between devices `a` and `b`, when inventory reported it. */
  links?: Readonly<Record<string, Readonly<Record<string, GpuLink>>>>;
}

export interface SchedulerPluginInput {
  id: string;
  /** Admission hook, run before candidates are gathered; throw to refuse. */
  admit?(request: PlacementRequest, context: AdmissionContext): Promise<void>;
  filters?: {
    id: string;
    filter(request: PlacementRequest, node: NodeView): true | { reason: string };
  }[];
  scorers?: {
    id: string;
    weight?: number;
    score(request: PlacementRequest, node: NodeView): number;
  }[];
  preferAllocation?: {
    class: string;
    pick(request: DeviceRequest, free: Atom[], node: NodeView): Atom[] | undefined;
  }[];
}
export interface SchedulerPlugin extends SchedulerPluginInput, Extension {
  readonly extension: 'scheduler';
  readonly id: string;
}

/** Declares filters, scorers and atom pickers for the placement pipeline (§10.3). */
export function defineSchedulerPlugin(plugin: SchedulerPluginInput): SchedulerPlugin {
  return Object.freeze({ ...plugin, extension: 'scheduler' as const });
}

export interface SchedulerOptions {
  plugins?: SchedulerPlugin[];
  /** Scorer weights by id (`binpack`, `topology`, `spread`, …). */
  weights?: Record<string, number>;
  /** Pick at random among the best `topN` candidates (default 5). */
  topN?: number;
}

export interface PlacementContext {
  clock: Clock;
  /** Seeded in the simulator, so placements replay. */
  random(): number;
  plugins: readonly SchedulerPlugin[];
  weights: Readonly<Record<string, number>>;
  topN: number;
  admission?: AdmissionContext;
}

/**
 * `placed`: bookings, counters and allocations are written in `tx`. `pending`: nothing fit after
 * replanning (the reservation takes `Unschedulable`). `queued`: a batching placer took the request
 * and finishes it from its worker. Quota refusals throw `QUOTA_EXCEEDED`.
 */
export type PlacementOutcome =
  | { status: 'placed'; allocations: Allocation[] }
  | { status: 'pending'; reason: string }
  | { status: 'queued' };

/** One placement contract for the v0.1 inline placer and the v0.4 pool-lease placer. */
export interface Placer {
  readonly id: string;
  place(tx: SqlTx, request: PlacementRequest, context: PlacementContext): Promise<PlacementOutcome>;
}

// --- Node identity -------------------------------------------------------------------------------

/** Hardware identifiers a joining agent claims (compared with the token's `expect`). */
export interface HardwareClaims {
  productUuid?: string;
  serial?: string;
  macs?: readonly string[];
  gpuUuids?: readonly string[];
  hostname?: string;
  arch?: string;
}

/** Evidence an agent presents at `Join`, produced by the attestor of the same id. */
export interface AttestationEvidence {
  attestor: string;
  /** `join-token`: the token bytes; every other attestor: `JoinRequest.attestation`. */
  payload: Uint8Array;
  /** The opened sealed join token, whenever the request carried one (`provisioned`, `discovery` need it). */
  token?: string;
}

export interface AttestationContext {
  tx: SqlTx;
  clock: Clock;
  claims: HardwareClaims;
  /** SHA-256 of `JoinRequest.csr`; attestors that sign over the request (x509pop, cloud-iid) bind to it. */
  csrSha256?: Uint8Array;
  /**
   * SHA-256 of the CSR's SubjectPublicKeyInfo: the node key the certificate will certify (tpm checks
   * that the key its AK certified is this one).
   */
  csrSpkiSha256?: Uint8Array;
  /** The role the agent asks for. */
  role: AgentRole;
}

/** What a verified attestation establishes about the joining agent. */
export interface AttestationResult {
  tenantId: string;
  role: AgentRole;
  poolId?: string;
  siteId?: string;
  trust?: NodeTrust;
  /** A reclaim: the existing node the agent proved it is. */
  nodeId?: string;
  /** The join token consumed, if any. */
  tokenId?: string;
  /** Caps the certificate lifetime (ramdisk certs ≤ 2 h). */
  certTtlSeconds?: number;
  /** Restricts the command kinds the certificate allows. */
  allowedKinds?: readonly string[];
  /**
   * A stable hardware identity the attestor proved (tpm: sha256 of the EK public key). JoinService
   * binds it to the node after issuing (`node_bindings`, one node per `(attestor, subject)`); on a
   * later join the attestor finds the node by it and returns `nodeId`.
   */
  bind?: Uint8Array;
  /**
   * Where the attestor proved the node key lives: `tpm` when the machine's TPM certified the CSR's key
   * as one it made and never lets out (tpm, with its AK). Absent: not proven. JoinService records it
   * with the join (`node.joined`).
   */
  nodeKey?: 'tpm';
  /**
   * A `urn:bc:` statement about the node key that JoinService writes into the certificate beside its
   * SPIFFE ID (tpm: `urn:bc:tpm-ak:<nameAlg>:<digest>`, the AK that certified it). Renewals carry it
   * forward from the old certificate, and only with a new key that same AK certifies.
   */
  nodeKeyUri?: string;
}

/**
 * A join the attestor cannot decide yet (a two-round join, §3.3). JoinService commits the
 * transaction (so the attestor's own rows persist), issues nothing, spends no token, and answers
 * with a signed `JoinResponseBody.deferral`; the agent re-sends `Join` with the same CSR.
 */
export interface AttestationDeferral {
  /**
   * `approval`: waiting for an operator (`joinRequests.approve`); the agent retries the same Join.
   * `challenge`: the agent answers `challenge` in its next Join's `attestation` (tpm).
   */
  deferred: 'approval' | 'challenge';
  /** `approval`: the join request to approve or reject. */
  requestId?: string;
  /** When the agent should retry (`approval`; default 30 s). */
  retryAfterSeconds?: number;
  /** `challenge`: attestor-specific bytes, delivered inside the signed response. */
  challenge?: Uint8Array;
  /** `challenge`: answers after this are refused. */
  notAfter?: Date;
}

export const isAttestationDeferral = (
  value: AttestationResult | AttestationDeferral,
): value is AttestationDeferral => 'deferred' in value && value.deferred !== undefined;

/** The agent half of an attestor: produces evidence (in Go in `bcd`; in TS for `FakeDaemon`). */
export interface NodeAttestor {
  readonly id: string;
  /** `challenge`: the payload of a `JoinChallenge` from the previous round, when there was one. */
  produce(input: {
    claims: HardwareClaims;
    nonce?: Uint8Array;
    challenge?: Uint8Array;
  }): Promise<AttestationEvidence>;
}

export interface AttestorVerifierInput {
  /** `join-token`, `x509pop`, `provisioned`, `discovery`, `cloud-iid`, `tpm`, … */
  id: string;
  version: string;
  /** Roles this attestor may admit. */
  roles: readonly AgentRole[];
  /**
   * Verifies evidence inside JoinService's transaction; throws `ACCESS_DENIED` to refuse, or
   * returns an `AttestationDeferral` for a second round.
   */
  verify(
    evidence: AttestationEvidence,
    context: AttestationContext,
  ): Promise<AttestationResult | AttestationDeferral>;
}
/** The control-plane half of an attestor, run by JoinService. */
export interface AttestorVerifier extends AttestorVerifierInput, Extension {
  readonly extension: 'attestor';
  readonly id: string;
  readonly version: string;
}

export function defineAttestor(attestor: AttestorVerifierInput): AttestorVerifier {
  return Object.freeze({ ...attestor, extension: 'attestor' as const });
}

// --- Sinks, notifier, leases, stores --------------------------------------------------------------

export interface UsageSink extends Extension {
  readonly extension: 'sink';
  readonly kind: 'usage';
  /** One result per event, in order; isolates poison events instead of failing the batch. */
  write(events: readonly UsageEvent[]): Promise<UsageResult[]>;
}
export interface EventSink extends Extension {
  readonly extension: 'sink';
  readonly kind: 'events';
  /** At-least-once; events carry ids for deduplication. */
  deliver(events: readonly ComputeEvent[]): Promise<void>;
}
export interface AuditSink extends Extension {
  readonly extension: 'sink';
  readonly kind: 'audit';
  write(records: readonly AuditRecord[]): Promise<void>;
}
export type Sink = UsageSink | EventSink | AuditSink;

/** Declares a usage, event or audit sink (selected by `kind`). */
export function defineSink(sink: Omit<UsageSink, 'extension'>): UsageSink;
export function defineSink(sink: Omit<EventSink, 'extension'>): EventSink;
export function defineSink(sink: Omit<AuditSink, 'extension'>): AuditSink;
export function defineSink(
  sink: Omit<UsageSink, 'extension'> | Omit<EventSink, 'extension'> | Omit<AuditSink, 'extension'>,
): Sink {
  return Object.freeze({ ...sink, extension: 'sink' as const }) as Sink;
}

export interface SinkOptions {
  usage?: UsageSink[];
  events?: EventSink[];
  audit?: AuditSink[];
}

/** Best-effort wake-ups after commit (NATS, Redis, or polling alone). Never a source of truth (P1). */
export interface Notifier {
  publish(channel: string, message?: string): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
  close?(): Promise<void>;
}

/** A named lease with a fencing epoch: `shard:<n>`, `pool:<id>`, `site:<id>:boot`, `singleton:<job>`, `gateway:<id>`. */
export interface Lease {
  name: string;
  owner: string;
  epoch: number;
  expiresAt: number;
}

export interface LeaseProvider {
  /** Acquires or renews; undefined while another owner holds an unexpired lease. */
  acquire(name: string, owner: string, ttlMs: number): Promise<Lease | undefined>;
  release(name: string, owner: string): Promise<void>;
  /**
   * The first statement of every fenced transaction: locks the lease row `FOR SHARE` and throws
   * `CONFLICT` if `lease` is no longer held with that epoch.
   */
  fence(tx: SqlTx, lease: Pick<Lease, 'name' | 'owner' | 'epoch'>): Promise<void>;
}

/** Object storage for daemon downloads, log bundles and images. */
export interface BlobStore {
  get(key: string): Promise<ReadableStream<Uint8Array> | undefined>;
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options?: { contentType?: string },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  /** A time-limited URL (`logs.collect` uploads to one). */
  presign?(
    key: string,
    options: { method: 'GET' | 'PUT'; expiresInSeconds: number },
  ): Promise<string>;
}

/** Secret storage behind `SecretRef`s. Write-only through the API: values are never read back out. */
export interface SecretStore {
  readonly id: string;
  /** URI schemes it serves: `secret`, `vault`, `env`. */
  readonly schemes: readonly string[];
  put(tenantId: string, value: string, options?: { ref?: SecretRef }): Promise<SecretRef>;
  /** With `context`, refuses (`ACCESS_DENIED`) a ref that is not `context.tenantId`'s. */
  resolve(ref: SecretRef, context?: SecretResolveContext): Promise<string>;
  delete(ref: SecretRef): Promise<void>;
}

export interface CertificateProfile {
  /** URI SANs, e.g. `spiffe://<td>/site/<site>/node/<nodeId>`. */
  uriSans?: readonly string[];
  dnsSans?: readonly string[];
  /** `node-tenant`: a node under tenant-controlled trust (dedicated-root leases); never attests platform steps. */
  role?: AgentRole | 'node-tenant' | 'gateway' | 'internal';
  usage: 'client' | 'server';
  ttlSeconds: number;
}

export interface IssuedCertificate {
  serial: string;
  /** DER. */
  certificate: Uint8Array;
  /** DER, issuer first. */
  chain: Uint8Array[];
  notBefore: number;
  notAfter: number;
}

/** A signing CA (node client CA, gateway serving CA, internal CA). No key does two jobs. */
export interface CertificateAuthority {
  readonly id: string;
  /** DER certificates of the CA, the signing certificate first. */
  certificates(): Promise<Uint8Array[]>;
  /** Signs a DER PKCS#10 request under `profile`. */
  sign(csr: Uint8Array, profile: CertificateProfile): Promise<IssuedCertificate>;
  revoke?(serial: string, reason?: string): Promise<void>;
}

export interface ResolvedImage {
  url: string;
  sha256: string;
  sizeBytes?: number;
  format: ImageFormat;
  compression?: ImageCompression;
}

/** Where images come from (`https`, `oci`, …). */
export interface ImageSource extends Extension {
  readonly extension: 'image-source';
  readonly schemes: readonly string[];
  resolve(ref: string): Promise<ResolvedImage>;
}

export interface TunnelTarget {
  kind: 'console' | 'ssh' | 'tcp';
  instanceId?: string;
  port?: number;
}

/** A bidirectional byte stream (web streams, so browser-safe). */
export interface DuplexStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

/** How the control plane reaches a node: `bcd/v1`, `provider-api/v1`, later `agentless-ssh/v1`. */
/**
 * Checks the parts of a pool policy its module reads (e.g. provision's host units: hugepages,
 * kernel modules, `kubernetes`), as the nodes will get them. `pools.create` and `pools.update` run every
 * listed validator before writing, so a bad policy is refused there (`INVALID_INPUT`) rather than
 * breaking every node's spec later. Throw a `ComputeError` to refuse.
 */
export interface PoolPolicyValidator extends Extension {
  readonly extension: 'pool-policy';
  validate(
    policy: Readonly<Record<string, unknown>>,
    pool: { class: string; sharing?: string },
  ): Promise<void>;
}

export interface NodeAdapter extends Extension {
  readonly extension: 'node-adapter';
  supports(node: NodeRecord): boolean;
  /** Called inside the enqueue transaction; delivery itself happens after commit. */
  send(node: NodeRecord, command: CommandEnvelope, tx: SqlTx): Promise<void>;
  openTunnel?(node: NodeRecord, target: TunnelTarget): Promise<DuplexStream>;
}

// --- Providers and steps (types here; `defineProvider` is in vps, `defineStep` in provision) -----

/** A catalog query against a provider (SkyPilot-style offers). */
export interface OfferQuery {
  kind?: 'metal' | 'vps';
  region?: string;
  gpuModel?: string;
  minGpus?: number;
  minVcpu?: number;
  minMemoryGiB?: number;
}

/** Something a provider can create now. */
export interface Offer {
  id: string;
  kind: 'metal' | 'vps';
  region: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB?: number;
  gpus?: { model: string; count: number };
  pricePerHour?: number;
  currency?: string;
  available: boolean;
}

/** A provider image id, or a catalog image `name@version`. */
export type ImageRef = string;

/** A machine as the provider reports it. */
export interface ExternalMachine {
  id: string;
  name?: string;
  state:
    | 'pending'
    | 'running'
    | 'stopped'
    | 'rescue'
    | 'deleting'
    | 'deleted'
    | 'error'
    | 'unknown';
  offerId?: string;
  region?: string;
  addresses: string[];
  /** Optional detail; providers that do not know a member omit it. */
  zone?: string;
  machineType?: string;
  vcpu?: number;
  memoryGiB?: number;
  gpus?: { model: string; count: number };
  labels?: Readonly<Record<string, string>>;
  /**
   * (platform compute billing) The disks the machine holds, boot disk first, when the provider reports them: the
   * type as the provider names it (`pd-balanced`, `hyperdisk-balanced`, `local-ssd`, …) and the size in GiB.
   * Metered as `disk.<type>.gib.hours`, running or stopped. A disk whose type the provider could not read omits
   * `type`: it is metered as `pd-balanced` and the instance carries a `DiskTypeUnknown` condition.
   */
  disks?: readonly { type?: string; sizeGiB: number; boot?: boolean }[];
  /**
   * (platform compute billing) The type of the boot disk a machine of this family takes, when the provider knows
   * it but reports no `disks` (`hyperdisk-balanced` for the families that only take Hyperdisk). Absent: `pd-balanced`.
   */
  bootDiskType?: string;
  networks?: readonly {
    network: string;
    subnet?: string;
    address?: string;
    publicAddress?: string;
    tags?: readonly string[];
  }[];
  /** The provider reservation this machine consumes, as a reservation id (see `ExternalReservation.id`). */
  reservation?: string;
  createdAt?: number;
  /** The better-compute instance id the provider's ownership label names, if any. */
  claimedBy?: string;
}

/** A provider capacity reservation (GCE reservations and the like), as the provider reports it. */
export interface ExternalReservation {
  /** `<zone>/<name>`, or `projects/<owner>/zones/<zone>/reservations/<name>` when shared in. */
  id: string;
  name: string;
  zone: string;
  region: string;
  state: 'scheduled' | 'creating' | 'ready' | 'updating' | 'deleting' | 'error';
  machineType: string;
  vcpu: number;
  memoryGiB: number;
  gpus?: { model: string; count: number };
  localSsdGiB?: number;
  /** `specificReservation.count` (future reservations: `totalCount`). */
  total: number;
  /** `specificReservation.inUseCount` (future reservations: 0). */
  inUse: number;
  /** `specificReservationRequired`: only machines that name the reservation consume it. */
  specificOnly: boolean;
  shared: boolean;
  /** Future/calendar reservations; `deleteAtTime` for on-demand ones. */
  startsAt?: number;
  endsAt?: number;
  /** `<zone>/<machineType>@<name | projects/<owner>/reservations/<name>>`. */
  offerId: string;
}

/** Where a created machine attaches: a provider network, optionally a subnet and managed tags. */
export interface NetworkRef {
  network: string;
  subnet?: string;
  tags?: readonly string[];
}

export interface ProviderNetworkSpec {
  name: string;
  description?: string;
  mtu?: number;
}
export interface ProviderSubnetSpec {
  network: string;
  name: string;
  region: string;
  cidr: string;
  privateGoogleAccess?: boolean;
}
export interface ProviderFirewallSpec {
  network: string;
  name: string;
  direction: 'ingress' | 'egress';
  action: 'allow' | 'deny';
  priority: number;
  rules: readonly { protocol: 'tcp' | 'udp' | 'icmp' | 'all'; ports?: readonly string[] }[];
  sources?: readonly string[];
  destinations?: readonly string[];
  targetTags?: readonly string[];
  disabled?: boolean;
}
export interface ProviderNetworkState {
  id: string;
  state: 'pending' | 'ready' | 'deleting' | 'deleted' | 'error';
  message?: string;
}

/**
 * Provider-side tenant networking. `ensure*` and `delete*` are idempotent and non-blocking: they
 * return `pending` (or `deleting`) while a provider operation runs, and the reconciler calls them
 * again later.
 */
export interface ProviderNetworks {
  ensureNetwork(spec: ProviderNetworkSpec, context: CallContext): Promise<ProviderNetworkState>;
  ensureSubnet(spec: ProviderSubnetSpec, context: CallContext): Promise<ProviderNetworkState>;
  ensureFirewall(spec: ProviderFirewallSpec, context: CallContext): Promise<ProviderNetworkState>;
  deleteNetwork(name: string, context: CallContext): Promise<ProviderNetworkState>;
  deleteSubnet(region: string, name: string, context: CallContext): Promise<ProviderNetworkState>;
  deleteFirewall(name: string, context: CallContext): Promise<ProviderNetworkState>;
  /**
   * Replaces the tags this provider manages (prefix `bc-`) on a machine; keeps every other tag.
   * (v1.0) With `instanceId`, only a machine whose ownership label names that instance is touched:
   * any other is `INVALID_STATE` (it was re-claimed elsewhere, or never was this instance's).
   */
  setTags(
    machineId: string,
    tags: readonly string[],
    context: CallContext,
    instanceId?: string,
  ): Promise<void>;
}

/**
 * (v1.0, D10) One row of a provider's cost export, as the provider billed it. Amounts are integer
 * micros of `currency` (the export's own; never converted). A re-export of the same row keeps its
 * `sourceRowId`, so ingestion is idempotent and a corrected amount replaces the stored one.
 */
export interface ProviderCostRecord {
  /** A stable hash of the export row's identity; the export time is not part of it. */
  sourceRowId: string;
  service: string;
  sku: string;
  skuDescription?: string;
  region?: string;
  zone?: string;
  project?: string;
  resourceName?: string;
  usageStart: number;
  usageEnd: number;
  /** Usage in the pricing unit (`unit`). */
  quantity: number;
  unit: string;
  costMicros: number;
  /** The sum of the row's credits; never positive. */
  creditsMicros: number;
  currency: string;
  labels: Readonly<Record<string, string>>;
  exportTime: number;
  /**
   * The provider's cost type (GCP `cost_type`: `regular`, `adjustment`, `tax`, …). Absent means
   * regular usage. Only regular rows are passed through to tenants.
   */
  costType?: string;
}

/** Rescue-system access; the credential is stored as a secret, never returned as a value. */
export interface RescueAccess {
  address: string;
  username: string;
  credential: SecretRef;
  expiresAt?: number;
}

/**
 * (platform compute billing) One provider list price, in micros of `currency` per `unit`: what the provider charges
 * for a resource in a region. `hour` is per vCPU, GPU or address hour; `gib-hour` per GiB of memory or disk hour;
 * Commitment prices are not listed, and neither is egress (billed by pass-through at its real cost).
 */
export interface ProviderListPrice {
  resource: 'vcpu' | 'memory' | 'gpu' | 'disk' | 'ip';
  region: string;
  /** The catalog GPU family slug (`h100`), for `resource: 'gpu'`. */
  gpuModel?: string;
  /** The disk type (`pd-ssd`), for `resource: 'disk'`. */
  diskType?: string;
  /** The machine family (`n2`), for `vcpu` and `memory`. */
  machineFamily?: string;
  spot: boolean;
  unitPriceMicros: number;
  unit: 'hour' | 'gib-hour';
  currency: string;
  /** The provider's id of the price (a GCP SKU id). */
  sku: string;
}

/** Per-call context of a provider operation. */
export interface CallContext {
  /** Creates use the instance id, so a retried create never makes a second machine. */
  idempotencyKey: string;
  signal: AbortSignal;
  clock: Clock;
  secrets: SecretResolver;
  log: Logger;
}

/** One configured provider account's client (§5.4). */
export interface ProviderImpl {
  listOffers(query: OfferQuery): Promise<Offer[]>;
  create(
    request: {
      offerId: string;
      image: ImageRef;
      userData: string;
      name: string;
      network?: NetworkRef;
      labels?: Readonly<Record<string, string>>;
      /**
       * The instance's OpenSSH public keys, also rendered into `userData` when it has none. A
       * provider that can install keys without cloud-init (Compute Engine's `ssh-keys`) does.
       */
      sshKeys?: readonly string[];
    },
    context: CallContext,
  ): Promise<ExternalMachine>;
  get(id: string, context: CallContext): Promise<ExternalMachine | undefined>;
  /** A machine that is already gone counts as deleted (`NOT_FOUND` ⇒ success). */
  delete(id: string, context: CallContext): Promise<void>;
  /**
   * `agent: 'bcd'` pools only: delivers a single-use `provisioned` join token through rescue or
   * installimage, never through tenant-readable user-data. The installed OS runs
   * `bcd join --server <controlPlaneUrl> --token-file … --attestor provisioned` with `pins`: bcd
   * reads the gateway from the control plane's `/.well-known/better-compute` and refuses a document
   * whose pins differ, so the token never goes to whoever can serve that name.
   */
  bootstrap?(
    machine: ExternalMachine,
    bootstrap: {
      joinToken: string;
      bcdUrl: string;
      sha256: string;
      controlPlaneUrl?: string;
      /** `sha256/<base64>` SPKI pins: the gateway serving CA and JoinService's signing and encryption keys. */
      pins?: { servingCa: string; joinSigning: string; joinEncryption: string };
    },
    context: CallContext,
  ): Promise<void>;
  /**
   * Reads the machine's SMBIOS UUID (e.g. dmidecode in rescue), so its `provisioned` bootstrap
   * token can be bound to it (`expect.productUuid`) before `bootstrap` delivers it.
   */
  identify?(machine: ExternalMachine, context: CallContext): Promise<{ productUuid: string }>;
  power?(id: string, action: PowerAction, context: CallContext): Promise<void>;
  rescue?(id: string, context: CallContext): Promise<RescueAccess>;
  reinstall?(id: string, image: ImageRef, context: CallContext): Promise<void>;
  list?(context: CallContext): AsyncIterable<ExternalMachine>;
  /** Every machine the account can see, including ones better-compute did not create. */
  discover?(context: CallContext): AsyncIterable<ExternalMachine>;
  /**
   * Writes the ownership label naming `instanceId`. With `managed`, also writes
   * `better-compute-managed=true`, which hands deletion of the machine to better-compute.
   */
  claim?(
    id: string,
    instanceId: string,
    context: CallContext,
    options?: { managed?: boolean },
  ): Promise<ExternalMachine>;
  /** Removes the ownership label if it names `instanceId`. */
  release?(id: string, instanceId: string, context: CallContext): Promise<void>;
  listReservations?(context: CallContext): Promise<ExternalReservation[]>;
  /**
   * (platform compute billing) The provider's list prices, for the regions asked (all when absent). A provider
   * caches what it reads; the prices are the provider's, before any margin.
   */
  listPrices?(
    query: { regions?: readonly string[] },
    context: CallContext,
  ): Promise<ProviderListPrice[]>;
  networks?: ProviderNetworks;
  /**
   * (v1.0, D10) The account's billed cost rows whose usage started in `[window.from, window.to)`.
   * Read outside any transaction. A provider whose export is not configured leaves it absent.
   */
  costs?(
    window: { from: number; to: number },
    context: CallContext,
  ): AsyncIterable<ProviderCostRecord>;
}

export interface ProviderContext {
  clock: Clock;
  secrets: SecretResolver;
  log: Logger;
  /**
   * (v1.0) The provider account the client is built for, as the module that builds it knows it.
   * `platform` is true when the account belongs to the root (platform) tenant: a provider that can
   * fall back on the host's own identity (ambient credentials: a metadata server, a workload-identity
   * token source) allows that only for platform accounts. Absent: unknown, treated as not platform.
   */
  account?: { id: string; tenantId: string; platform: boolean };
  /**
   * (GCP WS1) The account's workload identity, for workload identity federation: tokens from the
   * host's issuer (`PkiPort.workload`) for one subject the module fixes from the account row. A
   * provider never chooses the subject. Absent when the host configures no issuer.
   */
  identity?: {
    /** compute-account:<tenantId>/<provider>/<name> — fixed by vps. */
    readonly subject: string;
    mint(input: {
      audience: string;
      ttlSeconds?: number;
    }): Promise<{ token: string; expiresAt: number }>;
    /** Mints for a subject this account is not: 'sibling' = same tenant, random name; 'stranger' = random tenant, same name. */
    mintProbe(
      kind: 'sibling' | 'stranger',
      input: { audience: string },
    ): Promise<{ token: string; subject: string }>;
  };
}

/** A provider as written for `defineProvider` (vps). Accounts are data validated by `config`. */
export interface ProviderInput<C> {
  id: string;
  version: string;
  provides: readonly ('metal' | 'vps')[];
  config: Manifest<C>;
  capabilities?: readonly string[];
  /** Builds the client for one account's validated config. */
  create(config: C, context: ProviderContext): ProviderImpl | Promise<ProviderImpl>;
  /**
   * Network checks of an account about to be stored; runs with no transaction open. `INVALID_CONFIG`
   * refuses the account. `UNAVAILABLE`, `RATE_LIMITED` and any other error propagate as they are and
   * store nothing, so a retry with the same idempotency key runs the check again.
   */
  checkAccount?(config: C, context: ProviderContext & { signal: AbortSignal }): Promise<void>;
  /** A key no two accounts of this provider may share (e.g. a federation audience). Pure; no I/O. */
  accountKey?(config: C): string | undefined;
  /**
   * (v1.0, D11/D12) How this provider's cost rows relate to what compute meters. Pure; no I/O. A record may
   * be a probe built from a pass-through rule's pattern (`sku` and `skuDescription` = the pattern, `service`
   * empty): a matcher treats an empty service as possibly its compute service.
   */
  billing?: {
    /** The compute SKUs D4 meters (vCPU, memory, GPU, instance): never passed through; leak detection's hours. */
    computeSku?(record: Pick<ProviderCostRecord, 'service' | 'sku' | 'skuDescription'>): boolean;
    /** Other SKUs compute meters itself (disks, public addresses): never passed through either. */
    meteredSku?(record: Pick<ProviderCostRecord, 'service' | 'sku' | 'skuDescription'>): boolean;
  };
}
export interface ProviderDefinition<C = any> extends ProviderInput<C>, Extension {
  readonly extension: 'provider';
  readonly id: string;
  readonly version: string;
}

/** What a control-plane step's `run` receives. */
export interface StepContext extends ModuleContext {
  workflowId: string;
  stepId: string;
  attempt: number;
  /** `wf:<workflowId>:<stepId>`. */
  idempotencyKey: string;
  node?: NodeRef;
  /** (v1.0 §13) The workflow's batch: commands the step sends carry it (`awaitCommand` does). */
  batchId?: string;
  signal: AbortSignal;
  emit(progress: Progress): void;
}

/** A workflow step as written for `defineStep` (provision). */
export interface StepInput<I> {
  /** What profiles `use`, e.g. `power.setPower` or `wait.agentJoined`. */
  id: string;
  version?: string;
  runsOn: RunsOn;
  timeout: Duration;
  retries?: number;
  retrySafe: boolean;
  /** Self-terminating steps complete when the agent rejoins. */
  await?: 'rejoin';
  input: Manifest<I>;
  /** Steps that run on an agent: the command kind sent (`driver.invoke` for driver operations). */
  command?: string;
  /**
   * Control-plane steps that relay commands: every kind `run` may send (the workflow engine refuses
   * any other), so a profile's full command set is known before it runs, e.g. for a batch's approval
   * scope (§13 quorum). A step without it is not checked, and in a batch whatever it sends falls
   * outside the scope and is refused.
   */
  sends?: readonly string[];
  /** Control-plane steps. */
  run?(input: I, context: StepContext): Promise<Json | void>;
  cleanup?: readonly ProfileStep[];
}
export interface StepDefinition<I = any> extends StepInput<I>, Extension {
  readonly extension: 'step';
  readonly id: string;
  readonly version?: string;
}

// --- Modules -------------------------------------------------------------------------------------

/** What a module can read from the registry. */
export interface RegistryView {
  hasModule(name: string): boolean;
  commandKind(kind: string): CommandKindSpec | undefined;
  driver(id: string): DriverDefinition | undefined;
}

export interface EnqueueCommand<P = unknown> {
  nodeId: string;
  kind: string;
  /**
   * The kind's payload message: its proto3 JSON form, a protobuf-es message of the kind's payload type,
   * or its encoded bytes; `undefined` for kinds with an empty payload. Routing data never goes here.
   */
  payload: P;
  /** Unique per node; workflow steps use `wf:<id>:<stepId>`. */
  idempotencyKey: string;
  notAfter: number;
  notBefore?: number;
  minGeneration?: number;
  traceparent?: string;
  /**
   * (v1.0 §13 quorum) The batch (`createBatch`) this destructive command belongs to. Its (subject,
   * kind) must be in the batch's scope; it goes into the signed body, and while the batch waits for
   * its approvals the command stays pending. The daemon then requires the approval and proof.
   */
  batchId?: string;
}

/** A destructive-batch scope: the (subject, kind) leaves approvers sign (§13). */
export interface CommandBatchInput {
  tenantId: string;
  /**
   * subject: the node id; `bmc:<site agent>/<address>` for bmc.* kinds; `node:<target>` for
   * site.httpProxy. `payloadSha256` binds a leaf to one exact payload (absent: any payload).
   * `payload` (the command's `Any`) binds it too, and is what approvers are shown
   * (`commandBatches.scope`): pass it whenever the payload is known, so an approver sees the image,
   * firmware or power action it signs, not only a digest.
   */
  scope: readonly {
    subject: string;
    kind: string;
    payloadSha256?: Uint8Array;
    payload?: { typeUrl: string; value: Uint8Array };
  }[];
  reason: string;
  /** When the batch stops admitting commands (default 24 h). */
  notAfterMs?: number;
  createdBy?: string;
}

/** The durable command queue (§7.4). */
export interface CommandQueue {
  /** Inserts a `pending` command in `tx`; an existing idempotency key returns the existing command. */
  enqueue(tx: SqlTx, command: EnqueueCommand): Promise<{ id: string; seq: number }>;
  cancel(tx: SqlTx, commandId: string): Promise<void>;
  /**
   * (v1.0) Creates a destructive-command batch in `tx`. `held`: the deployment's quorum needs
   * `required` approvals before its commands are sent; without approver keys it is recorded for
   * audit and its commands go out at once.
   */
  createBatch?(
    tx: SqlTx,
    batch: CommandBatchInput,
  ): Promise<{ batchId: string; held: boolean; required: number; size: number }>;
}

/** Desired state (§7.3): marks a node's spec for recomputation by the NodeSpec controller. */
export interface DesiredState {
  invalidate(tx: SqlTx, nodeId: string): Promise<void>;
}

/** The workflow engine (provision, v0.2). */
export interface WorkflowEngine {
  start(
    tx: SqlTx,
    input: {
      tenantId: string;
      profileId: string;
      profileVersion: number;
      nodeId?: string;
      instanceId?: string;
      /**
       * (v1.0 §13 quorum) The batch (`commands.createBatch`) the workflow's destructive commands
       * belong to: every command it sends carries it.
       */
      batchId?: string;
    },
  ): Promise<{ id: string }>;
  abort(tx: SqlTx, workflowId: string): Promise<void>;
}

/** Capacity, backed by the built-in capacity module; how other modules book resources. */
export interface CapacityPort {
  /**
   * `admission`: the calling method's recorded decision (`ctx.admission`), so scheduler plugins'
   * `admit` hooks run for this request; reconciler retries of an admitted request omit it.
   */
  reserve(
    tx: SqlTx,
    request: PlacementRequest,
    options?: { admission?: AdmissionContext },
  ): Promise<PlacementOutcome>;
  release(tx: SqlTx, allocationId: string): Promise<void>;
}

/** The latest stored inventory of a node, by section. */
export interface InventorySnapshot {
  nodeId: string;
  hash: string;
  sections: Record<string, Json>;
  collectedAt: number;
}

/** Inventory, backed by the built-in inventory module. */
export interface InventoryPort {
  get(nodeId: string): Promise<InventorySnapshot | undefined>;
}

/** Publishes events through the outbox, in the caller's transaction. */
export interface EventPublisher {
  publish(tx: SqlTx, event: Omit<ComputeEvent, 'id' | 'time' | 'sequence'>): Promise<void>;
  /** Set-based publish of several events in one statement; callers fall back to `publish` when absent. */
  publishMany?(
    tx: SqlTx,
    events: readonly Omit<ComputeEvent, 'id' | 'time' | 'sequence'>[],
  ): Promise<void>;
}

/**
 * The coalescing work queue (§8.4): enqueue in the state-change transaction; a key re-dirtied while a
 * reconciler runs survives (`gen`). `kind` is a reconciler name (`inventory`, `nodespec`, …).
 */
export interface WorkQueue {
  enqueue(tx: SqlTx, kind: string, key: string, options?: { notBefore?: number }): Promise<void>;
  /**
   * Set-based enqueue of several keys of one kind in one statement (same coalescing as `enqueue`);
   * callers fall back to `enqueue` when absent.
   */
  enqueueMany?(
    tx: SqlTx,
    kind: string,
    keys: readonly string[],
    options?: { notBefore?: number },
  ): Promise<void>;
}

/** Attribute values IAM policies can read (better-iam attributes are string | number | boolean). */
export type AuthzAttributes = Record<string, string | number | boolean>;

/**
 * One row of the authz projection (§12.4): how a compute resource looks to IAM *in one tenant's view*.
 * `type` is the unprefixed kind (`pool`, `reservation`, …); the IAM bridge adds the configured prefix.
 */
export interface AuthzRow {
  type: string;
  id: string;
  /** The tenant in whose view the row exists (a platform pool has one row per offered tenant). */
  tenantId: string;
  attributes: AuthzAttributes;
  parentType?: string;
  parentId?: string;
  ownerId?: string;
}

/**
 * Writes `authz_projection` and its change feed `authz_changes` in the caller's transaction, so the
 * IAM resolver (memory-resident, tailing the feed) sees exactly what compute committed.
 */
export interface AuthzWriter {
  upsert(tx: SqlTx, row: AuthzRow): Promise<void>;
  /** Removes the row from one tenant's view, or from every view when `tenantId` is omitted. */
  remove(tx: SqlTx, ref: { type: string; id: string; tenantId?: string }): Promise<void>;
  /** In-flight `extend`/`renew` changes decided before they apply (§10.5); `null` clears them. */
  setPending(
    tx: SqlTx,
    ref: { type: string; id: string; tenantId: string },
    pending: AuthzAttributes | null,
  ): Promise<void>;
}

/** Queues usage windows for the usage sink, in the caller's transaction. */
export interface UsageRecorder {
  record(tx: SqlTx, events: readonly UsageEvent[]): Promise<void>;
}

/** The secret broker (v0.2). */
export interface SecretBroker extends SecretResolver {
  put(tenantId: string, value: string): Promise<SecretRef>;
  /** Destroys a secret no longer referenced (e.g. a superseded BMC credential); unknown refs are a no-op. */
  delete?(ref: SecretRef): Promise<void>;
}

/** Join credentials for agents a module brings up (`provisioned`, `discovery` tokens; v0.2). */
export interface PkiPort {
  issueJoinToken(
    tx: SqlTx,
    input: {
      tenantId: string;
      role: 'node' | 'site' | 'provisioned' | 'discovery';
      poolId?: string;
      siteId?: string;
      ttlSeconds: number;
      maxUses?: number;
      /**
       * Binds the token to one machine (`join_tokens.expect`): a join whose hardware claims or
       * attestation differ is refused without spending the token.
       */
      expect?: { mac?: string; productUuid?: string; serial?: string; gpuUuid?: string };
    },
  ): Promise<{ id: string; token: string }>;
  /**
   * The control plane as an OIDC issuer (`ComputeOptions.pki.workloadIssuer`), for modules that mint
   * workload-identity-federation tokens. Absent when the host configures none.
   */
  workload?: WorkloadIssuerPort;
}

/** The control plane as an OIDC issuer for workload identity federation (GCP WIF, AWS web identity, …). */
export interface WorkloadIssuerPort {
  readonly issuer: string;
  mint(input: {
    subject: string;
    audience: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; expiresAt: number }>;
  /** Public keys only: { keys: [{ kty:'EC', crv:'P-256', x, y, kid, alg:'ES256', use:'sig' }, …] }. */
  jwks(): Promise<{ keys: readonly Record<string, unknown>[] }>;
}

/** What modules get from the host. Modules never import each other's internals. */
export interface ModuleContext {
  sql: SqlExecutor;
  clock: Clock;
  leases: LeaseProvider;
  iam: IamPort;
  registry: RegistryView;
  commands: CommandQueue;
  desired: DesiredState;
  capacity: CapacityPort;
  inventory: InventoryPort;
  events: EventPublisher;
  /** Enqueues reconciler work in the caller's transaction. */
  work: WorkQueue;
  /** Maintains the IAM authz projection in the caller's transaction. */
  authz: AuthzWriter;
  log: Logger;
  /** v0.2 (provision). */
  workflows?: WorkflowEngine;
  /**
   * Reserved: the server does not set it. Usage windows are written by capacity (reservations,
   * instances, node leases) and sent to IAM billing by the IAM bridge (§12.7).
   */
  usage?: UsageRecorder;
  /** v0.2. */
  secrets?: SecretBroker;
  /** v0.2. */
  pki?: PkiPort;
  /**
   * Runs `hook` after the outermost open transaction commits (never on rollback); outside a transaction it
   * runs on the next macrotask. For best-effort side effects only: pokes, in-memory projection updates.
   */
  afterCommit?(hook: () => void | Promise<void>): void;
  /** The envelope's caches, for invalidation from IAM events (the IAM bridge's inbox handlers). */
  caches?: ComputeCaches;
  /**
   * The IAM resource type prefix of this deployment (`ComputeOptions.typePrefix`, default
   * `compute-`), for modules that decide on compute resources themselves (e.g. vps deciding
   * `compute:secrets:manage` on `${typePrefix}tenant/{t}`). Always set by betterCompute().
   */
  typePrefix?: string;
}

/** Invalidation handles of the envelope's authentication and read-decision caches (§3.4, §9.2). */
export interface ComputeCaches {
  /** Drops cached authentications of an identity (offboarded, suspended, sessions revoked). */
  dropIdentity(identityId: string): void;
  /** Drops one cached session. */
  dropSession(sessionId: string): void;
  /** Drops every cached read decision (policy, role, binding or relationship change). */
  dropDecisions(): void;
}

/** Per-call context of an API method. */
export interface MethodContext extends ModuleContext {
  /** Absent only for public methods. */
  caller?: Caller;
  credential?: Credential;
  /** Allowed mutations: the recorded decision context. */
  admission?: AdmissionContext;
  requestId: string;
  /**
   * The request's W3C trace context (`traceparent` header), when it was valid. Commands the method
   * enqueues through `commands` carry it unless they set their own (§14).
   */
  traceparent?: string;
  signal?: AbortSignal;
  /**
   * Composite methods (e.g. `fleet.apply`), phase 1: decides another method's call exactly as the
   * envelope would for the current caller (tenant pre-check, validation, one IAM decision), with no
   * transaction open (IAM is never awaited inside a compute transaction). Methods whose `admission`
   * has a `denied` hook (reservations, instances) are refused with `UNSUPPORTED`; replay-only admissions
   * run `admission.prepare` in a short transaction of their own: `decide` → one IAM decision on the
   * returned resource, `replay` → allowed. Only available to methods declared `transaction: 'manual'`;
   * `check` and `invoke` always act as the calling identity.
   */
  check?(path: `${string}/${string}`, input: unknown): Promise<void>;
  /**
   * Phase 2: runs a call that `check` allowed earlier in this same method call, inside `tx`, without
   * another decision. Any other call is refused with `ACCESS_DENIED`. For admission methods it re-runs
   * `admission.prepare` in `tx` (a replay returns the stored result) and sets `ctx.admission` for the
   * handler. Matching: path + canonical JSON of the raw input; one `invoke` per successful `check`.
   */
  invoke?<O = unknown>(tx: SqlTx, path: `${string}/${string}`, input: unknown): Promise<O>;
}

export type MethodKind = 'read' | 'mutation' | 'public';

/** The resource a method is decided on, without the type prefix (`{ type: 'pool', id }`). */
export interface MethodResource {
  /** A compute resource kind (`pool`, `reservation`, …) or a module/plugin catalog type. */
  type: ComputeResourceKind | (string & {});
  id: string;
  /**
   * For inputs decided on one of the row's "… or @ …" alternatives with its own action
   * (`tunnels.open` on a node: `compute:nodes:console`). The envelope decides on
   * `action ?? MethodDefinition.action` and refuses (`INVALID_CONFIG`) a pair §9.2 does not list.
   */
  action?: `compute:${string}`;
}

/**
 * One API method. The envelope runs the tenant pre-check and one IAM decision on
 * `(action, resource(input))` before the handler; `initialize()` fails when `action` is missing
 * from the merged catalog. Public methods have `action: null`.
 */
export interface MethodDefinition<I = any, O = any> {
  /** A `compute:<area>:<verb>` action (plugins: `compute:<plugin-id>:<verb>`), or `null` for public methods. */
  action: `compute:${string}` | null;
  kind: MethodKind;
  resource(input: I): MethodResource | undefined;
  /** Must reject unknown and invalid fields before the handler runs. */
  validate(input: unknown): I;
  handler(context: MethodContext, input: I): Promise<O>;
  /**
   * Request-as-resource admission (§3.4 steps 4-5) for creates and for `extend`/`renew`. When set,
   * the envelope runs `prepare` in its own transaction after the tenant pre-check and before the IAM
   * decision, decides on the resource `prepare` returns, then runs `handler` in a second transaction
   * (allowed) or `denied` (refused).
   */
  admission?: MethodAdmission<I, O>;
  /**
   * `auto` (default): the envelope runs the handler in a transaction. `manual`: the handler runs with no
   * transaction open and opens its own through `ctx.sql.transaction` (composite methods that use
   * `ctx.check` then `ctx.invoke`); the envelope still writes the mutation's audit row after success. A read
   * declared `manual` runs with no transaction and a read-only `sql` (for handlers that call IAM).
   */
  transaction?: 'auto' | 'manual';
  /**
   * Async-with-wait (§9.1): when the input carries `wait: { timeoutMs }` and the committed output is
   * not `done`, the envelope calls `refresh` in read-only transactions (back-off 50 ms → 1 s, until
   * `done`, the timeout (at most 30 s) or the request's abort) and returns the last output. A
   * timeout is not an error: the output still says the operation is pending.
   */
  poll?: MethodPoll<I, O>;
}

/** How the envelope waits for a mutation's operation to finish (`MethodDefinition.poll`). */
export interface MethodPoll<I, O> {
  done(output: O): boolean;
  refresh(context: MethodContext, input: I, output: O): Promise<O>;
}

/** What `MethodAdmission.prepare` decided about the request. */
export type AdmissionPlan<O> =
  /** Decide on `resource` (the draft id derives from tenant, identity and idempotency key). */
  | { status: 'decide'; resource: MethodResource }
  /** Idempotent replay of a finished request by the same identity: return `result` without a decision. */
  | { status: 'replay'; result: O };

export interface MethodAdmission<I, O> {
  /**
   * Transaction 1: looks up the idempotency key (scoped to tenant + caller identity), writes or
   * reuses the draft row and its authz projection row (so the resolver sees the request's
   * attributes), and returns what to decide on. A different request under the same key must throw
   * `CONFLICT`. Never calls IAM.
   */
  prepare(context: MethodContext, input: I, tx: SqlTx): Promise<AdmissionPlan<O>>;
  /**
   * Transaction 2 after a refusal: mark the draft denied / clear pending changes. For a delegated
   * session whose delegation holds the action back, `error` is `CONFIRMATION_REQUIRED` (details
   * `{ confirmationId, expiresAt, action, resource }`): keep the draft `awaiting-confirmation`.
   */
  denied?(context: MethodContext, input: I, tx: SqlTx, error: unknown): Promise<void>;
  /** A short human description of the request, shown to the person asked to confirm it (§3.4 step 7). */
  describe?(input: I): string;
  /**
   * Checks that may call IAM (e.g. `iam.billingCheck` for `budgetCheck: 'meter'` pools, §12.7-12.8):
   * run after `prepare` answered `decide` and the IAM decision allowed it, with no transaction open.
   * A throw refuses the request with that error WITHOUT `denied`: the draft stays, so a retry with
   * the same key decides again (e.g. once the budget window resets).
   */
  check?(context: MethodContext, input: I, resource: MethodResource): Promise<void>;
  /**
   * Its own transaction after an ALLOWED request's handler (transaction 2) threw, e.g. the resource
   * changed between the transactions: best-effort cleanup of what `prepare` staged that would
   * otherwise outlive the request (pending authz attributes an `extend` set are merged into every
   * later decision on the resource). Keep a retry with the same key possible. A throw here is
   * logged; the caller sees the handler's error.
   */
  abandoned?(context: MethodContext, input: I, tx: SqlTx, error: unknown): Promise<void>;
}

export function defineMethod<I, O>(method: MethodDefinition<I, O>): MethodDefinition<I, O> {
  return Object.freeze({ ...method });
}

export type MethodInput<M> = M extends MethodDefinition<infer I, any> ? I : never;
export type MethodOutput<M> = M extends MethodDefinition<any, infer O> ? O : never;

/** API groups: `{ group: { method: MethodDefinition } }`. */
export type ApiGroups = Record<string, Record<string, MethodDefinition>>;

export interface ReconcileContext extends ModuleContext {
  /** The shard this worker owns for the key, for sharded reconcilers. */
  shard?: number;
  /** The lease the run holds (`shard:<n>` or `singleton:<name>`); transactions via `ctx.sql` are fenced by it. */
  lease?: Lease;
  signal: AbortSignal;
}

export interface Reconciler {
  name: string;
  shardBy: 'node' | 'pool' | 'none';
  /** Level-triggered: `SYNC_AGAIN` re-queues the key. */
  run(context: ReconcileContext, key: string): Promise<'DONE' | 'SYNC_AGAIN'>;
  /**
   * Keys the runtime also enqueues on a fixed period (a `work_queue` row with `not_before`), besides
   * edge-triggered enqueues: e.g. `iam.reconcile` → `[{ key: 'identities', every: '5m' }]`.
   */
  periodic?: readonly { key: string; every: Duration }[];
  /**
   * The worker role that runs it (§8.1): `scheduler` for placers, which scale apart from the
   * controllers. Default `controllers`.
   */
  role?: 'controllers' | 'scheduler';
}

/** A CLI command a module adds (built with the CLI's `defineCommand`). */
export interface CliCommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly group?: string;
}

/**
 * A consumer of a node's coalesced StatusReport, run by the gateway in the status transaction under its own
 * savepoint (the gateway's `StatusHandler`). `report` is the protocol's `StatusReport`; core does not import
 * the protocol, so it is typed `never` here and handlers declare the real type.
 */
export type ModuleStatusHandler = (
  tx: SqlTx,
  context: { nodeId: string; tenantId: string; work: WorkQueue; events?: EventPublisher },
  report: never,
) => Promise<unknown>;

/** A module (§5.4): API groups, reconcilers, command kinds, migrations, catalog, NodeSpec sections. */
export interface ComputeModule<Name extends string = string, A extends ApiGroups = {}> {
  name: Name;
  requires?: string[];
  /** Ledger names `<name>/0001_…`; plugin tables are named `plg_<id>_*`. */
  migrations?: Migration[];
  /** Drivers, steps, scheduler plugins, attestors, sinks. */
  extensions?: Extension[];
  /** Each method declares `{ action, resource(input) }` (§9.2). */
  api?(context: ModuleContext): A;
  reconcilers?: Reconciler[];
  commandKinds?: CommandKindSpec[];
  nodeSpec?(context: ModuleContext, node: NodeRecord): Promise<NodeSpecPart>;
  /**
   * StatusReport consumers (e.g. metal's PXE discovery list). `serve` and the dev stack run every
   * registered module's after the gateway's XID health handler, then the host's `reports.status`.
   */
  statusHandlers?: readonly ModuleStatusHandler[];
  /** Merged into the IAM plugin's catalog. */
  catalog?: { actions?: string[]; resourceTypes?: Record<string, ComputeResourceType> };
  commands?: CliCommandSpec[];
  profiles?: ProfileDocument[];
  selfCheck?(context: ModuleContext): Promise<Finding[]>;
  /**
   * Awaited by `initialize()` in every process mode, after migrations and before the process serves
   * (e.g. the IAM bridge loads its authz projection and binds its inbox). Modules start in
   * registration order.
   */
  start?(context: ModuleContext): Promise<void>;
  /** Awaited by `stop()`, in reverse registration order. */
  stop?(): Promise<void>;
  /**
   * The IAM tenant was deleted (§12.8): release what the module holds for it (reservations, offers, instances).
   * The built-in `tenancy` reconciler calls it until every module answers `DONE` (a `SYNC_AGAIN` is retried
   * about every 30 s), then records the teardown and publishes `tenant.torn-down`. Must be idempotent.
   */
  tenantDeleted?(context: ModuleContext, tenantId: string): Promise<'DONE' | 'SYNC_AGAIN'>;
}

/** Declares a module; the name and API types are kept literal for `betterCompute<M, P>()`. */
export const defineModule = <const N extends string, A extends ApiGroups = {}>(
  module: ComputeModule<N, A>,
): ComputeModule<N, A> => module;

/** A third-party module mounted under `plugins/{id}` with actions `compute:<id>:*`. */
export interface ComputePlugin<Id extends string = string, A extends ApiGroups = {}>
  extends ComputeModule<Id, A> {
  id: Id;
}

/** Declares a plugin: a module plus an `id` (its name defaults to the id). */
export function definePlugin<const Id extends string, A extends ApiGroups = {}>(
  plugin: Omit<ComputeModule<Id, A>, 'name'> & { id: Id; name?: Id },
): ComputePlugin<Id, A> {
  return { ...plugin, name: plugin.name ?? plugin.id };
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

/** The API groups one module contributes. */
export type ApiOf<M> = M extends ComputeModule<string, infer A> ? A : never;

/** The merged API groups of a module list (`CoreApi & ModuleApis<M>` in `betterCompute`). */
export type ModuleApis<M extends readonly ComputeModule[]> = [M[number]] extends [never]
  ? {}
  : UnionToIntersection<ApiOf<M[number]>>;

/** Plugin APIs keyed by plugin id (`api.plugins['acme-autoinstall']`). */
export type PluginApis<P extends readonly ComputeModule[]> = {
  [K in P[number] as K extends { id: infer Id extends string } ? Id : never]: ApiOf<K>;
};
