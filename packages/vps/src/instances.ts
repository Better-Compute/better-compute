import {
  ComputeError,
  draftId,
  instanceStateTable,
  transition,
  type AdmissionContext,
  type AdmissionPlan,
  type AuthzAttributes,
  type CapacityPort,
  type Clock,
  type Condition,
  type EventPublisher,
  type ImageFormat,
  type Instance,
  type InstanceDesiredState,
  type InstanceState,
  type InstanceVerb,
  type Json,
  type Logger,
  type MethodContext,
  type ModuleContext,
  type SecretBroker,
  type SecretResolver,
  type SqlTx,
} from '@better-compute/core';
import { chargeQuota, refundQuota, resizeAllocation } from '@better-compute/capacity';
import type { ProviderClients } from './accounts.js';
import { readFlavorByName, type FlavorRecord } from './flavors.js';
import {
  canonical,
  fail,
  id,
  int,
  key,
  name,
  object,
  optional,
  sha256Hex,
  sshKeys,
  tenant,
} from './input.js';
import { leaseAddress } from './ipam.js';
import {
  chooseHostPlacement,
  placementResources,
  type FlavorPlacement,
} from './placement.js';
import { volumePlacement } from './volumes.js';
import { builtinRuntimeTraits, runtimeNodeLabels, type RuntimeTraits } from './runtime.js';

// Instances (PLAN.md §3.6, §11.1): request-as-resource drafts decided on `compute-instance/{draftId}`,
// admitted in the second transaction, then converged by the `vps.instances` reconciler toward
// `desiredState`. Later operations change only `desiredState`; the API never calls a runtime.

/** The work-queue kind of the instance reconciler. */
export const instanceWork = 'vps.instances';
/** Hosted allocations are open-ended: they last until the instance is deleted. */
export const openEnded = Date.UTC(9999, 0, 1);
/** Scheduling retries this often while nothing fits. */
export const scheduleRetryMs = 30_000;

/** An image as a hosted runtime boots it. */
export interface VpsImage {
  url: string;
  sha256: string;
  format: ImageFormat;
  /** Digest and signature checked against the tenant's signer allowlist. */
  verified: boolean;
}

/**
 * Resolves `imageId` for a tenant (visibility is compute's own check, §3.6). Hosted pools need one;
 * provider pools pass the id to the provider as an `ImageRef` and use it only for `verified`.
 */
export interface ImageResolver {
  resolve(tx: SqlTx, tenantId: string, imageId: string): Promise<VpsImage | undefined>;
}

/** What instance services need beyond a transaction. */
export interface InstanceDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  authz: ModuleContext['authz'];
  desired: ModuleContext['desired'];
  capacity: CapacityPort;
  log: Logger;
  secrets: SecretResolver;
  clients: ProviderClients;
  images?: ImageResolver;
  /** The default runtime of hosted pools (`vps({ runtimes })[0]`); a pool picks another with `policy.runtime`. */
  runtime: string;
  /** Runtimes hosted pools may run, with their traits (default: `runtime` with its built-in traits). */
  runtimes?: ReadonlyMap<string, RuntimeTraits>;
  /**
   * Seals hosted instances' rendered user data (`ModuleContext.secrets`), so the host can fetch it
   * through the broker. Without it, hosted instances boot without their keys and user data.
   */
  broker?: SecretBroker;
  /**
   * (v0.5, §3.7) Sandbox instances trust this SSH user CA for `sandboxes.exec`: their user data gains
   * a cloud-config part that creates `account` and accepts certificates for `<account>@<instanceId>`.
   */
  sandboxExec?: { caPublicKey: string; account: string; certifyHostKey?: CertifyHostKey };
}

/**
 * Certifies a sandbox instance's SSH host key with the sandbox CA (the tunnels module's
 * `sandboxSsh.issueHostCertificate`), so exec clients pin the guest instead of trusting on first use.
 * Returns the OpenSSH host certificate line.
 */
export type CertifyHostKey = (input: {
  instanceId: string;
  /** Host names the certificate is valid for (the instance id). */
  principals: string[];
  /** The host key's OpenSSH public key line (ecdsa-sha2-nistp256). */
  publicKey: string;
  /** Epoch ms. */
  validBefore: number;
}) => string | Promise<string>;

// --- Input --------------------------------------------------------------------------------------

export interface CreateInstanceInput {
  tenantId: string;
  poolId: string;
  projectId?: string;
  flavor: string;
  imageId: string;
  sshKeys: string[];
  userData?: string;
  desiredState: 'running' | 'stopped';
  idempotencyKey: string;
  /**
   * §9.1 async-with-wait: hold the answer up to `timeoutMs` (≤ 30 s) until the instance leaves
   * `pending`/`scheduling`/`provisioning`/`starting`. Not part of the request: a retry may differ.
   */
  wait?: { timeoutMs: number };
}

/** User data that starts like a URI (`secret://…`, `vault://…`, `env://…`) is a reference, not content. */
const uriLike = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** `secret://<tenantId>/<id>` (the local sealed store's refs). */
const secretRefPattern = /^secret:\/\/([^/]+)\/([^/]+)$/;

/** Whether `userData` is a `secret://` ref (sealed by vps, or brought by the tenant). */
export const isSecretRef = (userData: string | undefined): userData is `secret://${string}` =>
  userData !== undefined && secretRefPattern.test(userData);

export function parseCreateInstance(raw: unknown): CreateInstanceInput {
  const input = object(raw, [
    'tenantId',
    'poolId',
    'projectId',
    'flavor',
    'imageId',
    'sshKeys',
    'userData',
    'desiredState',
    'idempotencyKey',
    'wait',
  ]);
  if (
    typeof input.imageId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,199}$/.test(input.imageId)
  )
    fail('imageId is invalid');
  if (
    input.userData !== undefined &&
    (typeof input.userData !== 'string' || input.userData.length > 32_768)
  )
    fail('userData must be a string of at most 32 KiB');
  const tenantId = tenant(input.tenantId);
  // A ref is released to the host running this instance (§6 "Secrets"): only the caller's own.
  if (typeof input.userData === 'string' && uriLike.test(input.userData)) {
    const ref = secretRefPattern.exec(input.userData);
    if (!ref || ref[1] !== tenantId)
      fail(`userData as a reference must be secret://${tenantId}/<id>, a secret of this tenant`);
  }
  if (
    input.desiredState !== undefined &&
    input.desiredState !== 'running' &&
    input.desiredState !== 'stopped'
  )
    fail('desiredState must be running or stopped');
  const result: CreateInstanceInput = {
    tenantId,
    poolId: id(input.poolId, 'pool', 'poolId'),
    flavor: name(input.flavor, 'flavor'),
    imageId: input.imageId,
    sshKeys: sshKeys(input.sshKeys),
    desiredState: (input.desiredState as 'running' | 'stopped' | undefined) ?? 'running',
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) result.projectId = projectId;
  if (input.userData !== undefined) result.userData = input.userData as string;
  if (input.wait !== undefined) {
    if (typeof input.wait !== 'object' || input.wait === null || Array.isArray(input.wait))
      fail('wait must be an object');
    const wait = object(input.wait, ['timeoutMs']);
    result.wait = { timeoutMs: int(wait.timeoutMs, 'wait.timeoutMs', 0, 30_000) };
  }
  return result;
}

