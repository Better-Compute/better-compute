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
  /** (AWS A3) How the capacity is bought. Absent: on-demand. */
  market?: OfferMarket;
  /** (AWS A3) The CPU architecture of the machine type, when the provider reports it. */
  arch?: 'x86_64' | 'arm64';
  /**
   * (AWS A3) Free slots when known: what a reservation has left, or the quota headroom in machines of
   * this shape. Absent: unknown (unbounded as far as the offer can tell).
   */
  count?: number;
}

/** (AWS A3) The market an offer's capacity comes from. */
export type OfferMarket = 'on-demand' | 'spot' | 'reserved' | 'capacity-block';

/** (AWS A3) A notice that the provider will take a machine away, or has. */
export interface MachineInterruption {
  kind: 'spot' | 'capacity-block-end' | 'maintenance';
  /** When it happens (or happened), epoch ms. */
  at: number;
  action?: 'terminate' | 'stop' | 'hibernate';
}

/** A provider image id, or a catalog image `name@version`. */
export type ImageRef = string;

/**
 * (DO P3) The catalog image an `ImageRef` names, as the host resolved it for the instance's tenant:
 * a catalog ref is unique only within a tenant, so a provider that fetches catalog images itself
 * looks the image up by these, never by the bare ref.
 */
export interface CatalogImageIdentity {
  /** The tenant whose catalog the ref was resolved in (visibility already checked). */
  tenantId: string;
  /** Hex SHA-256 of the resolved artifact. */
  sha256: string;
}

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
  /** (AWS A3) The market the machine's capacity comes from. Absent: on-demand. */
  market?: OfferMarket;
  /** (AWS A3) A pending or past interruption of the machine (a Spot reclaim, a Capacity Block's end). */
  interruption?: MachineInterruption;
}

/** (AWS A3) What `listReservationOfferings` searches for: capacity that can be bought. */
export interface ReservationOfferingQuery {
  instanceType: string;
  count: number;
  durationHours: number;
  /** Epoch ms bounds on the start; absent: as soon as possible. */
  earliestStart?: number;
  latestStart?: number;
}

/** (AWS A3) Capacity a provider sells ahead of time (a Capacity Block offering, an ODCR to create). */
export interface ReservationOffering {
  /** The id `purchaseReservation` takes. */
  id: string;
  instanceType: string;
  zone: string;
  count: number;
  startsAt: number;
  endsAt: number;
  /** What the purchase charges up front; 0 when the capacity is billed as it runs. */
  upfrontPrice: number;
  currency: string;
}

/**
 * (AWS A3) What vps knows about earlier attempts of one purchase, so a provider whose buy call has
 * no idempotency token (EC2 PurchaseCapacityBlock) never buys twice when an earlier answer was lost.
 */
