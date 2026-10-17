import {
  ComputeError,
  draftId,
  strictObject,
  type AdmissionPlan,
  type Caller,
  type Instance,
  type InputSchema,
  type Json,
  type MethodContext,
  type Migration,
  type SqlTx,
} from '@better-compute/core';
import { chargeQuota } from '@better-compute/capacity';
import type { StoredMachine } from './discovery.js';
import { canonical, fail, id, key, name, object, optional, sha256Hex, tenant } from './input.js';
import {
  instanceAttributes,
  instanceDemand,
  instanceView,
  instanceWork,
  publishInstance,
  readInstance,
  visibleVpsPool,
  type InstanceDeps,
  type InstanceOnDelete,
  type InstanceShape,
} from './instances.js';

// Attaching a provider machine that already runs (R1, D5-D7): `instances.attach` writes an
// `instances` row (`origin='attached'`) in a provider pool, in `scheduling` with its `external_id`
// set, so the provider reconciler claims the machine's ownership label and adopts it instead of
// creating one. `provider_machines` (vps.discovery) is the referee: the machine row is locked, must
// be seen and free, and is linked in the same transaction; a partial unique index on
// (provider_account_id, external_id) refuses a second live instance of one machine.

export const instanceAttachMigration: Migration = {
  name: 'vps/0024_instance_attach',
  sql: `
ALTER TABLE instances ALTER COLUMN flavor_id DROP NOT NULL;
ALTER TABLE instances ALTER COLUMN image_id DROP NOT NULL;
ALTER TABLE instances ADD COLUMN origin text NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'attached'));
ALTER TABLE instances ADD COLUMN on_delete text NOT NULL DEFAULT 'delete' CHECK (on_delete IN ('delete', 'detach'));
ALTER TABLE instances ADD COLUMN attached_at timestamptz;
-- The provider's ownership label was written. (The plan's claimed_at is taken: vps/0006 gave it
-- to warm instances a sandbox claimed.)
ALTER TABLE instances ADD COLUMN provider_claimed_at timestamptz;
ALTER TABLE instances ADD COLUMN reboot_requested_at timestamptz;
ALTER TABLE instances ADD COLUMN rebooted_at timestamptz;
ALTER TABLE instances ADD COLUMN reboot_hard bool NOT NULL DEFAULT false;
CREATE UNIQUE INDEX instances_external_live ON instances (provider_account_id, external_id)
  WHERE external_id IS NOT NULL AND state NOT IN ('deleted');
`,
};

export interface AttachInstanceInput {
  /** The customer tenant that will own the instance. */
  tenantId: string;
  /** A `class: 'provider'` pool owned by or offered to `tenantId`, backed by the machine's account. */
  poolId: string;
  /** The provider machine id (`us-central1-a/legacy`). */
  externalId: string;
  projectId?: string;
  /** Who owns it in the tenant (default: the caller), so it shows in their `scope: 'mine'` list. */
  ownerIdentityId?: string;
  /** `detach` (default): deleting releases the machine and leaves it running. */
  onDelete?: InstanceOnDelete;
  name?: string;
  idempotencyKey: string;
}

/** What attaching needs beyond its transaction. */
export type AttachDeps = Pick<InstanceDeps, 'events' | 'work' | 'authz' | 'runtime'> & {
  /** The IAM root tenant (`iam.rootTenantId`): its callers may attach from any account. */
  rootTenantId?: string;
};

const externalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const identityPattern = /^[A-Za-z0-9._:@-]{1,128}$/;

const field = (description: string, pattern: string, maxLength: number): InputSchema => ({
  type: 'string',
  pattern,
  maxLength,
  description,
});