/** Instance states an `instances.create` wait holds on (the create is still in flight). */
const inFlight: ReadonlySet<string> = new Set([
  'pending',
  'scheduling',
  'provisioning',
  'starting',
]);

/** Whether a created instance is past the states a `wait` holds on. */
export const instanceSettled = (instance: Instance): boolean => !inFlight.has(instance.state);

export type InstanceRef = { tenantId: string; instanceId: string };

export function parseInstanceRef(raw: unknown): InstanceRef {
  const input = object(raw, ['tenantId', 'instanceId']);
  return {
    tenantId: tenant(input.tenantId),
    instanceId: id(input.instanceId, 'inst', 'instanceId'),
  };
}

export function parseResize(raw: unknown): InstanceRef & { flavor: string } {
  const input = object(raw, ['tenantId', 'instanceId', 'flavor']);
  return {
    tenantId: tenant(input.tenantId),
    instanceId: id(input.instanceId, 'inst', 'instanceId'),
    flavor: name(input.flavor, 'flavor'),
  };
}

export interface ListInstancesInput {
  tenantId: string;
  scope: 'mine' | 'all';
  state?: InstanceState;
  poolId?: string;
  limit?: number;
  cursor?: string;
}

export function parseListInstances(raw: unknown): ListInstancesInput {
  const input = object(raw, ['tenantId', 'scope', 'state', 'poolId', 'limit', 'cursor']);
  if (input.scope !== undefined && input.scope !== 'mine' && input.scope !== 'all')
    fail('scope must be mine or all');
  if (
    input.state !== undefined &&
    !(instanceStateTable.states as readonly unknown[]).includes(input.state)
  )
    fail('state is invalid');
  const result: ListInstancesInput = {
    tenantId: tenant(input.tenantId),
    scope: (input.scope as 'mine' | 'all' | undefined) ?? 'mine',
  };
  if (input.state !== undefined) result.state = input.state as InstanceState;
  const poolId = optional(input.poolId, (value) => id(value, 'pool', 'poolId'));
  if (poolId !== undefined) result.poolId = poolId;
  const limit = optional(input.limit, (value) => int(value, 'limit', 1, 200));
  if (limit !== undefined) result.limit = limit;
  const cursor = optional(input.cursor, (value) => {
    if (typeof value !== 'string' || !/^inst_[0-9a-z]{26,52}$/.test(value))
      fail('cursor is invalid');
    return value;
  });
  if (cursor !== undefined) result.cursor = cursor;
  return result;
}

// --- Rows -----------------------------------------------------------------------------------------

/** The flavor an instance was admitted with. */
export interface InstanceShape {
  name: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus: number;
  offerId?: string;
  /** (v1.1 §3.8) The flavor's placement, as admitted. */
  placement?: FlavorPlacement;
}

interface RawInstance {
  id: string;
  tenant_id: string;
  pool_id: string;
  project_id: string | null;
  flavor_id: string;
  flavor: InstanceShape | string;
  image_id: string;
  image: VpsImage | string | null;
  ssh_keys: string[];
  user_data: string | null;
  user_data_sealed: boolean;
  runtime: string;
  draft: boolean;
  state: InstanceState;
  desired_state: InstanceDesiredState;
  node_id: string | null;
  allocation_id: string | null;
  provider_account_id: string | null;
  external_id: string | null;
  addresses: string[];
  reported_state: string | null;
  quota_charged: Record<string, number> | string | null;
  owner_identity_id: string;
  agent_id: string | null;
  delegation_id: string | null;
  idempotency_key: string;
  request_hash: string;
  conditions: Condition[] | string;
  version: string | number;
  pool_class: string;
  sandbox_id: string | null;
  warm_template_id: string | null;
  restore_from: InstanceRestore | string | null;
  host_certified: boolean | null;
  host_cert_valid_ms: number | null;
  network_policy: 'private' | 'none' | null;
  identity_rebind_ref: string | null;
}

/** The sandbox snapshot an instance boots from (§3.7), verified by the host against `sha256`. */
export interface InstanceRestore {
  snapshotId: string;
  url: string;
  /** Hex sha256 of the snapshot object. */
  sha256: string;
  includeMemory: boolean;
  /** Memory state needs a host with this `cpu.model` label (a `cpuModelLabelValue`). */
  cpuModel?: string;
  /**
   * A memory restore resumes the guest without re-running cloud-init, so its sshd still accepts the
   * SSH principal of this (original) instance: `sandboxes.exec` signs for it.
   */
  principalInstanceId?: string;
  /** A memory restore keeps the source guest's host key: certified or not, as the source was. */
  hostCertified?: boolean;
  hostCertValidBefore?: number;
}

/**
 * The label the gateway writes for a bcd that enforces `InstanceSpec.network_policy` (Hello capability
 * `instance.network-policy`): an older bcd would drop the field and give the instance full egress.
 */
export const networkPolicyCapabilityLabel = 'bc.dev/cap.instance.network-policy';

/**
 * The label of a bcd that enforces `InstanceSpec.ssh_from_host_only` (capability
 * `instance.ssh-host-only`): sandbox guests, which set it, are placed only there.
 */
export const sshHostOnlyCapabilityLabel = 'bc.dev/cap.instance.ssh-host-only';

/**
 * The label of a bcd that applies `InstanceSpec.placement` (capability `instance.placement`): an
 * older bcd would back a hugepage flavor's guest with memory placement never booked.
 */
export const placementCapabilityLabel = 'bc.dev/cap.instance.placement';

/**
 * The node label a memory snapshot's host must carry: the CPU model the state was captured on, as
 * inventory writes it (`cpu.model`, source `inventory`).
 */
export const cpuModelLabel = 'cpu.model';

/**
 * A CPU model as a label value, exactly as inventory's `cpuModelLabelValue` makes it: (R)/(TM)
 * dropped, other runs of characters outside [A-Za-z0-9._] turned into '-', trimmed of '-' and '.',
 * at most 63 characters. `undefined` when nothing is left.
 */
export function cpuModelLabelValue(model: string): string | undefined {
  const value = model
    .replace(/\((r|tm)\)/gi, '')
    .replace(/[^A-Za-z0-9._]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 63)
    .replace(/[-.]+$/g, '');
  return value || undefined;
}