export interface PurchaseAttempt {
  /** 1 for the first call of this purchase. */
  attempt: number;
  /** When the purchase was requested, epoch ms: nothing it bought is older. */
  requestedAt: number;
  /**
   * Set when an earlier attempt ended without the provider's answer (a timeout, a dropped
   * connection) and so may have bought: when the latest such attempt started, epoch ms.
   */
  uncertainSince?: number;
  /**
   * Reservations (`ExternalReservation.id`) other purchases of the account already recorded: never
   * what this purchase bought, when the provider looks for it by what it is.
   */
  excludeReservationIds?: readonly string[];
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

/**
 * (AWS A10) Where a created machine lands relative to its siblings: a provider placement group the
 * provider makes on first use (an EC2 placement group). `group` is the provider's name for it, chosen
 * by the module (tenant-scoped); every machine of one group asks for the same `strategy`.
 */
export interface ProviderPlacement {
  group: string;
  /** `cluster`: one low-latency network segment; `spread`: distinct hardware; `partition`: disjoint racks. */
  strategy: 'cluster' | 'spread' | 'partition';
  /** `partition` only: the partition (1-based) to launch into; absent: the provider picks. */
  partition?: number;
}

/**
 * (AWS A10) A shared filesystem on one of the account's networks, as the module asks for it: `nfs`
 * (Amazon EFS) or `lustre` (Amazon FSx for Lustre). `name` is the provider-side name the module
 * derives (tenant-scoped); it is also the provider's idempotency token. Always encrypted at rest.
 */
export interface ProviderFilesystemSpec {
  name: string;
  kind: 'nfs' | 'lustre';
  /** The network (a `ProviderNetworks` name) whose machines reach the filesystem. */
  network: string;
  /** `lustre`: the one zone it lives in; absent: the provider's default. `nfs` spans every zone of the network. */
  zone?: string;
  /** `lustre`: the capacity; the provider refuses sizes it cannot make. `nfs` is elastic and ignores it. */
  sizeGiB?: number;
  /** `lustre`: scratch (default) or persistent storage. */
  deployment?: 'scratch' | 'persistent';
  labels?: Readonly<Record<string, string>>;
}

/** (AWS A10) A filesystem mount a created machine performs at boot (rendered by the provider into its user data). */
export interface ProviderMount {
  fstype: 'nfs4' | 'lustre';
  /** What the provider's `ProviderFilesystemState.mount` said: never a secret. */
  source: string;
  /** Absolute path on the machine. */
  path: string;
  /** Mount options, comma separated. */
  options: string;
}

/** (AWS A10) A filesystem's state; `mount` (how a machine mounts it) once it is ready. */
export interface ProviderFilesystemState extends ProviderResourceState {
  mount?: Omit<ProviderMount, 'path'>;
  /**
   * The size the provider bills for, in GiB, once it is ready: the provisioned capacity (FSx for
   * Lustre) or the metered size, which grows and shrinks with use (EFS). Absent when unknown; the
   * module then bills the size asked for, if any.
   */
  sizeGiB?: number;
}

/**
 * (AWS A10) Shared filesystems on this account. `ensure*` and `delete*` are idempotent and
 * non-blocking, like `ProviderNetworks`: `pending` or `deleting` while the provider works, and the
 * reconciler calls again.
 */
export interface ProviderFilesystems {
  /** The kinds this provider makes. */
  readonly kinds: readonly ProviderFilesystemSpec['kind'][];
  /**
   * Refuses a spec this provider can never make (`INVALID_INPUT`), before anything is recorded:
   * the module calls it at create, so a bad size or zone is the caller's error, not a filesystem in
   * `error`. Optional: `ensureFilesystem` checks again.
   */
  validate?(spec: ProviderFilesystemSpec): void;
  ensureFilesystem(
    spec: ProviderFilesystemSpec,
    context: CallContext,
  ): Promise<ProviderFilesystemState>;
  deleteFilesystem(name: string, context: CallContext): Promise<ProviderFilesystemState>;
}

export interface ProviderNetworkSpec {
  name: string;
  description?: string;
  mtu?: number;
  /** The network's primary IPv4 range, for providers whose networks have one (an AWS VPC). Absent: the provider's default. */
  cidr?: string;
}
export interface ProviderSubnetSpec {
  network: string;
  name: string;
  region: string;
  cidr: string;
  privateGoogleAccess?: boolean;
  /** The zone the subnet lives in, for providers whose subnets are zone-scoped (`subnetScope: 'zone'`). */
  zone?: string;
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
  /** 'zone': subnets live in one zone and `ensureSubnet` gets `zone` (AWS). Default 'region'. */
  readonly subnetScope?: 'region' | 'zone';
  /**
   * How `deny` rules are honored: natively, per target (GCP); network-wide only, whatever the targets (AWS
   * network ACLs), so a targeted deny is refused; or not at all. Default 'native'.
   */
  readonly denyRules?: 'native' | 'network-wide' | 'none';
  /**
   * (AWS A2) The CIDR prefix lengths the provider takes, `[shortest, longest]`, for a network's own range
   * and for a subnet (AWS: /16 to /28 for both). vps refuses others at the API (`INVALID_INPUT`) instead
   * of the network or subnet ending in `error`. Absent: whatever vps itself allows.
   */
  readonly cidrPrefix?: {
    readonly network?: readonly [number, number];
    readonly subnet?: readonly [number, number];
  };
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
  /**
   * (edge) A NAT gateway that carries the egress of `spec.subnet`, so its machines need no public address of their
   * own. Idempotent by `spec.name` (one per subnet); `pending` while the provider makes it. Outputs: `region`,
   * `address` (its public egress IPv4s, comma-separated, once assigned) and `gateway` (its address inside the
   * subnet). A gateway on another subnet under the same name is `INVALID_STATE` (reason `replace`). While a gateway
   * of the subnet exists, `deleteSubnet` does not delete the subnet: it reports `pending` (a provider may delete its
   * own gateway first, which is the order a teardown needs).
   */
  ensureNatGateway?(spec: ProviderNatGatewaySpec, context: CallContext): Promise<ProviderResourceState>;
  /** (edge) Deletes the NAT gateway `name` this deployment made in `region`; a gone one counts as deleted. */
  deleteNatGateway?(region: string, name: string, context: CallContext): Promise<ProviderResourceState>;
  /**
   * (edge) Peers two of this deployment's networks (or, on a provider whose subnets are networks of their own, two
   * subnets), so their machines reach each other on private addresses. Idempotent by `spec.name`; `pending` while the
   * provider sets it up. Outputs: `networks` (the two provider-side ids, comma-separated). A peering of that name
   * between other networks is `INVALID_STATE` (reason `replace`); a side that is not this deployment's is
   * `INVALID_STATE`. A subnet a peering of ours joins is deleted only after the peering (as with NAT gateways).
   */
  ensurePeering?(spec: ProviderPeeringSpec, context: CallContext): Promise<ProviderResourceState>;
  /** (edge) Deletes the peering `name` this deployment made: `deleting`, then `deleted`. */
  deletePeering?(name: string, context: CallContext): Promise<ProviderResourceState>;
  /**
   * (edge, preview) A static route of a subnet: traffic from the subnet to `spec.destination` goes to `spec.nextHop`.
   * Idempotent by `spec.name` within the subnet; `pending` while the provider applies it. Outputs: `destination` and
   * `nextHop`. A route of that name with another destination or next hop is `INVALID_STATE` (reason `replace`); a
   * next hop that is not this deployment's (a gateway or machine it did not make, an address outside the subnet) is
   * `INVALID_STATE` or `INVALID_INPUT` before any write. A subnet that holds a route of ours is deleted only after
   * the route (as with NAT gateways).
   */
  ensureRoute?(spec: ProviderRouteSpec, context: CallContext): Promise<ProviderResourceState>;
  /** (edge, preview) Deletes the route `ref.name` this deployment made in the subnet; a gone one counts as deleted. */
  deleteRoute?(ref: ProviderRouteRef, context: CallContext): Promise<ProviderResourceState>;
}

/** (edge) Where a route lives: its provider-side name (vps derives it) in a subnet of a network. */
export interface ProviderRouteRef {
  name: string;
  network: string;
  /** The subnet whose routes it joins (as `ensureSubnet` named it). */
  subnet: string;
  region: string;
}

/** (edge) A static route as vps asks for it. */
export interface ProviderRouteSpec extends ProviderRouteRef {
  /** The destination CIDR. */
  destination: string;
  /**
   * Where the traffic goes: a NAT gateway (`ensureNatGateway`'s id), a machine (its provider id) or a private
   * address inside the subnet.
   */
  nextHop: { kind: 'natGateway' | 'machine' | 'address'; id: string };
}

/** (edge) One side of a peering: a network, and the subnet and region where the provider peers subnets. */
export interface ProviderPeeringSide {
  network: string;
  subnet?: string;
  region?: string;
}

/** (edge) A network peering as vps asks for it: `name` is the provider-side name vps derives. */
export interface ProviderPeeringSpec extends ProviderPeeringSide {
  name: string;
  peer: ProviderPeeringSide;
}

/** (edge) A NAT gateway as vps asks for it: `name` is the provider-side name vps derives. */
export interface ProviderNatGatewaySpec {
  name: string;
  network: string;
  /** The subnet whose egress it carries (as `ensureSubnet` named it). */
  subnet: string;
  region: string;
}

/**
 * The state of a provider-side resource that a reconciler drives (Kubernetes clusters and node pools). Same shape as
 * `ProviderNetworkState`, plus `updating` and the resource's plain `outputs` (never secrets).
 */
export interface ProviderResourceState {
  /**
   * The provider's id. (cloud-resources) An `ensure` answering `error` after the provider made the resource (a first
   * deployment that failed) still carries it, so the caller can delete it; empty when nothing was made.
   */
  id: string;
  state: 'pending' | 'ready' | 'updating' | 'deleting' | 'deleted' | 'error';
  outputs?: Readonly<Record<string, string>>;
  /**
   * (cloud-resources) Secret values the provider handed back (a database password, an access key), by the kind's
   * `secretOutputs` names. The caller seals them into the SecretStore in the run that received them and keeps only
   * the refs: never stored, logged, published or put in an error.
   */
  secretOutputs?: Readonly<Record<string, string>>;
  /**
   * (cloud-resources) The spec as the provider reports it, in the kind's spec shape where it can be read back. An
   * adopted resource's spec is recorded from it.
   */
  spec?: Readonly<Record<string, unknown>>;
  /**
   * (cloud-resources) What the resource accrues per hour right now, by the kind's `meters` names: a database
   * cluster's node count for its node-hours meter. The caller samples it and bills the hours that follow at that
   * rate. A meter that is not reported accrues nothing with time (one billed by use, such as GiB-seconds, is left to
   * the provider's billing). Finite and not negative; any other entry is ignored.
   */
  usage?: Readonly<Record<string, number>>;
  /**
   * (cloud-resources) Who manages it, when `get` can tell from the resource itself: `this` deployment, an `other`
   * one, or `none`. Absent: `get` cannot tell, and the caller looks it up through `discover` (an adopt pre-check).
   */
  managedBy?: 'this' | 'other' | 'none';
  message?: string;
}

/** (cloud-resources) What a long-tail provider resource is, for IAM attributes and policies. */
export type ProviderResourceFamily =
  | 'storage'
  | 'network'
  | 'edge'
  | 'data'
  | 'platform'
  | 'ai'
  | 'observability';

/**
 * (cloud-resources) One kind of provider resource served through the generic `ProviderResources` contract: a managed
 * database, an app, a functions namespace. Provider-neutral: `do.database.pg`, later `aws.rds.postgres`,
 * `gcp.sql.postgres`.
 */
export interface ProviderResourceKind {
  /** Provider-prefixed, `[a-z0-9.-]`, at most 64 characters: `do.database.pg`. */
  kind: string;
  family: ProviderResourceFamily;
  description?: string;
  /** Validated before any provider call. A regional kind's spec has a `region` string. */
  spec: Manifest<unknown>;
  /** Plain outputs `ensure`/`get` report once ready (host, port, urn). */
  outputs: readonly string[];
  /** Secret outputs (passwords, keys): sealed by the caller, returned to tenants as SecretRefs only. */
  secretOutputs?: readonly string[];
  regional: boolean;
  /** Spec fields `ensure` changes in place; a change to any other is refused (`INVALID_STATE`, `replaceRequired`). */
  updatable: readonly string[];
  meters?: readonly { meter: string; unit: string }[];
  /** A provider preview: refused unless the account enables previews. */
  preview?: boolean;
  /** Another kind this one lives in (a database user in its cluster): its spec names the parent's provider id. */
  parent?: string;
  /**
   * (Pure, no I/O.) The spec's fields that reach account-wide objects of the provider account: a VPC, a registry,
   * linked repositories, another resource by name. A spec naming any is refused unless the account is the tenant's
   * own (`accountScope: 'tenant'`): the caller refuses it before it records the resource or the change, and
   * `ensure` refuses it again. Absent: the kind reaches none.
   */
  accountWide?(spec: unknown): readonly string[];
  /**
   * (Pure, no I/O.) For a kind with a `parent`: what the resource is at the provider within its parent, when the
   * provider allows one of it per parent (a database user by its name, a cluster's single firewall). Two live
   * resources of the kind in one parent with the same identity would be one provider resource managed twice: the
   * caller refuses the second (`CONFLICT`, `reason 'identity'`). Absent or undefined: each resource is its own.
   */
  identity?(spec: unknown): string | undefined;
  /**
   * (Pure, no I/O.) The better-compute instance ids the spec names (a database's trusted instances). The caller
   * refuses an id that is not a live instance of the resource's tenant on the same provider account (`INVALID_INPUT`,
   * `reason 'instance'`) before it records the resource or the change; the provider maps each to its own handle (on
   * DigitalOcean the Droplet's instance tag). Unlike raw machine ids or tags, they never reach another tenant's
   * machines, so they are not account-wide.
   */
  instances?(spec: unknown): readonly string[];
  /**
   * (Pure, no I/O.) The better-compute network ids the spec names (a database joining a tenant network). The caller
   * refuses an id that is not a live network of the resource's tenant on the same provider account, or one shared
   * with machines of other tenants on an account that is not the tenant's own (`INVALID_INPUT`, `reason 'network'`),
   * and passes each one's provider-side name in `ProviderResourceRequest.networks`. A tenant's own network reaches
   * only its machines, so it is not account-wide.
   */
  networks?(spec: unknown): readonly string[];
}

/** (cloud-resources) What `ProviderResources.ensure` is asked for. */
export interface ProviderResourceRequest {
  kind: string;
  /** The provider-side name the caller derives (`bc-r-…`); stable across calls. */
  name: string;
  /** The spec, already validated by the kind's manifest. */
  spec: unknown;
  /** The provider id an earlier `ensure` answered; absent until the provider accepted the resource once. */
  id?: string;
  /** For a kind with a `parent` (a database user): the provider id of the resource it lives in. */
  parent?: string;
  /** Ownership labels (`better-compute-managed`, `-resource`, `-tenant`), written as the provider writes labels. */
  labels?: Readonly<Record<string, string>>;
  /**
   * Whose provider account it is. `tenant`: it belongs to the resource's tenant alone (a BYO account). `shared`: it
   * serves other tenants too (a hosted pool). Absent counts as `shared`: a kind then refuses a spec that reaches
   * account-wide objects (a VPC, a registry, linked repositories, another resource by name).
   */
  accountScope?: 'tenant' | 'shared';
  /**
   * For a kind with `networks`: each network id the spec names, mapped to its provider-side name (what a provider's
   * `NetworkRef.network` carries), checked by the caller as `ProviderResourceKind.networks` says. A provider refuses
   * a spec network missing here: a bare id is never trusted.
   */
  networks?: Readonly<Record<string, string>>;
}

/** (cloud-resources) A resource the account can see, managed by better-compute or not. */
export interface ProviderDiscoveredResource {
  id: string;
  name: string;
  region?: string;
  /** `this`: this deployment manages it; `other`: another deployment does; absent: no one does. */
  managedBy?: 'this' | 'other';
  /** The plain outputs, when the listing has them. */
  outputs?: Readonly<Record<string, string>>;
  /** The spec as the provider reports it, in the kind's spec shape where it can be read back. */
  spec?: Readonly<Record<string, unknown>>;
}

/**
 * (cloud-resources) The long tail of provider services through one desired-state interface. `ensure` and `delete`
 * are idempotent and non-blocking, like `ProviderNetworks`: they return `pending`, `updating` or `deleting` while the
 * provider works, and the caller calls again. `ensure` is idempotent by `CallContext.idempotencyKey` (the resource
 * id) and changes the kind's `updatable` fields in place; any other difference is `INVALID_STATE` with
 * `details.reason 'replaceRequired'`. `delete` refuses (`INVALID_STATE`, `reason 'notManaged'`) a resource this
 * deployment does not manage, and sends nothing then.
 */
export interface ProviderResources {
  kinds(): readonly ProviderResourceKind[];
  ensure(request: ProviderResourceRequest, context: CallContext): Promise<ProviderResourceState>;
  /** The resource as it is; undefined when it does not exist. */
  get(kind: string, id: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  /**
   * The provider id of the resource an earlier `ensure` of this request made, found the way `ensure` finds it (by
   * `CallContext.idempotencyKey`, the provider-side name, or a child's identity in `request.parent`); undefined when
   * there is none. Read-only: it never creates or changes anything. The caller asks before it forgets a resource
   * whose create was sent but never answered (a timeout after the provider accepted it), so it can delete it.
   * Absent: the caller cannot tell, and keeps such a resource in error rather than forget it.
   */
  find?(request: ProviderResourceRequest, context: CallContext): Promise<string | undefined>;
  delete(kind: string, id: string, context: CallContext): Promise<ProviderResourceState>;
  /** Every resource of the kind the account can see. */
  discover?(kind: string, context: CallContext): AsyncIterable<ProviderDiscoveredResource>;
  /**
   * Takes over an unmanaged resource: writes the ownership labels. A resource another deployment manages is
   * `INVALID_STATE` (`reason 'managedByAnother'`).
   */
  adopt?(
    kind: string,
    id: string,
    labels: Readonly<Record<string, string>>,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  /** Removes the ownership labels and leaves the resource running. */
  release?(kind: string, id: string, context: CallContext): Promise<void>;
  /**
   * The installable applications the provider lists (DigitalOcean 1-Click apps, a marketplace): read-only. Each is
   * installed through another surface, not `ensure`: an `instance` one as the image of an instance create, a
   * `kubernetes` one as an add-on of a managed cluster.
   */
  catalog?(context: CallContext): Promise<readonly ProviderCatalogEntry[]>;
}

/** (cloud-resources) One installable application of a provider's catalog (`ProviderResources.catalog`). */
export interface ProviderCatalogEntry {
  /** The provider's slug: `[a-z0-9][a-z0-9._-]`, at most 100 characters (`wordpress-20-04`). */
  slug: string;
  /** Where it installs: `instance` (an image for an instance create) or `kubernetes` (a managed cluster add-on). */
  installsOn: 'instance' | 'kubernetes';
  /** A display name, when the provider has one. */
  name?: string;
}

/**
 * (provider volumes) A volume as vps asks for it. `name` is the provider-side name vps derives: unique per region and
 * account, so a retried ensure finds the volume its first attempt made. `kind: 'shared'` is a network filesystem
 * (NFS); a provider without one refuses it with `UNSUPPORTED`.
 */
export interface ProviderVolumeSpec {
  name: string;
  region: string;
  /** Whole GiB, at least 1. */
  sizeGiB: number;
  kind: 'block' | 'shared';
  /**
   * The filesystem the provider formats the volume with; absent or `none`: left raw. Ignored with `snapshotId`: a
   * restored volume keeps the snapshot's filesystem (a format would wipe it), and a provider neither asks for one nor
   * compares it.
   */
  filesystem?: 'ext4' | 'xfs' | 'none';
  /**
   * Creates the volume from this snapshot (an id `snapshotVolume` returned); `sizeGiB` is at least the snapshot's. A
   * provider restores only a snapshot it made for this deployment (`INVALID_STATE` otherwise, before any write).
   */
  snapshotId?: string;
  /** Plain labels, written as the provider's labels or tags. `better-compute-*` keys are the provider's own. */
  labels?: Readonly<Record<string, string>>;
  /**
   * The zone of `region` the volume lives in, for providers whose volumes are zonal (EBS, GCE persistent disks).
   * Absent: the zone `region` names (when it is one), else the account's only zone; with several, the provider
   * refuses the volume (`INVALID_INPUT`) rather than pick one. A provider without zones ignores it.
   */
  zone?: string;
  /** The provider's volume type (one of `ProviderVolumes.types`, e.g. EBS `gp3`); absent: the provider default. */
  type?: string;
  /** Provisioned IOPS, for the types that take them (EBS gp3, io1, io2). */
  iops?: number;
  /** Provisioned throughput in MiB/s, for the types that take it (EBS gp3). */
  throughputMiBps?: number;
  /**
   * (v1.x, `kind: 'shared'`) The tenant network the share is reachable from: a network file share is reached over
   * a private network, so a provider that needs one (DigitalOcean) refuses a shared volume without it
   * (`INVALID_INPUT`, reason `network`). Block volumes ignore it.
   */
  network?: NetworkRef;
}

/** (provider volumes) Options of `ProviderVolumes.detachVolume`. */
export interface ProviderDetachOptions {
  /** Detach without waiting for the guest to release the volume (unflushed writes may be lost). */
  force?: boolean;
}

/**
 * (provider volumes) Block volumes and their snapshots on a provider account. Every call is idempotent and
 * non-blocking, like `ProviderNetworks`: it returns `pending`, `updating` or `deleting` while a provider operation
 * runs, and the reconciler calls again. Ids are the ones `ensureVolume` and `snapshotVolume` returned.
 *
 * A volume's outputs: `region`, `sizeGiB`, `filesystem` (when formatted), `device` (the guest path it appears at
 * once attached) and `attachedTo` (the machine id; absent while detached). A snapshot's: `volume`, `region` and
 * `sizeGiB`. `attachVolume` and `detachVolume` return the attachment's state: `pending` then `ready`, `deleting`
 * then `deleted`. A provider only acts on volumes and snapshots it made for this deployment (`INVALID_STATE`
 * otherwise); a volume in another region than the machine is `INVALID_INPUT` before any write; a volume attached to
 * another machine is `CONFLICT`; an attached volume is not deleted (`INVALID_STATE`); `resizeVolume` only grows
 * (`INVALID_INPUT` for a smaller size).
 *
 * A `kind: 'shared'` volume (a network file share) attaches to many machines at once: `attachVolume` makes it
 * reachable from the machine and returns its outputs with `attachedTo` naming that machine; `getVolume` reports no
 * `attachedTo`. Its `device` is the NFS source the guest mounts (`<host>:<path>`), `filesystem` is `nfs`, and
 * `kind` is `shared`. A shared volume that any machine still has attached is not deleted (`INVALID_STATE`).
 */
export interface ProviderVolumes {
  /**
   * (v1.x) The volume kinds the provider makes; absent: `block` only. A caller refuses a `kind: 'shared'` volume
   * (`UNSUPPORTED`) on a provider that does not list `shared`, before anything is booked.
   */
  readonly kinds?: readonly ProviderVolumeSpec['kind'][];
  /**
   * (v1.x) Refuses a spec `ensureVolume` would refuse before any request (`INVALID_INPUT`, `UNSUPPORTED`: a size
   * the provider does not make, a share without a network), synchronously and with no provider call, so a caller
   * refuses it before anything is booked. Optional: without it the refusal comes from `ensureVolume`.
   */
  checkVolume?(spec: ProviderVolumeSpec): void;
  ensureVolume(spec: ProviderVolumeSpec, context: CallContext): Promise<ProviderResourceState>;
  /** The volume as it is; undefined when it does not exist. */
  getVolume(volumeId: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  /**
   * The volume named `name` in `region` that this deployment made, without creating one: undefined when there is
   * none (a same-named volume that is not ours is none). A delete whose create answer was lost finds it by this
   * instead of an `ensureVolume`, which could create a volume only to delete it. Optional: without it, vps falls
   * back to `ensureVolume` for that one case.
   */
  findVolume?(
    name: string,
    region: string,
    context: CallContext,
    /** (v1.x) The kind the volume was ensured as; absent: `block`. */
    kind?: ProviderVolumeSpec['kind'],
  ): Promise<ProviderResourceState | undefined>;
  /** With `instanceId`, only a machine whose ownership label names that instance is attached to. */
  attachVolume(
    volumeId: string,
    machineId: string,
    context: CallContext,
    instanceId?: string,
  ): Promise<ProviderResourceState>;
  /**
   * With `force`, the provider detaches even though the guest has not released the volume (EBS `Force`), also a
   * detach already under way that is stuck; writes the guest has not flushed may be lost. A provider without a
   * forced detach ignores it. Optional: absent is a plain detach.
   */
  detachVolume(
    volumeId: string,
    machineId: string,
    context: CallContext,
    options?: ProviderDetachOptions,
  ): Promise<ProviderResourceState>;
  resizeVolume(
    volumeId: string,
    sizeGiB: number,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  deleteVolume(volumeId: string, context: CallContext): Promise<ProviderResourceState>;
  /** A snapshot of the volume named `name`; a second call with the same name returns the same snapshot. */
  snapshotVolume(
    volumeId: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  getSnapshot(snapshotId: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  deleteSnapshot(snapshotId: string, context: CallContext): Promise<ProviderResourceState>;
  /** The volume types `ProviderVolumeSpec.type` may name (e.g. `['gp3', 'io2', 'st1', 'sc1']`); absent: none. */
  readonly types?: readonly string[];
}

/** (provider addresses) A reserved public address as vps asks for it. */
export interface ProviderAddressSpec {
  name: string;
  region: string;
  family: 'ipv4' | 'ipv6';
  /** `pool`: one from the provider's pool (the default). `byoip`: from the account's own prefix. */
  source?: 'pool' | 'byoip';
  /** The BYOIP prefix to draw from. */
  prefix?: string;
  /**
   * The id an earlier `ensureAddress` of this address returned. A provider whose addresses carry no name or tag
   * (DigitalOcean) finds the address by it; without it, it reserves a new one.
   */
  id?: string;
  /**
   * With `id`: the `fingerprint` output the reserve returned. An address at that id whose fingerprint differs (the
   * address was released and handed out again) is `INVALID_STATE` (reason `notManaged`), never taken over.
   */
  fingerprint?: string;
}

/**
 * (provider addresses) What vps recorded about an address it reserved, for a provider whose addresses carry no tag:
 * an address that does not match is `INVALID_STATE` (reason `notManaged`) and is never released.
 */
export interface ProviderAddressExpectation {
  region?: string;
  /** The `fingerprint` output the reserve returned. */
  fingerprint?: string;
}

/**
 * (provider addresses) Reserved public addresses on a provider account, idempotent and non-blocking like
 * `ProviderVolumes`. Outputs: `address`, `family`, `region`, `assignedTo` (the machine id; absent while
 * unassigned) and, where the provider has one, `fingerprint`: what tells this reservation apart from a later one at
 * the same address (DigitalOcean: a reserved IPv6's reservation time; a reserved IPv4 has none). `assignAddress` and `unassignAddress` return the assignment's state (`pending`/`ready`,
 * `deleting`/`deleted`). An address assigned to another machine is `CONFLICT` (never moved silently); an assigned
 * address is not deleted (`INVALID_STATE`); a machine in another region is `INVALID_INPUT`.
 */
export interface ProviderAddresses {
  ensureAddress(spec: ProviderAddressSpec, context: CallContext): Promise<ProviderResourceState>;
  getAddress(addressId: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  /** With `instanceId`, only a machine whose ownership label names that instance gets the address. */
  assignAddress(
    addressId: string,
    machineId: string,
    context: CallContext,
    instanceId?: string,
  ): Promise<ProviderResourceState>;
  unassignAddress(addressId: string, context: CallContext): Promise<ProviderResourceState>;
  /** With `expected`, an address that does not match what was recorded is refused (`notManaged`). */
  deleteAddress(
    addressId: string,
    context: CallContext,
    expected?: ProviderAddressExpectation,
  ): Promise<ProviderResourceState>;
}

/** (edge) One forwarding rule of a load balancer: traffic arriving on `entry*` goes to each target's `target*`. */
export interface ProviderLoadBalancerRule {
  entryProtocol: 'http' | 'https' | 'http2' | 'tcp' | 'udp';
  entryPort: number;
  targetProtocol: 'http' | 'https' | 'http2' | 'tcp' | 'udp';
  targetPort: number;
  /** An `https`/`http2` entry terminates TLS with this certificate (an id `ProviderCertificates` returned). */
  certificate?: string;
  /** An `https` entry passes TLS through to the targets untouched (no certificate). */
  tlsPassthrough?: boolean;
}

/** (edge) How a load balancer checks its targets. Absent fields take the provider's defaults. */
export interface ProviderLoadBalancerHealthCheck {
  protocol: 'http' | 'https' | 'tcp';
  port: number;
  /** `http`/`https` only: the path asked for (default `/`). */
  path?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  healthyThreshold?: number;
  unhealthyThreshold?: number;
}

/**
 * (edge) A load balancer as vps asks for it. `name` is the provider-side name vps derives; a retried ensure finds
 * the load balancer its first attempt made by it (or by `id`).
 *
 * Targets are explicit: `machines` (a `regional` load balancer's machine ids, all in its region) or `loadBalancers`
 * (a `global` one's regional load balancers, by the ids `ensureLoadBalancer` returned). vps re-ensures with the new
 * list when a pool's membership changes. A provider only targets machines that belong to an instance of this
 * deployment, and load balancers it made, so a load balancer never reaches another tenant's machines.
 */
export interface ProviderLoadBalancerSpec {
  name: string;
  /** `regional`: in `region`, in front of machines. `global`: anycast, in front of regional load balancers. */
  scope: 'regional' | 'global';
  /** `regional` only, and required there. */
  region?: string;
  /** At least one. */
  forwarding: readonly ProviderLoadBalancerRule[];
  healthCheck?: ProviderLoadBalancerHealthCheck;
  targets: { machines?: readonly string[]; loadBalancers?: readonly string[] };
  /** Pins a client to one target by a cookie. Absent: none. */
  stickySessions?: { cookieName: string; ttlSeconds: number };
  /** Source CIDRs. With `allow`, only those connect; `deny` always wins. */
  sourceRanges?: { allow?: readonly string[]; deny?: readonly string[] };
  /** Answers plain `http` with a redirect to `https`. */
  redirectHttpToHttps?: boolean;
  /** `regional` only: the provider network and subnet the load balancer and its targets are on. */
  network?: { network: string; subnet?: string };
  /** `regional` only: an address reachable only on `network`. */
  internal?: boolean;
  /** `global` only: the host names it serves, each with the certificate it terminates TLS with. */
  domains?: readonly { name: string; certificate?: string }[];
  /**
   * The id an earlier ensure of this load balancer returned. A provider whose names are not unique finds it by this
   * first; a load balancer at that id that is not this one is `INVALID_STATE` (reason `notManaged`).
   */
  id?: string;
}

/**
 * (edge) Load balancers on a provider account, idempotent and non-blocking like `ProviderVolumes`: `ensure` reports
 * `pending` while the provider provisions one and `ready` once it serves. Outputs: `scope`, `region` (regional),
 * `address` (its public or internal IPv4, once assigned) and `addressV6` (where it has one). `ensureLoadBalancer`
 * changes `forwarding`, `healthCheck`, `targets`, `stickySessions`, `sourceRanges`, `redirectHttpToHttps` and
 * `domains` in place (`updating` while the provider applies it); a different `scope`, `region`, `network` or
 * `internal` is `INVALID_STATE` (reason `replace`). A target machine in another region is `INVALID_INPUT`; one that
 * is not an instance of this deployment, or a load balancer the provider did not make, is `INVALID_STATE`. A provider
 * only deletes load balancers it made for this deployment (`INVALID_STATE`, reason `notManaged`).
 */
export interface ProviderLoadBalancers {
  ensureLoadBalancer(
    spec: ProviderLoadBalancerSpec,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  /** The load balancer as it is; undefined when it does not exist. */
  getLoadBalancer(id: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  /** The load balancer named `name` this deployment made, without creating one (as `ProviderVolumes.findVolume`). */
  findLoadBalancer?(name: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  deleteLoadBalancer(id: string, context: CallContext): Promise<ProviderResourceState>;
}

/** (edge) A DNS zone as vps asks for it: `name` is the domain (`example.com`), lowercase, without a final dot. */
export interface ProviderDnsZoneSpec {
  name: string;
  /**
   * Takes over a zone that already exists on the account and was not made by this deployment. An adopted zone's
   * records are changed only where vps made them, and the zone itself is never deleted by `deleteZone`. Without it, a
   * foreign zone is `CONFLICT` (reason `zoneExists`). A new zone inside or above a foreign zone of the account is
   * `CONFLICT` (reason `zoneNested`): it would publish records under a domain this deployment does not own.
   */
  adopt?: boolean;
}

/** (edge) One DNS record in a zone. */
export interface ProviderDnsRecordSpec {
  /** Relative to the zone: `@` is the apex, `www` is `www.<zone>`. */
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'SRV' | 'CAA' | 'NS';
  /** An address (`A`/`AAAA`), a host name (`CNAME`/`MX`/`SRV`/`NS`, absolute with a final dot), text (`TXT`/`CAA`). */
  data: string;
  ttlSeconds?: number;
  /** `MX` and `SRV`. */
  priority?: number;
  /** `SRV`. */
  port?: number;
  /** `SRV`. */
  weight?: number;
  /** `CAA`: the flags byte. */
  flags?: number;
  /** `CAA`: `issue`, `issuewild` or `iodef`. */
  tag?: string;
  /** The id an earlier `ensureRecord` of this record returned. */
  id?: string;
}

/**
 * (edge) DNS zones and records on a provider account. Every call is idempotent; DNS changes take effect when the call
 * returns, so states are `ready` and `deleted`. A zone's id is its name; its outputs: `nameServers` (comma-separated)
 * and `adopted` (`true` for a zone `adopt` took over). A record's outputs: `name`, `type`, `data`, `fqdn` and
 * `ttlSeconds`. `ensureRecord` without `id` returns an existing record with the same name, type and data instead of
 * making a second one; with `id`, it changes `data`, `ttlSeconds` and the type's own fields in place, and a record at
 * that id with another name or type is `INVALID_STATE`. A provider never deletes a zone it did not make
 * (`INVALID_STATE`, reason `notManaged`), and never touches the records it keeps for itself.
 */
export interface ProviderDns {
  ensureZone(spec: ProviderDnsZoneSpec, context: CallContext): Promise<ProviderResourceState>;
  getZone(zone: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  deleteZone(zone: string, context: CallContext): Promise<ProviderResourceState>;
  ensureRecord(
    zone: string,
    spec: ProviderDnsRecordSpec,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  getRecord(
    zone: string,
    id: string,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined>;
  /** With `expected`, a record at `id` with another name or type is refused (`INVALID_STATE`), never deleted. */
  deleteRecord(
    zone: string,
    id: string,
    context: CallContext,
    expected?: { name: string; type: ProviderDnsRecordSpec['type'] },
  ): Promise<ProviderResourceState>;
}

/**
 * (edge) A TLS certificate as vps asks for it. `managed`: the provider issues and renews it for `domains` (on
 * DigitalOcean, only names in a zone it hosts). `custom`: PEMs the tenant uploads, as secret references resolved
 * just in time and never stored or returned by the provider.
 */
export interface ProviderCertificateSpec {
  name: string;
  kind: 'managed' | 'custom';
  /** `managed`: the names it covers (at least one; `*.example.com` for a wildcard). */
  domains?: readonly string[];
  /** `custom`: the leaf certificate, PEM. */
  certificate?: SecretRef;
  /** `custom`: its private key, PEM. */
  privateKey?: SecretRef;
  /** `custom`: the intermediate chain, PEM. */
  chain?: SecretRef;
}

/**
 * (edge) TLS certificates on a provider account, for load balancers. A certificate is immutable: `ensureCertificate`
 * returns the one named `name` when it matches the spec and is `INVALID_STATE` (reason `replace`) when its kind or
 * names differ. A `managed` certificate is `pending` until issued. Outputs: `kind`, `domains` (comma-separated),
 * `notAfter` (ISO 8601, once issued) and `fingerprint` (SHA-1, hex). A provider only deletes certificates it made for
 * this deployment (`INVALID_STATE`, reason `notManaged`); one a load balancer still uses is `CONFLICT`.
 */
export interface ProviderCertificates {
  ensureCertificate(
    spec: ProviderCertificateSpec,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  getCertificate(id: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  deleteCertificate(id: string, context: CallContext): Promise<ProviderResourceState>;
}

/**
 * (kubernetes) A managed Kubernetes cluster as the kubernetes module asks for it. The provider runs the control plane
 * (GKE, DOKS); better-compute never does. `name` is the provider-side name the module derives (`bc-k-…`).
 */
export interface KubernetesClusterSpec {
  name: string;
  /** A region (a regional cluster) or a zone (a zonal one). */
  location: string;
  /** `standard`: node pools the module manages. `autopilot`: the provider runs the nodes; no node pools. */
  mode: 'standard' | 'autopilot';
  /** The provider's release channel; it upgrades the cluster on its own within the channel. */
  releaseChannel: 'rapid' | 'regular' | 'stable' | 'extended';
  /** A minor (`1.33`) or full control-plane version; absent: the channel's default. Raising it upgrades in place. */
  version?: string;
  /** The provider network and subnet the nodes live on; absent: the account's own network config. */
  network?: { network: string; subnet?: string };
  /** CIDRs that may reach the public control-plane endpoint; empty: everyone (still authenticated). */
  authorizedNetworks: readonly string[];
  /** Nodes get no public addresses (their egress then needs a NAT on the network). */
  privateNodes: boolean;
  /**
   * `standard` only, used only when the cluster is created (GKE creates a Standard cluster with its node pools):
   * at least one. Later pools go through `ensureNodePool`.
   */
  initialNodePools?: readonly KubernetesNodePoolSpec[];
  labels?: Readonly<Record<string, string>>;
  description?: string;
}

/** (kubernetes) A node pool of a `standard` cluster. */
export interface KubernetesNodePoolSpec {
  name: string;
  machineType: string;
  /** Nodes per zone of the pool. With `autoscaling`, the initial count. */
  nodeCount: number;
  autoscaling?: { minNodes: number; maxNodes: number };
  diskGiB?: number;
  diskType?: string;
  spot?: boolean;
  /** GPUs per node, by the provider's accelerator type (`nvidia-l4`). */
  accelerators?: { type: string; count: number };
  /** Zones of the cluster's region; absent: the provider's default. */
  zones?: readonly string[];
  labels?: Readonly<Record<string, string>>;
  taints?: readonly {
    key: string;
    value?: string;
    effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  }[];
}

/**
 * (kubernetes) A credential for one principal: the module never stores one, and never holds a cluster-admin kubeconfig.
 * The provider creates (or reuses) a Kubernetes service account named `subject`, binds it to a ClusterRole for
 * `role` (`view`, an edit role, `cluster-admin`) and mints a bound token through the TokenRequest API. An edit
 * subject must not be able to act as another subject's service account (EKS: `better-compute:edit` and an admission guard).
 */
export interface KubernetesCredentialRequest {
  /** A DNS-1123 label the module derives from the IAM identity (`bc-u-…`). */
  subject: string;
  role: 'view' | 'edit' | 'admin';
  /** At least 600 (the API's floor), at most 86400. */
  ttlSeconds: number;
}
export interface KubernetesCredentials {
  /** `https://<address>` of the control plane. */
  server: string;
  /** PEM, base64 as the kubeconfig `certificate-authority-data` takes it. */
  certificateAuthorityData: string;
  token: string;
  expiresAt: number;
}

/** (kubernetes) The provider's Kubernetes versions in a location. */
export interface KubernetesVersions {
  defaultVersion: string;
  validVersions: readonly string[];
  channels: Readonly<
    Partial<
      Record<
        KubernetesClusterSpec['releaseChannel'],
        { defaultVersion: string; validVersions: readonly string[] }
      >
    >
  >;
}

/**
 * (kubernetes) Managed Kubernetes on a provider account. `ensure*` and `delete*` are idempotent and non-blocking, like
 * `ProviderNetworks`: they return `pending`, `updating` or `deleting` while a provider operation runs, and the
 * reconciler calls again. `cluster` is the `id` `ensureCluster` returned. `ensureCluster` outputs `endpoint`,
 * `version`, `location` and `nodeVersion` once ready; it changes `version`, `releaseChannel` and `authorizedNetworks`
 * in place and refuses any other difference with `INVALID_STATE`.
 */
export interface ProviderKubernetes {
  ensureCluster(spec: KubernetesClusterSpec, context: CallContext): Promise<ProviderResourceState>;
  /** The cluster as it is; undefined when it does not exist. */
  getCluster(cluster: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  deleteCluster(cluster: string, context: CallContext): Promise<ProviderResourceState>;
  /** Changes `nodeCount` and `autoscaling` in place; any other difference is `INVALID_STATE`. */
  ensureNodePool(
    cluster: string,
    spec: KubernetesNodePoolSpec,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  deleteNodePool(
    cluster: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  credentials(
    cluster: string,
    request: KubernetesCredentialRequest,
    context: CallContext,
  ): Promise<KubernetesCredentials>;
  versions(location: string, context: CallContext): Promise<KubernetesVersions>;
  /**
   * (AWS A9) The clusters on the account, whoever created them, with what machines need to join one
   * (`policy.kubernetes`): for EKS, nodeadm's cluster (`eks`). Plain values only, never credentials.
   */
  listClusters?(context: CallContext): Promise<ProviderKubernetesCluster[]>;
  /** (AWS A9) Clusters are regional only (EKS): a zone as a cluster location is refused at create. */
  readonly regionalOnly?: boolean;
}

/** (AWS A9) One cluster of `ProviderKubernetes.listClusters`. */
export interface ProviderKubernetesCluster {
  /** The provider-side name, and the `cluster` id `getCluster` takes. */
  name: string;
  id: string;
  location: string;
  state: ProviderResourceState['state'];
  version?: string;
  /** `https://…` of the control plane. */
  endpoint?: string;
  /** better-compute created it (its managed tag or label). */
  managed: boolean;
  /** EKS: `policy.kubernetes.eks` for machines that join it through nodeadm (`k8s-join` mode `eks`). */
  eks?: { name: string; apiServerEndpoint: string; certificateAuthority: string; cidr: string };
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

/**
 * (AWS A4, AD12) What a provider's event intake reports. Events only wake reconcilers early: polling
 * stays the source of truth, so an event never writes machine state by itself.
 */
export type ProviderEventKind =
  | 'machine-changed'
  | 'interruption-warning'
  | 'rebalance-recommended'
  | 'maintenance-scheduled'
  | 'reservation-changed'
  | 'health'
  | 'api-call';

/** One authenticated provider event (the provider already dropped foreign or unknown ones). */
export interface ProviderEvent {
  /** The provider's event id, unique per account: vps processes each id once. */
  id: string;
  kind: ProviderEventKind;
  /** The machine (`ExternalMachine.id`) the event is about. */
  machineId?: string;
  reservationId?: string;
  /** When the provider says the event happened (epoch ms). */
  at: number;
  /** The interruption or maintenance time (epoch ms). */
  deadline?: number;
  /** Short provider facts (state, event code, status); never secrets or raw message bodies. */
  details?: Readonly<Record<string, string>>;
}

/** One poll's events. `ack` removes them at the provider; vps calls it after its transaction commits. */
export interface ProviderEventBatch {
  events: readonly ProviderEvent[];
  /**
   * (AWS A4) How many queue messages the poll read, mapped or dropped (0 for a source that is no
   * queue). One message can map to many events or none, so vps polls again while this equals
   * `max`. Absent: vps counts `events`.
   */
  received?: number;
  ack(): Promise<void>;
}

/**
 * (P2) What a machine's delete may take down with it. Optional: a provider that cannot delete associated resources in
 * the same call ignores it, and the caller deletes them after the machine (so naming one is never required for it to
 * go). A provider names only resources it would delete on its own (ours, attached to that machine): a tenant's own
 * volume attached by hand always survives.
 */
export interface ProviderDeleteOptions {
  /** Provider ids (as `ProviderVolumes` returns them) of volumes attached to the machine, to delete with it. */
  volumes?: readonly string[];
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
      /**
       * (AWS A10) The placement group to launch into. Only sent with a strategy the provider lists in
       * `placementStrategies` (vps refuses the rest); a provider without placement groups ignores it.
       */
      placement?: ProviderPlacement;
      /** (AWS A10) Filesystems the machine mounts at boot; a provider without filesystems ignores it. */
      mounts?: readonly ProviderMount[];
      labels?: Readonly<Record<string, string>>;
      /**
       * The instance's OpenSSH public keys, also rendered into `userData` when it has none. A
       * provider that can install keys without cloud-init (Compute Engine's `ssh-keys`) does.
       */
      sshKeys?: readonly string[];
      /**
       * (AWS A9) The machine is a node of the account's EKS cluster (its user data carries nodeadm's
       * NodeConfig; vps sets this only for the pool owner's instances): the provider launches it with
       * its EKS node identity, which no other launch of the account ever gets.
       */
      kubernetesNode?: 'eks';
      /** (DO P3) The catalog image `image` names, as the host resolved it; absent for other refs. */
      catalogImage?: CatalogImageIdentity;
    },
    context: CallContext,
  ): Promise<ExternalMachine>;
  get(id: string, context: CallContext): Promise<ExternalMachine | undefined>;
  /** A machine that is already gone counts as deleted (`NOT_FOUND` ⇒ success). */
  delete(id: string, context: CallContext, options?: ProviderDeleteOptions): Promise<void>;
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
  reinstall?(
    id: string,
    image: ImageRef,
    context: CallContext,
    /** (DO P3) The catalog image `image` names, as the host resolved it. */
    options?: { catalogImage?: CatalogImageIdentity },
  ): Promise<void>;
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
  /** (AWS A3) Capacity the account could buy that matches `query`. A read; it never spends. */
  listReservationOfferings?(
    query: ReservationOfferingQuery,
    context: CallContext,
  ): Promise<ReservationOffering[]>;
  /**
   * (AWS A3) Buys an offering. **Spends money.** vps calls it only for a root caller, after
   * confirmation, with a stable `idempotencyKey`, so a retried purchase buys once.
   */
  purchaseReservation?(
    offeringId: string,
    context: CallContext,
    attempt?: PurchaseAttempt,
  ): Promise<ExternalReservation>;
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
   * (AWS A10) The placement group strategies `create({ placement })` honors. Absent or empty: the
   * provider has no placement groups, and a placement asked of it is refused rather than ignored.
   */
  readonly placementStrategies?: readonly ProviderPlacement['strategy'][];
  /** (AWS A10) Shared filesystems (EFS, FSx for Lustre) on this account's networks. */
  filesystems?: ProviderFilesystems;
  /** The region a zone is in, when the zone's name does not end in `-<letter>` (AWS `us-east-1a`, `us-west-2-lax-1a`). */
  zoneRegion?(zone: string): string;
  /** (kubernetes) Managed Kubernetes clusters and node pools on this account. */
  kubernetes?: ProviderKubernetes;
  /** (provider volumes) Block volumes and snapshots on this account. */
  volumes?: ProviderVolumes;
  /** (provider addresses) Reserved public addresses on this account. */
  addresses?: ProviderAddresses;
  /** (cloud-resources) Managed data and platform services through the generic resource contract. */
  resources?: ProviderResources;
  /** (edge) Load balancers on this account. */
  loadBalancers?: ProviderLoadBalancers;
  /** (edge) DNS zones and records on this account. */
  dns?: ProviderDns;
  /** (edge) TLS certificates on this account, for load balancers. */
  certificates?: ProviderCertificates;
  /**
   * (v1.0, D10) The account's billed cost rows whose usage started in `[window.from, window.to)`.
   * Read outside any transaction. A provider whose export is not configured leaves it absent.
   */
  costs?(
    window: { from: number; to: number },
    context: CallContext,
  ): AsyncIterable<ProviderCostRecord>;
  /**
   * (AWS A4) Long-polls the account's event intake for at most `waitMs` (≤ 10 000) and returns at
   * most `max` events. Read outside any transaction; vps acks the batch after its transaction
   * commits, so an unacked batch is delivered again (vps drops ids it has seen).
   */
  pollEvents?(
    context: CallContext,
    options: { waitMs: number; max: number },
  ): Promise<ProviderEventBatch>;
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
   * (AWS A3) A person-readable account of a `ReservationOffering` id (what, where, when, what it
   * costs), shown to whoever approves the purchase; undefined for an id this provider does not
   * issue. Pure; no I/O.
   */
  describeOffering?(offeringId: string): string | undefined;
  /**
   * (AWS A7) What `providerAccounts.get` shows as the account's `onboarding`: what a tenant still
   * has to set up at its cloud for this account (e.g. the platform-assigned ExternalId its role must
   * require). Pure; no I/O; never a secret. A throw or a non-object result shows nothing.
   * `account.issuer` is the host's workload issuer URL (`pki.workload`), when it configures one.
   */
  describeAccount?(
    config: C,
    account: { id: string; tenantId: string; name: string; platform: boolean; issuer?: string },
  ): Record<string, Json> | undefined;
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