export const attachSchemas = {
  attach: strictObject(
    {
      tenantId: field('The tenant that will own the instance', '^[A-Za-z0-9._:-]{1,128}$', 128),
      poolId: field(
        'A provider pool owned by or offered to the tenant, backed by the machine’s account',
        '^pool_[0-9a-hjkmnp-tv-z]{26,52}$',
        57,
      ),
      externalId: field(
        'The provider machine id, as providerAccounts.machines lists it (us-central1-a/legacy)',
        externalIdPattern.source,
        256,
      ),
      projectId: field('The project it belongs to', '^prj_[0-9a-hjkmnp-tv-z]{26,52}$', 56),
      ownerIdentityId: field(
        'The identity that owns it in the tenant (default: the caller)',
        identityPattern.source,
        128,
      ),
      onDelete: {
        enum: ['detach', 'delete'],
        default: 'detach',
        description:
          'detach: deleting releases the machine, which keeps running; delete: deleting deletes it',
      },
      name: field('A display name', '^[a-z0-9][a-z0-9._-]{0,62}$', 63),
      idempotencyKey: field(
        'Scoped to (tenant, caller identity): a retry with the same key replays',
        '^[A-Za-z0-9._:-]{1,128}$',
        128,
      ),
    },
    ['tenantId', 'poolId', 'externalId', 'idempotencyKey'],
  ),
};

export function parseAttach(raw: unknown): AttachInstanceInput {
  const input = object(raw, [
    'tenantId',
    'poolId',
    'externalId',
    'projectId',
    'ownerIdentityId',
    'onDelete',
    'name',
    'idempotencyKey',
  ]);
  if (typeof input.externalId !== 'string' || !externalIdPattern.test(input.externalId))
    fail('externalId is invalid');
  if (
    input.ownerIdentityId !== undefined &&
    (typeof input.ownerIdentityId !== 'string' || !identityPattern.test(input.ownerIdentityId))
  )
    fail('ownerIdentityId is invalid');
  if (input.onDelete !== undefined && input.onDelete !== 'detach' && input.onDelete !== 'delete')
    fail('onDelete must be detach or delete');
  const result: AttachInstanceInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    externalId: input.externalId,
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) result.projectId = projectId;
  if (input.ownerIdentityId !== undefined) result.ownerIdentityId = input.ownerIdentityId as string;
  if (input.onDelete !== undefined) result.onDelete = input.onDelete as InstanceOnDelete;
  const label = optional(input.name, (value) => name(value));
  if (label !== undefined) result.name = label;
  return result;
}

/** The instance id, request hash and resolved defaults of one attach. */
async function attachRequest(input: AttachInstanceInput, caller: Caller) {
  const request = {
    tenantId: input.tenantId,
    poolId: input.poolId,
    externalId: input.externalId,
    projectId: input.projectId,
    ownerIdentityId: input.ownerIdentityId ?? caller.identityId,
    onDelete: input.onDelete ?? 'detach',
    name: input.name,
  };
  return {
    request,
    hash: await sha256Hex(canonical(request)),
    instanceId: await draftId('inst', input.tenantId, caller.identityId, input.idempotencyKey),
  };
}

/** The flavor an attached machine is admitted with: its own shape, no disk of ours. */
export function machineShape(
  machine: Pick<StoredMachine, 'machineType' | 'vcpu' | 'memoryGiB' | 'gpus'>,
): InstanceShape {
  return {
    name: machine.machineType ?? 'attached',
    vcpu: machine.vcpu ?? 0,
    memoryGiB: machine.memoryGiB ?? 0,
    diskGiB: 0,
    gpus: machine.gpus?.count ?? 0,
  };
}

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

