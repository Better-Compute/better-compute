import {
  ComputeError,
  draftId,
  type AdmissionPlan,
  type CallContext,
  type MethodContext,
  type ProviderDiscoveredResource,
  type SqlTx,
} from '@better-compute/core';
import { canonical, sha256Hex } from './input.js';
import { assertAllowance, authzRow } from './resources.js';
import {
  kindOf,
  poolResources,
  providerResourceName,
  publish,
  readResource,
  requireResource,
  resourceView,
  resourceViewOf,
  resourcesWork,
  tenantSecrets,
  type CloudResourcesDeps,
  type ResourcesProvider,
} from './store.js';
import type {
  AdoptResourceInput,
  CloudResourceView,
  DiscoverInput,
  DiscoveredResourceView,
  ResourceRef,
} from './types.js';

// `cloudResources.discover`, `adopt` and `release`: what exists on the tenant's own provider account, taking an
// unmanaged resource over, and letting a managed one go. Only on an account the tenant owns: a platform account
// offered to many tenants is never listed to one of them, and nothing there is taken over through it.

/** At most this many resources a discover lists. */
export const maxDiscovered = 500;

/** The pool's account and resources, when the tenant owns the account (BYO); ACCESS_DENIED otherwise. */
async function ownAccountResources(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<ResourcesProvider> {
  const provider = await poolResources(deps, tx, tenantId, poolId);
  if (provider.account.tenantId !== tenantId)
    throw new ComputeError(
      'ACCESS_DENIED',
      `Pool ${poolId} is on a provider account of another tenant; discovery and adoption are for your own accounts`,
      undefined,
      { reason: 'notAccountOwner' },
    );
  return provider;
}

const call = (
  deps: CloudResourcesDeps,
  tenantId: string,
  key: string,
  signal?: AbortSignal,
): CallContext => ({
  idempotencyKey: key,
  signal: signal ?? new AbortController().signal,
  clock: deps.clock,
  secrets: tenantSecrets(deps, tenantId),
  log: deps.log,
});

/** Lists the kind's resources at the provider (outside any transaction), at most `maxDiscovered`. */
async function discovered(
  deps: CloudResourcesDeps,
  provider: ResourcesProvider,
  tenantId: string,
  kind: string,
  signal?: AbortSignal,
): Promise<ProviderDiscoveredResource[]> {
  const found = kindOf(provider, kind);
  if (typeof provider.resources.discover !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${provider.account.provider} cannot discover ${found.kind}`,
    );
  const items: ProviderDiscoveredResource[] = [];
  for await (const item of provider.resources.discover(
    kind,
    call(deps, tenantId, `discover:${kind}`, signal),
  )) {
    items.push(item);
    if (items.length >= maxDiscovered) break;
  }
  return items;
}

/**
 * `cloudResources.discover` (declared `transaction: 'manual'`): the kind's resources on the tenant's own account,
 * with the cloud resource that records each one, if any.
 */
export async function discoverResources(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: DiscoverInput,
): Promise<{ items: DiscoveredResourceView[] }> {
  const provider = await context.sql.transaction((tx) =>
    ownAccountResources(deps, tx, input.tenantId, input.poolId),
  );
  const items = await discovered(deps, provider, input.tenantId, input.kind, context.signal);
  const known = await context.sql.transaction((tx) =>
    tx.query<{ id: string; provider_id: string }>(
      `SELECT id, provider_id FROM cloud_resources
        WHERE provider_account_id = $1 AND kind = $2 AND provider_id = ANY($3::text[])
          AND state NOT IN ('deleted', 'released')`,
      [provider.account.id, input.kind, items.map((item) => item.id)],
    ),
  );
  const byProviderId = new Map(known.rows.map((row) => [row.provider_id, row.id]));
  return {
    items: items.map((item) => ({
      providerId: item.id,
      name: item.name,
      ...(item.region !== undefined ? { region: item.region } : {}),
      ...(item.managedBy !== undefined ? { managedBy: item.managedBy } : {}),
      ...(byProviderId.has(item.id) ? { resourceId: byProviderId.get(item.id)! } : {}),
      ...(item.spec !== undefined ? { spec: { ...item.spec } } : {}),
    })),
  };
}

const adoptHash = (input: AdoptResourceInput) => {
  const { tenantId: _tenant, idempotencyKey: _key, ...request } = input;
  return sha256Hex(canonical({ adopt: request }));
};

async function admitAdopt(deps: CloudResourcesDeps, tx: SqlTx, input: AdoptResourceInput) {
  const provider = await ownAccountResources(deps, tx, input.tenantId, input.poolId);
  const kind = kindOf(provider, input.kind);
  if (kind.parent !== undefined)
    throw new ComputeError(
      'UNSUPPORTED',
      `${kind.kind} lives in a ${kind.parent}; adopt the ${kind.parent} and create its ${kind.kind} resources`,
    );
  if (typeof provider.resources.adopt !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${provider.account.provider} cannot adopt ${kind.kind}`,
    );
  if ((kind.secretOutputs ?? []).length > 0 && typeof deps.secrets?.put !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `${kind.kind} returns secrets, and this deployment has no secret store to seal them in`,
      undefined,
      { reason: 'secretStore' },
    );
  const taken = await tx.query<{ id: string }>(
    `SELECT id FROM cloud_resources
      WHERE ((provider_account_id = $1 AND kind = $2 AND provider_id = $3) OR (tenant_id = $4 AND kind = $2 AND name = $5))
        AND state NOT IN ('deleted', 'released')`,
    [provider.account.id, input.kind, input.providerId, input.tenantId, input.name],
  );
  if (taken.rows.length > 0)
    throw new ComputeError(
      'CONFLICT',
      `${input.kind} ${input.providerId} is already recorded, or the name ${input.name} is taken`,
      undefined,
      { resourceId: taken.rows[0]!.id },
    );
  return { provider, kind };
}

/** `cloudResources.adopt` transaction 1: as create's, on the draft `cloud-resource/<id>`. */
export async function prepareAdopt(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: AdoptResourceInput,
  tx: SqlTx,
): Promise<AdmissionPlan<CloudResourceView>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const resourceId = await draftId('crs', input.tenantId, caller.identityId, input.idempotencyKey);
  const existing = await readResource(tx, { resourceId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== (await adoptHash(input)))
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return { status: 'replay', result: resourceView(existing) };
  }
  const admitted = await admitAdopt(deps, tx, input);
  await assertAllowance(deps, tx, input.tenantId, input.kind);
  await context.authz.upsert(tx, authzRow(resourceId, input, admitted, caller.identityId));
  return { status: 'decide', resource: { type: 'cloud-resource', id: resourceId } };
}