/** A stored instance with everything the lifecycle needs. */
export interface InstanceRow {
  id: string;
  tenantId: string;
  poolId: string;
  poolClass: string;
  projectId?: string;
  flavorId: string;
  shape: InstanceShape;
  imageId: string;
  image?: VpsImage;
  sshKeys: string[];
  /** The tenant's user data, or a `secret://` ref to it (hosted pools). */
  userData?: string;
  /** `userData` is a ref vps sealed from the rendered cloud-config (deleted with the instance). */
  userDataSealed: boolean;
  runtime: string;
  draft: boolean;
  state: InstanceState;
  desiredState: InstanceDesiredState;
  nodeId?: string;
  allocationId?: string;
  providerAccountId?: string;
  externalId?: string;
  addresses: string[];
  reportedState?: string;
  quotaCharged?: Record<string, number>;
  ownerIdentityId: string;
  agentId?: string;
  delegationId?: string;
  idempotencyKey: string;
  requestHash: string;
  conditions: Condition[];
  version: number;
  /** The sandbox this instance runs (§3.7): instance item methods refuse it. */
  sandboxId?: string;
  /** A warm-pool instance of this sandbox template, not claimed yet (§3.7). */
  warmTemplateId?: string;
  /** The snapshot it boots from (a restored sandbox, §3.7). */
  restoreFrom?: InstanceRestore;
  /** Its guest's SSH host key is certified by the sandbox CA (exec clients pin it). */
  hostCertified: boolean;
  /** Until when that certificate is valid (epoch ms). */
  hostCertValidBefore?: number;
  /** A sandbox template's network (§3.7); absent: egress. */
  networkPolicy?: 'private' | 'none';
  /** A memory restore's own guest identity, sealed for the host to install (deleted with the row). */
  identityRebindRef?: string;
}

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

function toRow(raw: RawInstance): InstanceRow {
  const row: InstanceRow = {
    id: raw.id,
    tenantId: raw.tenant_id,
    poolId: raw.pool_id,
    poolClass: raw.pool_class,
    flavorId: raw.flavor_id,
    shape: json(raw.flavor),
    imageId: raw.image_id,
    sshKeys: raw.ssh_keys ?? [],
    userDataSealed: raw.user_data_sealed === true,
    hostCertified: raw.host_certified === true,
    ...(raw.host_cert_valid_ms !== null && raw.host_cert_valid_ms !== undefined
      ? { hostCertValidBefore: Number(raw.host_cert_valid_ms) }
      : {}),
    runtime: raw.runtime,
    draft: raw.draft,
    state: raw.state,
    desiredState: raw.desired_state,
    addresses: raw.addresses ?? [],
    ownerIdentityId: raw.owner_identity_id,
    idempotencyKey: raw.idempotency_key,
    requestHash: raw.request_hash,
    conditions: json(raw.conditions) ?? [],
    version: Number(raw.version),
  };
  if (raw.project_id !== null) row.projectId = raw.project_id;
  if (raw.image !== null) row.image = json(raw.image);
  if (raw.user_data !== null) row.userData = raw.user_data;
  if (raw.node_id !== null) row.nodeId = raw.node_id;
  if (raw.allocation_id !== null) row.allocationId = raw.allocation_id;
  if (raw.provider_account_id !== null) row.providerAccountId = raw.provider_account_id;
  if (raw.external_id !== null) row.externalId = raw.external_id;
  if (raw.reported_state !== null) row.reportedState = raw.reported_state;
  if (raw.quota_charged !== null) row.quotaCharged = json(raw.quota_charged);
  if (raw.agent_id !== null) row.agentId = raw.agent_id;
  if (raw.delegation_id !== null) row.delegationId = raw.delegation_id;
  if (raw.sandbox_id !== null) row.sandboxId = raw.sandbox_id;
  if (raw.warm_template_id !== null) row.warmTemplateId = raw.warm_template_id;
  if (raw.restore_from !== null) row.restoreFrom = json(raw.restore_from);
  if (raw.network_policy !== null && raw.network_policy !== undefined)
    row.networkPolicy = raw.network_policy;
  if (raw.identity_rebind_ref !== null && raw.identity_rebind_ref !== undefined)
    row.identityRebindRef = raw.identity_rebind_ref;
  return row;
}

const columns = `i.id, i.tenant_id, i.pool_id, i.project_id, i.flavor_id, i.flavor, i.image_id, i.image,
  i.ssh_keys, i.user_data, i.user_data_sealed, i.runtime, i.draft, i.state, i.desired_state, i.node_id, i.allocation_id,
  i.provider_account_id, i.external_id, i.addresses, i.reported_state, i.quota_charged,
  i.owner_identity_id, i.agent_id, i.delegation_id, i.idempotency_key,
  encode(i.request_hash, 'hex') AS request_hash, i.conditions, i.version, p.class AS pool_class,
  i.sandbox_id, i.warm_template_id, i.restore_from, i.host_certified,
  (extract(epoch FROM i.host_cert_valid_before) * 1000)::float8 AS host_cert_valid_ms, i.network_policy,
  i.identity_rebind_ref`;

