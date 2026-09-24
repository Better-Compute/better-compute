import {
  ComputeError,
  draftId,
  instanceStateTable,
  transition,
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
  runtime: string;
}

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
}

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
  if (
    input.desiredState !== undefined &&
    input.desiredState !== 'running' &&
    input.desiredState !== 'stopped'
  )
    fail('desiredState must be running or stopped');
  const result: CreateInstanceInput = {
    tenantId: tenant(input.tenantId),
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
  return result;
}

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
  userData?: string;
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
  return row;
}

const columns = `i.id, i.tenant_id, i.pool_id, i.project_id, i.flavor_id, i.flavor, i.image_id, i.image,
  i.ssh_keys, i.user_data, i.runtime, i.draft, i.state, i.desired_state, i.node_id, i.allocation_id,
  i.provider_account_id, i.external_id, i.addresses, i.reported_state, i.quota_charged,
  i.owner_identity_id, i.agent_id, i.delegation_id, i.idempotency_key,
  encode(i.request_hash, 'hex') AS request_hash, i.conditions, i.version, p.class AS pool_class`;

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

function shapeOf(flavor: FlavorRecord): InstanceShape {
  const shape: InstanceShape = {
    name: flavor.name,
    vcpu: flavor.vcpu,
    memoryGiB: flavor.memoryGiB,
    diskGiB: flavor.diskGiB,
    gpus: flavor.gpus,
  };
  if (flavor.offerId !== undefined) shape.offerId = flavor.offerId;
  return shape;
}

// --- Admission -----------------------------------------------------------------------------------

interface PoolForInstance {
  id: string;
  class: string;
  agent: string;
  providerAccountId?: string;
}

async function visibleVpsPool(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<PoolForInstance> {
  const { rows } = await tx.query<{
    id: string;
    class: string;
    agent: string;
    provider_account_id: string | null;
  }>(
    `SELECT p.id, p.class, p.agent, p.provider_account_id FROM pools p
      WHERE p.id = $1 AND (p.owner_tenant_id = $2
            OR EXISTS (SELECT 1 FROM pool_offers o WHERE o.pool_id = p.id AND o.tenant_id = $2))`,
    [poolId, tenantId],
  );
  const row = rows[0];
  if (!row) throw new ComputeError('NOT_FOUND', `Pool ${poolId} not found`);
  if (row.class !== 'vps-host' && row.class !== 'provider')
    throw new ComputeError('INVALID_INPUT', `Pool ${poolId} is ${row.class}, not a VPS pool`);
  const pool: PoolForInstance = { id: row.id, class: row.class, agent: row.agent };
  if (row.provider_account_id !== null) pool.providerAccountId = row.provider_account_id;
  return pool;
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
export async function prepareCreateInstance(
  deps: Pick<InstanceDeps, 'images' | 'runtime'>,
  context: MethodContext,
  input: CreateInstanceInput,
  tx: SqlTx,
): Promise<AdmissionPlan<Instance>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const { idempotencyKey: _key, ...request } = input;
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
        deps.runtime,
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
 * Places a hosted instance: vCPU/memory/disk scalar claims plus whole-GPU atoms (VFIO) through the
 * CapacityPort, then an IP lease. `pending` keeps `scheduling` with `Unschedulable`.
 */
export async function scheduleHosted(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
): Promise<InstanceRow> {
  const now = deps.clock.now();
  const outcome = await deps.capacity.reserve(tx, {
    tenantId: row.tenantId,
    poolId: row.poolId,
    ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    instanceId: row.id,
    devices: row.shape.gpus > 0 ? [{ class: 'gpu', count: row.shape.gpus }] : [],
    resources: { vcpu: row.shape.vcpu, memoryGiB: row.shape.memoryGiB, diskGiB: row.shape.diskGiB },
    during: { start: now, end: openEnded },
  });
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
  const next = await moveInstance(tx, row, 'complete', 'provisioning', {
    nodeId: allocation.nodeId,
    allocationId: allocation.id,
    addresses: address ? [address] : [],
    reportedState: null,
    conditions: withoutCondition(row.conditions, 'Unschedulable'),
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
  if (next.poolClass === 'provider') {
    const demand = instanceDemand(next.shape);
    await chargeQuota(tx, next.tenantId, next.poolId, demand);
    next = await updateInstance(tx, next, { quotaCharged: demand });
    await deps.work.enqueue(tx, instanceWork, next.id);
  } else next = await scheduleHosted(deps, tx, next);
  await publishInstance(deps, tx, next, 'instance.created');
  return instanceView(next);
}

// --- Later operations: desiredState only -----------------------------------------------------------

async function lockOwned(tx: SqlTx, ref: InstanceRef): Promise<InstanceRow> {
  const row = await readInstance(tx, ref.instanceId, { tenantId: ref.tenantId, lock: true });
  if (!row || row.draft)
    throw new ComputeError('NOT_FOUND', `Instance ${ref.instanceId} not found`);
  return row;
}

async function wake(deps: InstanceDeps, tx: SqlTx, row: InstanceRow): Promise<void> {
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
  const outcome = await resizeAllocation(tx, row.allocationId, {
    vcpu: shape.vcpu,
    memoryGiB: shape.memoryGiB,
    diskGiB: shape.diskGiB,
  });
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
  const resized = await moveInstance(tx, resizing, 'complete', 'stopped');
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
      WHERE i.tenant_id = $1 AND NOT i.draft
        AND ($2::text IS NULL OR i.owner_identity_id = $2)
        AND ($3::text IS NULL OR i.state = $3) AND ($4::text IS NULL OR i.pool_id = $4)
        AND ($5::text IS NULL OR i.id < $5)
      ORDER BY i.id DESC LIMIT $6`,
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