/**
 * `cloudResources.adopt` after the decision, with no transaction open: the resource exists at the provider and no
 * other deployment manages it. (The reconciler writes the ownership labels; the provider refuses there too.)
 */
export async function checkAdopt(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: AdoptResourceInput,
): Promise<void> {
  const provider = await context.sql.transaction((tx) =>
    ownAccountResources(deps, tx, input.tenantId, input.poolId),
  );
  const item = (await discovered(deps, provider, input.tenantId, input.kind, context.signal)).find(
    (entry) => entry.id === input.providerId,
  );
  if (!item)
    throw new ComputeError(
      'NOT_FOUND',
      `${input.kind} ${input.providerId} not found on the provider account`,
    );
  if (item.managedBy === 'other')
    throw new ComputeError(
      'INVALID_STATE',
      `${input.kind} ${input.providerId} is managed by another better-compute deployment`,
      undefined,
      { reason: 'managedByAnother' },
    );
}

/** `cloudResources.adopt` (transaction 2): records the resource `pending`, adopted; the reconciler takes it over. */
export async function adoptResource(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: AdoptResourceInput,
): Promise<CloudResourceView> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const resourceId = await draftId('crs', input.tenantId, caller.identityId, input.idempotencyKey);
  const hash = await adoptHash(input);
  const existing = await readResource(tx, { resourceId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return resourceView(existing);
  }
  const admitted = await admitAdopt(deps, tx, input);
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext('better-compute:cloud-resources:' || $1))`,
    [input.tenantId],
  );
  await assertAllowance(deps, tx, input.tenantId, input.kind);
  try {
    await tx.query(
      `INSERT INTO cloud_resources (id, tenant_id, project_id, pool_id, provider_account_id, provider, kind, family,
                                    name, description, spec, provider_name, provider_id, state, desired_state, adopted,
                                    created_by, idempotency_key, request_hash, version, provisioned_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, $11, $12, 'pending', 'present', true, $13, $14,
               decode($15, 'hex'), 1, compute_now())`,
      [
        resourceId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        admitted.provider.account.id,
        admitted.provider.account.provider,
        input.kind,
        admitted.kind.family,
        input.name,
        input.description ?? null,
        providerResourceName(resourceId),
        input.providerId,
        caller.identityId,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ComputeError('CONFLICT', `${input.kind} ${input.providerId} is already recorded`);
    throw error;
  }
  await deps.authz.upsert(tx, authzRow(resourceId, input, admitted, caller.identityId));
  await deps.work.enqueue(tx, resourcesWork, resourceId);
  await publish(
    deps,
    tx,
    { id: resourceId, tenant_id: input.tenantId, kind: input.kind },
    'adopted',
    {
      poolId: input.poolId,
      providerAccountId: admitted.provider.account.id,
      family: admitted.kind.family,
      name: input.name,
      providerId: input.providerId,
    },
  );
  return resourceViewOf(tx, resourceId);
}

/**
 * `cloudResources.release`: better-compute lets the resource go (the reconciler removes its ownership labels and
 * leaves it running at the provider); the row ends `released`. Refused while resources still live in it.
 */
export async function releaseResource(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  ref: ResourceRef,
): Promise<CloudResourceView> {
  const row = await requireResource(tx, ref, { lock: true });
  if (row.desired_state === 'released') return resourceView(row);
  if (row.desired_state !== 'present' || row.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Cloud resource ${row.id} is being deleted`);
  if (row.provider_id === null)
    throw new ComputeError(
      'INVALID_STATE',
      `Cloud resource ${row.id} does not exist at the provider yet; delete it instead`,
    );
  if (row.parent_id !== null)
    throw new ComputeError(
      'INVALID_STATE',
      `Cloud resource ${row.id} lives in ${row.parent_id}; release that instead`,
    );
  const children = await tx.query(
    `SELECT 1 FROM cloud_resources WHERE parent_id = $1 AND state NOT IN ('deleted', 'released') LIMIT 1`,
    [row.id],
  );
  if (children.rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Resources still live in ${row.id}; delete them before releasing it`,
    );
  await tx.query(
    `UPDATE cloud_resources
        SET desired_state = 'released', message = NULL, version = version + 1, updated_at = compute_now()
      WHERE id = $1`,
    [row.id],
  );
  await deps.work.enqueue(tx, resourcesWork, row.id);
  await publish(deps, tx, row, 'releasing');
  return resourceViewOf(tx, row.id);
}