export async function readInstance(
  tx: SqlTx,
  instanceId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<InstanceRow | undefined> {
  const { rows } = await tx.query<RawInstance>(
    `SELECT ${columns} FROM instances i JOIN pools p ON p.id = i.pool_id
      WHERE i.id = $1 AND ($2::text IS NULL OR i.tenant_id = $2)${options.lock ? ' FOR UPDATE OF i' : ''}`,
    [instanceId, options.tenantId ?? null],
  );
  return rows[0] ? toRow(rows[0]) : undefined;
}

/** The public view (`Instance` of `@better-compute/core`). */
export function instanceView(row: InstanceRow): Instance {
  const view: Instance = {
    id: row.id,
    tenantId: row.tenantId,
    poolId: row.poolId,
    flavor: row.shape.name,
    imageId: row.imageId,
    sshKeys: [...row.sshKeys],
    state: row.state,
    desiredState: row.desiredState,
    addresses: [...row.addresses],
    ownerIdentityId: row.ownerIdentityId,
    idempotencyKey: row.idempotencyKey,
    conditions: [...row.conditions],
    version: row.version,
  };
  if (row.projectId !== undefined) view.projectId = row.projectId;
  if (row.nodeId !== undefined) view.nodeId = row.nodeId;
  if (row.allocationId !== undefined) view.allocationId = row.allocationId;
  if (row.externalId !== undefined) view.externalId = row.externalId;
  return view;
}

/** Guarded column updates of one instance; `CONFLICT` when it changed underneath. */
export async function updateInstance(
  tx: SqlTx,
  row: InstanceRow,
  sets: Partial<{
    state: InstanceState;
    desiredState: InstanceDesiredState;
    draft: boolean;
    nodeId: string | null;
    allocationId: string | null;
    externalId: string | null;
    addresses: string[];
    reportedState: string | null;
    quotaCharged: Record<string, number> | null;
    conditions: Condition[];
    flavorId: string;
    shape: InstanceShape;
  }>,
): Promise<InstanceRow> {
  const assignments = ['version = version + 1'];
  const params: unknown[] = [row.id, row.version];
  const set = (column: string, value: unknown, cast = '') => {
    params.push(value);
    assignments.push(`${column} = $${params.length}${cast}`);
  };
  if (sets.state !== undefined) set('state', sets.state);
  if (sets.desiredState !== undefined) set('desired_state', sets.desiredState);
  if (sets.draft !== undefined) set('draft', sets.draft);
  if (sets.nodeId !== undefined) set('node_id', sets.nodeId);
  if (sets.allocationId !== undefined) set('allocation_id', sets.allocationId);
  if (sets.externalId !== undefined) set('external_id', sets.externalId);
  if (sets.addresses !== undefined) set('addresses', sets.addresses, '::text[]');
  if (sets.reportedState !== undefined) set('reported_state', sets.reportedState);
  if (sets.quotaCharged !== undefined)
    set(
      'quota_charged',
      sets.quotaCharged === null ? null : JSON.stringify(sets.quotaCharged),
      '::jsonb',
    );
  if (sets.conditions !== undefined) set('conditions', JSON.stringify(sets.conditions), '::jsonb');
  if (sets.flavorId !== undefined) set('flavor_id', sets.flavorId);
  if (sets.shape !== undefined) set('flavor', JSON.stringify(sets.shape), '::jsonb');
  const { rowCount } = await tx.query(
    `UPDATE instances SET ${assignments.join(', ')} WHERE id = $1 AND version = $2`,
    params,
  );
  if (rowCount === 0)
    throw new ComputeError('CONFLICT', `Instance ${row.id} changed concurrently; retry`);
  const next: InstanceRow = { ...row, version: row.version + 1 };
  if (sets.state !== undefined) next.state = sets.state;
  if (sets.desiredState !== undefined) next.desiredState = sets.desiredState;
  if (sets.draft !== undefined) next.draft = sets.draft;
  if (sets.nodeId !== undefined)
    sets.nodeId === null ? delete next.nodeId : (next.nodeId = sets.nodeId);
  if (sets.allocationId !== undefined)
    sets.allocationId === null ? delete next.allocationId : (next.allocationId = sets.allocationId);
  if (sets.externalId !== undefined)
    sets.externalId === null ? delete next.externalId : (next.externalId = sets.externalId);
  if (sets.addresses !== undefined) next.addresses = [...sets.addresses];
  if (sets.reportedState !== undefined)
    sets.reportedState === null
      ? delete next.reportedState
      : (next.reportedState = sets.reportedState);
  if (sets.quotaCharged !== undefined)
    sets.quotaCharged === null ? delete next.quotaCharged : (next.quotaCharged = sets.quotaCharged);
  if (sets.conditions !== undefined) next.conditions = sets.conditions;
  if (sets.flavorId !== undefined) next.flavorId = sets.flavorId;
  if (sets.shape !== undefined) next.shape = sets.shape;
  return next;
}

/** Moves an instance along the §11.1 table (and applies `sets` in the same guarded update). */
export async function moveInstance(
  tx: SqlTx,
  row: InstanceRow,
  verb: InstanceVerb,
  to?: InstanceState,
  sets: Parameters<typeof updateInstance>[2] = {},
): Promise<InstanceRow> {
  const next = transition(instanceStateTable, row.state, verb, to);
  return updateInstance(tx, row, { ...sets, state: next });
}

export function withCondition(
  conditions: readonly Condition[],
  condition: Omit<Condition, 'since'>,
  now: number,
): Condition[] {
  const previous = conditions.find((entry) => entry.type === condition.type);
  const since = previous && previous.status === condition.status ? previous.since : now;
  return [...conditions.filter((entry) => entry.type !== condition.type), { ...condition, since }];
}

export function withoutCondition(conditions: readonly Condition[], type: string): Condition[] {
  return conditions.filter((entry) => entry.type !== type);
}

export async function publishInstance(
  deps: Pick<InstanceDeps, 'events'>,
  tx: SqlTx,
  row: InstanceRow,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: row.tenantId,
    subject: `instance/${row.id}`,
    data: { state: row.state, desiredState: row.desiredState, poolId: row.poolId, ...data },
  });
}

/** What an instance counts against quota. */
export function instanceDemand(shape: InstanceShape): Record<string, number> {
  const demand: Record<string, number> = {
    vcpu: shape.vcpu,
    memoryGiB: shape.memoryGiB,
    diskGiB: shape.diskGiB,
  };
  if (shape.gpus > 0) demand.gpu = shape.gpus;
  return demand;
}

export function shapeOf(flavor: FlavorRecord): InstanceShape {
  const shape: InstanceShape = {
    name: flavor.name,
    vcpu: flavor.vcpu,
    memoryGiB: flavor.memoryGiB,
    diskGiB: flavor.diskGiB,
    gpus: flavor.gpus,
  };
  if (flavor.offerId !== undefined) shape.offerId = flavor.offerId;
  if (flavor.placement !== undefined) shape.placement = { ...flavor.placement };
  return shape;
}

/** Cloud-init for an instance: the tenant's keys, or the tenant's own user data. No join tokens, ever. */
export function renderUserData(row: Pick<InstanceRow, 'id' | 'sshKeys' | 'userData'>): string {
  if (row.userData !== undefined) return row.userData;
  const keys = row.sshKeys.map((key) => `  - ${JSON.stringify(key)}`).join('\n');
  return `#cloud-config\nhostname: ${row.id.replaceAll('_', '-').slice(0, 63)}\n${
    keys ? `ssh_authorized_keys:\n${keys}\n` : ''
  }`;
}

/**
 * Hosted pools: seals the rendered cloud-config and keeps only its `secret://` ref, which the host
 * fetches through the broker for this instance's allocation (the spec never carries user data).
 * A tenant's own ref is kept as it is.
 */
export async function sealUserData(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
): Promise<InstanceRow> {
  if (!deps.broker || isSecretRef(row.userData)) return row;
  const ref = await deps.broker.put(row.tenantId, renderUserData(row));
  await tx.query(`UPDATE instances SET user_data = $2, user_data_sealed = true WHERE id = $1`, [
    row.id,
    ref,
  ]);
  return { ...row, userData: ref, userDataSealed: true };
}