async function readMachine(
  tx: SqlTx,
  accountId: string,
  externalId: string,
  lock: boolean,
): Promise<{ machine: StoredMachine; instanceId?: string; gone: boolean } | undefined> {
  const { rows } = await tx.query<{
    machine: StoredMachine | string;
    instance_id: string | null;
    gone: boolean;
  }>(
    `SELECT machine, instance_id, gone_at IS NOT NULL AS gone FROM provider_machines
      WHERE account_id = $1 AND external_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [accountId, externalId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    machine: json(row.machine),
    gone: row.gone,
    ...(row.instance_id !== null ? { instanceId: row.instance_id } : {}),
  };
}

const conflict = (instanceId: string) =>
  new ComputeError('CONFLICT', 'This idempotency key was used for a different request', undefined, {
    instanceId,
  });

/**
 * `instances.attach`, transaction 1 (the admission's `prepare`): the idempotency lookup, the pool
 * check and the authz projection row of the instance-to-be, which IAM decides on.
 */
export async function prepareAttach(
  context: MethodContext,
  input: AttachInstanceInput,
  tx: SqlTx,
): Promise<AdmissionPlan<Instance>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const { request, hash, instanceId } = await attachRequest(input, caller);
  const existing = await readInstance(tx, instanceId, { tenantId: input.tenantId, lock: true });
  if (existing) {
    if (existing.requestHash !== hash) throw conflict(instanceId);
    if (!existing.draft) return { status: 'replay', result: instanceView(existing) };
  }
  const pool = await visibleVpsPool(tx, input.tenantId, input.poolId);
  const found = pool.providerAccountId
    ? await readMachine(tx, pool.providerAccountId, input.externalId, false)
    : undefined;
  await context.authz.upsert(tx, {
    type: 'instance',
    id: instanceId,
    tenantId: input.tenantId,
    attributes: instanceAttributes(machineShape(found?.machine ?? {}), '', false, input.projectId),
    parentType: 'pool',
    parentId: input.poolId,
    ownerId: request.ownerIdentityId,
  });
  return { status: 'decide', resource: { type: 'instance', id: instanceId } };
}

/** A refused or failed attach: the projection row of an instance that does not exist goes. */
export async function forgetAttach(
  context: MethodContext,
  input: AttachInstanceInput,
  tx: SqlTx,
): Promise<void> {
  const caller = context.caller;
  if (!caller) return;
  const instanceId = await draftId('inst', input.tenantId, caller.identityId, input.idempotencyKey);
  const { rows } = await tx.query(`SELECT 1 FROM instances WHERE id = $1`, [instanceId]);
  if (rows.length === 0)
    await context.authz.remove(tx, { type: 'instance', id: instanceId, tenantId: input.tenantId });
}

/**
 * Attaches a provider machine to a tenant (in the caller's transaction): the API handler and
 * label-driven auto-attach both call it. Nothing is written unless it succeeds.
 */
export async function attachMachine(
  tx: SqlTx,
  deps: AttachDeps,
  input: AttachInstanceInput & { caller: Caller },
): Promise<Instance> {
  const { caller } = input;
  const { request, hash, instanceId } = await attachRequest(input, caller);
  const existing = await readInstance(tx, instanceId, { tenantId: input.tenantId, lock: true });
  if (existing) {
    if (existing.requestHash !== hash) throw conflict(instanceId);
    return instanceView(existing);
  }

  // 1. A provider pool the tenant may use.
  const pool = await visibleVpsPool(tx, input.tenantId, input.poolId);
  if (pool.class !== 'provider')
    throw new ComputeError(
      'INVALID_INPUT',
      `Pool ${pool.id} is ${pool.class}, not a provider pool`,
    );
  if (!pool.providerAccountId)
    throw new ComputeError('INVALID_STATE', `Provider pool ${pool.id} has no provider account`);
  const accountId = pool.providerAccountId;

  // 2. Only the account's own tenant, or the platform, hands its machines out. Checked before the
  // machine, so a tenant learns nothing about machines of accounts it may not use.
  const { rows: accounts } = await tx.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM provider_accounts WHERE id = $1`,
    [accountId],
  );
  const accountTenant = accounts[0]?.tenant_id;
  const rootCaller =
    deps.rootTenantId !== undefined
      ? caller.tenantId === deps.rootTenantId
      : // Without the root tenant's id: only root callers act across tenants (the envelope's check).
        caller.tenantId !== input.tenantId;
  if (accountTenant !== caller.tenantId && !rootCaller)
    throw new ComputeError(
      'ACCESS_DENIED',
      `Only the platform attaches machines of provider account ${accountId}`,
    );

  // 3. The machine: seen by discovery, still there, and free (locked until this commits).
  const found = await readMachine(tx, accountId, input.externalId, true);
  if (!found || found.gone)
    throw new ComputeError(
      'NOT_FOUND',
      `Machine ${input.externalId} is not in provider account ${accountId}; run providerAccounts.discover`,
      undefined,
      { externalId: input.externalId, hint: 'run providerAccounts.discover' },
    );
  if (found.instanceId !== undefined)
    throw new ComputeError(
      'CONFLICT',
      `Machine ${input.externalId} is already instance ${found.instanceId}`,
      undefined,
      { instanceId: found.instanceId },
    );
  const { machine } = found;
  if (machine.state === 'deleting' || machine.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Machine ${input.externalId} is ${machine.state}`);

  // 4. Quota, as a provider-pool create charges it.
  const shape = machineShape(machine);
  const demand = instanceDemand(shape);
  await chargeQuota(tx, input.tenantId, pool.id, demand);

  // 5. The instance, in scheduling with its machine: the reconciler claims and adopts it.
  await tx.query('SAVEPOINT vps_attach');
  try {
    await tx.query(
      `INSERT INTO instances (id, tenant_id, pool_id, project_id, flavor_id, flavor, image_id, image,
                              ssh_keys, user_data, runtime, draft, state, desired_state,
                              provider_account_id, external_id, addresses, quota_charged,
                              owner_identity_id, agent_id, delegation_id, idempotency_key,
                              request_hash, version, origin, on_delete, attached_at)
       VALUES ($1, $2, $3, $4, NULL, $5::jsonb, NULL, NULL, '{}', NULL, $6, false, 'scheduling', $7,
               $8, $9, $10::text[], $11::jsonb, $12, $13, $14, $15, decode($16, 'hex'), 1,
               'attached', $17, compute_now())`,
      [
        instanceId,
        input.tenantId,
        pool.id,
        input.projectId ?? null,
        JSON.stringify(shape),
        deps.runtime,
        machine.state === 'stopped' ? 'stopped' : 'running',
        accountId,
        input.externalId,
        machine.addresses ?? [],
        JSON.stringify(demand),
        request.ownerIdentityId,
        caller.agentId ?? null,
        caller.delegationId ?? null,
        input.idempotencyKey,
        hash,
        request.onDelete,
      ],
    );
    await tx.query('RELEASE SAVEPOINT vps_attach');
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT vps_attach');
    // instances_external_live, or the (tenant, owner, key) of another caller's attach.
    if ((error as { code?: unknown }).code === '23505')
      throw new ComputeError(
        'CONFLICT',
        `Machine ${input.externalId} is already attached, or the key was used for it`,
      );
    throw error;
  }

  // 6. The machine is this instance's now.
  await tx.query(
    `UPDATE provider_machines SET instance_id = $3 WHERE account_id = $1 AND external_id = $2`,
    [accountId, input.externalId, instanceId],
  );
  const row = (await readInstance(tx, instanceId))!;
  // 7. Who may see and act on it.
  await deps.authz.upsert(tx, {
    type: 'instance',
    id: instanceId,
    tenantId: input.tenantId,
    attributes: instanceAttributes(shape, '', false, input.projectId),
    parentType: 'pool',
    parentId: pool.id,
    ownerId: request.ownerIdentityId,
  });
  // 8. The event, and 9. the reconciler.
  const data: Record<string, Json> = {
    instanceId,
    accountId,
    externalId: input.externalId,
    poolId: pool.id,
    onDelete: request.onDelete,
  };
  if (input.name !== undefined) data.name = input.name;
  await publishInstance(deps, tx, row, 'instance.attached', data);
  await deps.work.enqueue(tx, instanceWork, instanceId);
  return instanceView(row);
}
