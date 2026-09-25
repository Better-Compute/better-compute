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
  | 'node-adapter';

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

/** Resolves a `SecretRef` just in time; values live only in memory. */
export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
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
   * Labels every candidate node must carry with exactly these values (e.g. a runtime a host's bcd
   * advertised in Hello.drivers, `bc.dev/driver.kata`); absent: no label constraint.
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
  resolve(ref: SecretRef): Promise<string>;
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
}

/** Rescue-system access; the credential is stored as a secret, never returned as a value. */
export interface RescueAccess {
  address: string;
  username: string;
  credential: SecretRef;
  expiresAt?: number;
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
    request: { offerId: string; image: ImageRef; userData: string; name: string },
    context: CallContext,
  ): Promise<ExternalMachine>;
  get(id: string, context: CallContext): Promise<ExternalMachine | undefined>;
  /** A machine that is already gone counts as deleted (`NOT_FOUND` ⇒ success). */
  delete(id: string, context: CallContext): Promise<void>;
  /**
   * `agent: 'bcd'` pools only: delivers a single-use `provisioned` join token through rescue or
   * installimage, never through tenant-readable user-data.
   */
  bootstrap?(
    machine: ExternalMachine,
    bootstrap: { joinToken: string; bcdUrl: string; sha256: string },
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
}

export interface ProviderContext {
  clock: Clock;
  secrets: SecretResolver;
  log: Logger;
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
}

/** The durable command queue (§7.4). */
export interface CommandQueue {
  /** Inserts a `pending` command in `tx`; an existing idempotency key returns the existing command. */
  enqueue(tx: SqlTx, command: EnqueueCommand): Promise<{ id: string; seq: number }>;
  cancel(tx: SqlTx, commandId: string): Promise<void>;
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
   * `ctx.check` then `ctx.invoke`); the envelope still writes the mutation's audit row after success.
   */
  transaction?: 'auto' | 'manual';
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
  nodeSpec?(context: ModuleContext, node: NodeRecord): Promise<Partial<NodeSpec>>;
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