/**
 * Deletes what vps sealed for a deleted instance: its user data and a restore's rebind bundle (best
 * effort: the refs die with the row).
 */
export async function dropSealedUserData(deps: InstanceDeps, row: InstanceRow): Promise<void> {
  if (!deps.broker?.delete) return;
  const refs = [
    ...(row.userDataSealed && isSecretRef(row.userData) ? [row.userData] : []),
    ...(isSecretRef(row.identityRebindRef) ? [row.identityRebindRef] : []),
  ];
  for (const ref of refs)
    try {
      await deps.broker.delete(ref);
    } catch (error) {
      deps.log.warn('vps: could not delete sealed user data', {
        instanceId: row.id,
        error: String((error as Error)?.message ?? error),
      });
    }
}

// --- Admission -----------------------------------------------------------------------------------

export interface PoolForInstance {
  id: string;
  ownerTenantId: string;
  class: string;
  agent: string;
  providerAccountId?: string;
  /** `policy.runtime`, when the pool names one. */
  runtime?: string;
  singleTenant: boolean;
}

export async function visibleVpsPool(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<PoolForInstance> {
  const { rows } = await tx.query<{
    id: string;
    owner_tenant_id: string;
    class: string;
    agent: string;
    provider_account_id: string | null;
    runtime: string | null;
    single_tenant: boolean | null;
  }>(
    `SELECT p.id, p.owner_tenant_id, p.class, p.agent, p.provider_account_id,
            p.policy->>'runtime' AS runtime,
            CASE WHEN jsonb_typeof(p.policy->'singleTenant') = 'boolean'
                 THEN (p.policy->>'singleTenant')::boolean END AS single_tenant
       FROM pools p
      WHERE p.id = $1 AND (p.owner_tenant_id = $2
            OR EXISTS (SELECT 1 FROM pool_offers o WHERE o.pool_id = p.id AND o.tenant_id = $2))
        AND p.archived_at IS NULL`,
    [poolId, tenantId],
  );
  const row = rows[0];
  if (!row) throw new ComputeError('NOT_FOUND', `Pool ${poolId} not found`);
  if (row.class !== 'vps-host' && row.class !== 'provider')
    throw new ComputeError('INVALID_INPUT', `Pool ${poolId} is ${row.class}, not a VPS pool`);
  const pool: PoolForInstance = {
    id: row.id,
    ownerTenantId: row.owner_tenant_id,
    class: row.class,
    agent: row.agent,
    singleTenant: row.single_tenant === true,
  };
  if (row.provider_account_id !== null) pool.providerAccountId = row.provider_account_id;
  if (row.runtime !== null) pool.runtime = row.runtime;
  return pool;
}

/** The runtimes hosted pools may run: `deps.runtimes`, or the default runtime alone. */
export function runtimeTable(
  deps: Pick<InstanceDeps, 'runtime' | 'runtimes'>,
): ReadonlyMap<string, RuntimeTraits> {
  if (deps.runtimes) return deps.runtimes;
  const traits = builtinRuntimeTraits[deps.runtime];
  return new Map([
    [
      deps.runtime,
      traits ?? {
        isolation: 'vm',
        multiTenant: true,
        gpuPassthrough: false,
        imageFormats: ['qcow2', 'raw'],
      },
    ],
  ]);
}

/**
 * The runtime a hosted pool runs (`policy.runtime`, else the default) and the checks its traits
 * impose on one request (§13): the image format, GPU passthrough, and for single-tenant runtimes
 * (containers) that the pool is marked `singleTenant` and serves this tenant alone — the one tenant
 * it is offered to, else its owner — with no other tenant's instance in it.
 */
export async function hostedRuntime(
  deps: Pick<InstanceDeps, 'runtime' | 'runtimes'>,
  tx: SqlTx,
  pool: PoolForInstance,
  request: { tenantId: string; imageFormat?: ImageFormat; gpus: number },
): Promise<string> {
  const table = runtimeTable(deps);
  const runtime = pool.runtime ?? deps.runtime;
  const traits = table.get(runtime);
  if (!traits)
    throw new ComputeError(
      'INVALID_CONFIG',
      `Pool ${pool.id} runs ${runtime}, which this deployment's vps({ runtimes }) does not list`,
    );
  if (!traits.multiTenant && !pool.singleTenant)
    throw new ComputeError(
      'INVALID_CONFIG',
      `Pool ${pool.id} runs ${runtime}, a single-tenant ${traits.isolation} runtime: set policy.singleTenant`,
    );
  if (request.imageFormat !== undefined && !traits.imageFormats.includes(request.imageFormat))
    throw new ComputeError(
      'INVALID_INPUT',
      `${runtime} boots ${traits.imageFormats.join(', ')} images, not ${request.imageFormat}`,
    );
  if (request.gpus > 0 && !traits.gpuPassthrough)
    throw new ComputeError('INVALID_INPUT', `${runtime} cannot pass GPUs through`);
  if (traits.multiTenant) return runtime;
  // The pool row is locked FOR SHARE so an offer (pools.offer locks it) cannot slip in between.
  await tx.query(`SELECT 1 FROM pools WHERE id = $1 FOR SHARE`, [pool.id]);
  const offered = await tx.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM pool_offers WHERE pool_id = $1 AND tenant_id <> $2 ORDER BY tenant_id`,
    [pool.id, pool.ownerTenantId],
  );
  if (offered.rows.length > 1)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} is single-tenant but offered to ${offered.rows.length} tenants`,
    );
  const tenant = offered.rows[0]?.tenant_id ?? pool.ownerTenantId;
  if (request.tenantId !== tenant)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} is single-tenant and serves tenant ${tenant} only`,
    );
  const others = await tx.query(
    `SELECT 1 FROM instances WHERE pool_id = $1 AND tenant_id <> $2 AND state <> 'deleted' AND NOT draft LIMIT 1`,
    [pool.id, request.tenantId],
  );
  if (others.rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} is single-tenant and still runs another tenant's instances`,
    );
  return runtime;
}

/** The attributes IAM policies read on an instance (§3.6). */
export function instanceAttributes(
  shape: InstanceShape,
  imageId: string,
  imageVerified: boolean,
  projectId?: string,
): AuthzAttributes {
  const attributes: AuthzAttributes = {
    vcpu: shape.vcpu,
    memoryGiB: shape.memoryGiB,
    gpus: shape.gpus,
    imageId,
    imageVerified,
  };
  if (projectId !== undefined) attributes.projectId = projectId;
  return attributes;
}

/**
 * `instances.create` transaction 1: the idempotency lookup, image and flavor checks, the draft row
 * and its authz row. A finished request under the same key replays; a different one is CONFLICT.
 */
/**
 * User data given as a secret ref must be a secret the tenant wrote through `secrets.put`
 * (`secret_refs`), never a platform-minted one (join tokens, BMC credentials, another instance's
 * sealed user data) that lives in the same store. The guest reads its user data, and secrets are
 * write-only (§6), so the caller also needs `compute:secrets:manage` (the admission check).
 */
async function assertTenantPutSecret(tx: SqlTx, tenantId: string, ref: string): Promise<void> {
  const present = await tx.query<{ found: string | null; scoped: boolean }>(
    `SELECT to_regclass('secret_refs')::text AS found,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'secret_refs' AND column_name = 'scope'
                       AND table_schema = current_schema()) AS scoped`,
  );
  const row = present.rows[0]?.found
    ? (
        await tx.query<{ scope: string }>(
          `SELECT ${present.rows[0].scoped ? 'scope' : `'tenant'`} AS scope
             FROM secret_refs WHERE tenant_id = $1 AND ref = $2`,
          [tenantId, ref],
        )
      ).rows[0]
    : undefined;
  if (!row)
    throw new ComputeError(
      'INVALID_INPUT',
      `${ref} is not a secret this tenant put (secrets.put); user data refs name only those`,
    );
  // A fleet secret (BMC credentials of shared sites, in the root tenant) never becomes a guest's
  // user data: the guest reads what it is given.
  if (row.scope === 'fleet')
    throw new ComputeError(
      'INVALID_INPUT',
      `${ref} is a fleet secret; instances take tenant secrets only as user data`,
    );
}

export async function prepareCreateInstance(
  deps: Pick<InstanceDeps, 'images' | 'runtime' | 'runtimes'>,
  context: MethodContext,
  input: CreateInstanceInput,
  tx: SqlTx,
): Promise<AdmissionPlan<Instance>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const { idempotencyKey: _key, wait: _wait, ...request } = input;
  const hash = await sha256Hex(canonical(request));
  const instanceId = await draftId('inst', input.tenantId, caller.identityId, input.idempotencyKey);
  const existing = await readInstance(tx, instanceId, { tenantId: input.tenantId, lock: true });
  if (existing && existing.requestHash !== hash)
    throw new ComputeError(
      'CONFLICT',
      'This idempotency key was used for a different request',
      undefined,
      {
        instanceId,
      },
    );
  if (existing && !existing.draft) return { status: 'replay', result: instanceView(existing) };

  if (isSecretRef(input.userData)) await assertTenantPutSecret(tx, input.tenantId, input.userData);
  const pool = await visibleVpsPool(tx, input.tenantId, input.poolId);
  const flavor = await readFlavorByName(tx, input.poolId, input.flavor);
  if (!flavor || flavor.archived)
    throw new ComputeError('NOT_FOUND', `Flavor ${input.flavor} not found in pool ${input.poolId}`);
  let image: VpsImage | undefined;
  if (pool.class === 'vps-host') {
    if (!deps.images)
      throw new ComputeError(
        'INVALID_CONFIG',
        'Hosted VPS pools need vps({ images }) to resolve images',
      );
    image = await deps.images.resolve(tx, input.tenantId, input.imageId);
    if (!image) throw new ComputeError('NOT_FOUND', `Image ${input.imageId} not found`);
  } else if (!pool.providerAccountId)
    throw new ComputeError('INVALID_STATE', `Provider pool ${pool.id} has no provider account`);
  else image = await deps.images?.resolve(tx, input.tenantId, input.imageId);

  const shape = shapeOf(flavor);
  const runtime =
    pool.class === 'vps-host'
      ? await hostedRuntime(deps, tx, pool, {
          tenantId: input.tenantId,
          gpus: shape.gpus,
          ...(image ? { imageFormat: image.format } : {}),
        })
      : deps.runtime;
  if (!existing)
    await tx.query(
      `INSERT INTO instances (id, tenant_id, pool_id, project_id, flavor_id, flavor, image_id, image,
                              ssh_keys, user_data, runtime, draft, state, desired_state,
                              provider_account_id, owner_identity_id, agent_id, delegation_id,
                              idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::text[], $10, $11, true, 'pending', $12,
               $13, $14, $15, $16, $17, decode($18, 'hex'), 1)`,
      [
        instanceId,
        input.tenantId,
        input.poolId,
        input.projectId ?? null,
        flavor.id,
        JSON.stringify(shape),
        input.imageId,
        image ? JSON.stringify(image) : null,
        input.sshKeys,
        input.userData ?? null,
        runtime,
        input.desiredState,
        pool.class === 'provider' ? pool.providerAccountId! : null,
        caller.identityId,
        caller.agentId ?? null,
        caller.delegationId ?? null,
        input.idempotencyKey,
        hash,
      ],
    );
  await context.authz.upsert(tx, {
    type: 'instance',
    id: instanceId,
    tenantId: input.tenantId,
    attributes: instanceAttributes(shape, input.imageId, image?.verified ?? false, input.projectId),
    parentType: 'pool',
    parentId: input.poolId,
    ownerId: caller.identityId,
  });
  return { status: 'decide', resource: { type: 'instance', id: instanceId } };
}

/** `instances.create` after a refusal: the draft disappears (a later retry is decided afresh). */
export async function denyCreateInstance(
  context: MethodContext,
  input: CreateInstanceInput,
  tx: SqlTx,
): Promise<void> {
  const caller = context.caller;
  if (!caller) return;
  const instanceId = await draftId('inst', input.tenantId, caller.identityId, input.idempotencyKey);
  const { rowCount } = await tx.query(`DELETE FROM instances WHERE id = $1 AND draft`, [
    instanceId,
  ]);
  if (rowCount > 0)
    await context.authz.remove(tx, { type: 'instance', id: instanceId, tenantId: input.tenantId });
}

/**
 * Records where on its host an instance's vCPUs and memory go (§3.8, `chooseHostPlacement`) in
 * `host_placement`, and returns its conditions with `PlacementDegraded` set or cleared.
 */
async function placeOnHost(
  tx: SqlTx,
  row: InstanceRow,
  nodeId: string,
  deviceIds: readonly string[],
  now: number,
): Promise<Condition[]> {
  const { rows: pools } = await tx.query<{ overcommit: string | null }>(
    `SELECT policy->'overcommit'->>'memoryGiB' AS overcommit FROM pools WHERE id = $1`,
    [row.poolId],
  );
  const choice = await chooseHostPlacement(tx, {
    id: row.id,
    nodeId,
    shape: row.shape,
    deviceIds,
    balloon: Number(pools[0]?.overcommit ?? 1) > 1,
  });
  await tx.query(`UPDATE instances SET host_placement = $2::jsonb WHERE id = $1`, [
    row.id,
    choice.placement ? JSON.stringify(choice.placement) : null,
  ]);
  return choice.degraded
    ? withCondition(
        row.conditions,
        {
          type: 'PlacementDegraded',
          status: 'true',
          reason: choice.degraded,
          message: 'The host cannot give this flavor its NUMA or pinned placement; the guest floats',
        },
        now,
      )
    : withoutCondition(row.conditions, 'PlacementDegraded');
}

/**
 * Places a hosted instance: vCPU/memory/disk scalar claims (hugepages for hugepage-backed flavors)
 * plus whole-GPU atoms (VFIO) through the CapacityPort, its host placement, then an IP lease.
 * `pending` keeps `scheduling` with `Unschedulable`.
 */
export async function scheduleHosted(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
  /** `instances.create`'s decision: scheduler plugins' `admit` hooks see it (never on retries). */
  admission?: AdmissionContext,
): Promise<InstanceRow> {
  const now = deps.clock.now();
  // The runtime lands only on hosts whose bcd advertised it (walkthrough 4; built-ins too); a memory snapshot
  // only on hosts with the CPU model it was captured on (§3.7).
  const nodeLabels: Record<string, string> = {
    ...runtimeNodeLabels(row.runtime),
    ...(row.restoreFrom?.includeMemory && row.restoreFrom.cpuModel
      ? { [cpuModelLabel]: row.restoreFrom.cpuModel }
      : {}),
    // A private or none network lands only where the host enforces it.
    ...(row.networkPolicy ? { [networkPolicyCapabilityLabel]: '*' } : {}),
    // A sandbox guest takes ssh only from its host (instanceSpecs sets sshFromHostOnly for them).
    ...(row.sandboxId !== undefined || row.warmTemplateId !== undefined
      ? { [sshHostOnlyCapabilityLabel]: '*' }
      : {}),
    // A flavor placement (§3.8), hugepages above all, only where bcd applies it.
    ...(row.shape.placement ? { [placementCapabilityLabel]: '*' } : {}),
  };
  // Agent memory: an instance that attaches volumes runs on the host they live on, if its bcd keeps them.
  const volumes = await volumePlacement(tx, row.id);
  if (volumes) Object.assign(nodeLabels, volumes.nodeLabels);
  const outcome = await deps.capacity.reserve(
    tx,
    {
      tenantId: row.tenantId,
      poolId: row.poolId,
      ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
      instanceId: row.id,
      // Lets the image-cached scorer prefer hosts whose runtime already holds the image.
      imageId: row.imageId,
      devices: row.shape.gpus > 0 ? [{ class: 'gpu', count: row.shape.gpus }] : [],
      resources: placementResources(row.shape),
      during: { start: now, end: openEnded },
      ...(Object.keys(nodeLabels).length > 0 ? { nodeLabels } : {}),
      ...(volumes ? { onlyNodes: volumes.onlyNodes } : {}),
    },
    admission ? { admission } : undefined,
  );
  if (outcome.status !== 'placed') {
    const reason = outcome.status === 'pending' ? outcome.reason : 'queued';
    const conditions = withCondition(
      row.conditions,
      { type: 'Unschedulable', status: 'true', reason: 'NoFit', message: reason },
      now,
    );
    const next = await updateInstance(tx, row, { conditions });
    await deps.work.enqueue(tx, instanceWork, row.id, { notBefore: now + scheduleRetryMs });
    return next;
  }
  const allocation = outcome.allocations[0]!;
  const address = await leaseAddress(tx, row.poolId, row.id);
  const conditions = await placeOnHost(tx, row, allocation.nodeId, allocation.atoms, now);
  const next = await moveInstance(tx, row, 'complete', 'provisioning', {
    nodeId: allocation.nodeId,
    allocationId: allocation.id,
    addresses: address ? [address] : [],
    reportedState: null,
    conditions: withoutCondition(conditions, 'Unschedulable'),
  });
  await deps.desired.invalidate(tx, allocation.nodeId);
  await deps.work.enqueue(tx, instanceWork, row.id);
  await publishInstance(deps, tx, next, 'instance.scheduled', { nodeId: allocation.nodeId });
  return next;
}

/**
 * `instances.create` transaction 2 (allowed): admits the draft and schedules it. Hosted pools place
 * right away (`QUOTA_EXCEEDED` refuses the request and leaves the draft); provider pools charge
 * quota now and create the machine from the reconciler.
 */
export async function completeCreateInstance(
  deps: InstanceDeps,
  context: MethodContext,
  input: CreateInstanceInput,
): Promise<Instance> {
  const tx = context.sql;
  const instanceId = await draftId(
    'inst',
    input.tenantId,
    context.caller!.identityId,
    input.idempotencyKey,
  );
  const row = await readInstance(tx, instanceId, { tenantId: input.tenantId, lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Instance ${instanceId} not found`);
  if (!row.draft) return instanceView(row);
  let next = await moveInstance(tx, row, 'schedule', 'scheduling', { draft: false });
  if (next.poolClass === 'vps-host') next = await sealUserData(deps, tx, next);
  if (next.poolClass === 'provider') {
    const demand = instanceDemand(next.shape);
    await chargeQuota(tx, next.tenantId, next.poolId, demand);
    next = await updateInstance(tx, next, { quotaCharged: demand });
    await deps.work.enqueue(tx, instanceWork, next.id);
  } else next = await scheduleHosted(deps, tx, next, context.admission);
  await publishInstance(deps, tx, next, 'instance.created');
  return instanceView(next);
}

// --- Later operations: desiredState only -----------------------------------------------------------

async function lockOwned(tx: SqlTx, ref: InstanceRef): Promise<InstanceRow> {
  const row = await readInstance(tx, ref.instanceId, { tenantId: ref.tenantId, lock: true });
  if (!row || row.draft)
    throw new ComputeError('NOT_FOUND', `Instance ${ref.instanceId} not found`);
  // §3.7: a sandbox's instance, and a warm one waiting for a sandbox, follow their sandbox only.
  if (row.sandboxId !== undefined)
    throw new ComputeError(
      'INVALID_STATE',
      `Instance ${row.id} is managed by sandbox ${row.sandboxId}`,
    );
  if (row.warmTemplateId !== undefined)
    throw new ComputeError(
      'INVALID_STATE',
      `Instance ${row.id} is a warm instance of sandbox template ${row.warmTemplateId}`,
    );
  return row;
}

export async function wake(
  deps: Pick<InstanceDeps, 'desired' | 'work'>,
  tx: SqlTx,
  row: InstanceRow,
): Promise<void> {
  if (row.nodeId) await deps.desired.invalidate(tx, row.nodeId);
  await deps.work.enqueue(tx, instanceWork, row.id);
}

/** `instances.start` / `instances.stop`: sets `desiredState`; the reconciler converges. */
export async function setPower(
  deps: InstanceDeps,
  tx: SqlTx,
  ref: InstanceRef,
  desiredState: 'running' | 'stopped',
): Promise<Instance> {
  let row = await lockOwned(tx, ref);
  if (row.desiredState === 'deleted' || row.state === 'deleting' || row.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Instance ${row.id} is being deleted`);
  if (row.desiredState !== desiredState) row = await updateInstance(tx, row, { desiredState });
  // An instance in error retries when started again.
  if (desiredState === 'running' && row.state === 'error' && (row.nodeId || row.externalId))
    row = await moveInstance(tx, row, 'start', 'starting', { reportedState: null });
  await wake(deps, tx, row);
  await publishInstance(
    deps,
    tx,
    row,
    desiredState === 'running' ? 'instance.starting' : 'instance.stopping',
  );
  return instanceView(row);
}

/** `instances.delete`: sets `desiredState` to `deleted`; idempotent. */
export async function deleteInstance(
  deps: InstanceDeps,
  tx: SqlTx,
  ref: InstanceRef,
): Promise<Instance> {
  let row = await lockOwned(tx, ref);
  if (row.state === 'deleted') return instanceView(row);
  if (row.desiredState !== 'deleted')
    row = await updateInstance(tx, row, { desiredState: 'deleted' });
  await wake(deps, tx, row);
  await publishInstance(deps, tx, row, 'instance.deleting');
  return instanceView(row);
}

/**
 * `instances.resize` (hosted pools, stopped instances, same GPU count): claims the new scalar shape
 * in place on the instance's node, quota first. Otherwise `UNSUPPORTED` or `INVALID_STATE`.
 */
export async function resizeInstance(
  deps: InstanceDeps,
  tx: SqlTx,
  input: InstanceRef & { flavor: string },
): Promise<Instance> {
  const row = await lockOwned(tx, input);
  if (row.poolClass !== 'vps-host')
    throw new ComputeError('UNSUPPORTED', 'Provider instances cannot be resized in place');
  if (row.state !== 'stopped' || row.desiredState !== 'stopped')
    throw new ComputeError('INVALID_STATE', `Stop instance ${row.id} before resizing it`);
  const flavor = await readFlavorByName(tx, row.poolId, input.flavor);
  if (!flavor || flavor.archived)
    throw new ComputeError('NOT_FOUND', `Flavor ${input.flavor} not found in pool ${row.poolId}`);
  const shape = shapeOf(flavor);
  if (shape.gpus !== row.shape.gpus)
    throw new ComputeError('UNSUPPORTED', 'Changing the GPU count needs a new instance');
  if (JSON.stringify(shape.placement ?? {}) !== JSON.stringify(row.shape.placement ?? {}))
    throw new ComputeError('UNSUPPORTED', 'Changing the flavor placement needs a new instance');
  if (!row.allocationId)
    throw new ComputeError('INVALID_STATE', `Instance ${row.id} holds no allocation`);

  const before = instanceDemand(row.shape);
  const after = instanceDemand(shape);
  const grow: Record<string, number> = {};
  const shrink: Record<string, number> = {};
  for (const resource of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[resource] ?? 0) - (before[resource] ?? 0);
    if (delta > 0) grow[resource] = delta;
    if (delta < 0) shrink[resource] = -delta;
  }
  await chargeQuota(tx, row.tenantId, row.poolId, grow);
  const outcome = await resizeAllocation(tx, row.allocationId, placementResources(shape));
  if (outcome.status === 'conflict') {
    await refundQuota(tx, row.tenantId, row.poolId, grow);
    throw new ComputeError(
      'CAPACITY_UNAVAILABLE',
      `Not enough ${outcome.resource} on node ${row.nodeId}`,
      undefined,
      {
        resource: outcome.resource,
      },
    );
  }
  await refundQuota(tx, row.tenantId, row.poolId, shrink);
  const resizing = await moveInstance(tx, row, 'resize', 'resizing', {
    flavorId: flavor.id,
    shape,
  });
  let resized = await moveInstance(tx, resizing, 'complete', 'stopped');
  // A pinned or NUMA-bound guest's CPUs follow its new vCPU count (§3.8).
  if (resized.nodeId && (shape.placement?.pinned || shape.placement?.numaAffine)) {
    const { rows } = await tx.query<{ atoms: string[] }>(
      `SELECT atoms FROM allocations WHERE id = $1`,
      [row.allocationId],
    );
    const conditions = await placeOnHost(
      tx,
      resized,
      resized.nodeId,
      rows[0]?.atoms ?? [],
      deps.clock.now(),
    );
    resized = await updateInstance(tx, resized, { conditions });
  }
  await upsertInstanceAuthz(deps, tx, resized);
  await wake(deps, tx, resized);
  await publishInstance(deps, tx, resized, 'instance.resized', { flavor: shape.name });
  return instanceView(resized);
}

async function upsertInstanceAuthz(deps: InstanceDeps, tx: SqlTx, row: InstanceRow): Promise<void> {
  await deps.authz.upsert(tx, {
    type: 'instance',
    id: row.id,
    tenantId: row.tenantId,
    attributes: instanceAttributes(
      row.shape,
      row.imageId,
      row.image?.verified ?? false,
      row.projectId,
    ),
    parentType: 'pool',
    parentId: row.poolId,
    ownerId: row.ownerIdentityId,
  });
}

/** A tenant's instances, newest first; `scope: 'mine'` (the default) filters to the caller's own. */
export async function listInstances(
  tx: SqlTx,
  input: ListInstancesInput,
  callerIdentityId: string | undefined,
): Promise<{ items: Instance[]; cursor?: string }> {
  const limit = input.limit ?? 50;
  const owner = input.scope === 'mine' ? (callerIdentityId ?? '') : null;
  const { rows } = await tx.query<RawInstance>(
    `SELECT ${columns} FROM instances i JOIN pools p ON p.id = i.pool_id
      WHERE i.tenant_id = $1 AND NOT i.draft AND i.warm_template_id IS NULL
        AND ($2::text IS NULL OR i.owner_identity_id = $2)
        AND ($3::text IS NULL OR i.state = $3) AND ($4::text IS NULL OR i.pool_id = $4)
        AND ($5::text IS NULL OR (i.created_at, i.id) <
             (SELECT created_at, id FROM instances WHERE id = $5 AND tenant_id = $1))
      ORDER BY i.created_at DESC, i.id DESC LIMIT $6`,
    [
      input.tenantId,
      owner,
      input.state ?? null,
      input.poolId ?? null,
      input.cursor ?? null,
      limit + 1,
    ],
  );
  const page = rows.slice(0, limit).map(toRow);
  const result: { items: Instance[]; cursor?: string } = { items: page.map(instanceView) };
  if (rows.length > limit) result.cursor = page[page.length - 1]!.id;
  return result;
}
