import {
  ComputeError,
  draftId,
  validateManifest,
  type AdmissionPlan,
  type JsonSchema,
  type MethodContext,
  type ProviderResourceKind,
  type SqlTx,
} from '@better-compute/core';
import { canonical, sha256Hex } from './input.js';
import {
  kindOf,
  poolResources,
  providerResourceName,
  publish,
  readResource,
  requireResource,
  resourceColumns,
  resourceView,
  resourceViewOf,
  resourcesWork,
  json,
  type CloudResourcesDeps,
  type ResourceRow,
  type ResourcesProvider,
} from './store.js';
import type {
  CloudResourceKindView,
  CloudResourceView,
  CreateResourceInput,
  KindsInput,
  ListResourcesInput,
  ResourceRef,
  UpdateResourceInput,
} from './types.js';

// The `cloudResources` handlers. They record what the tenant wants and wake the `cloud.resources` reconciler; none
// calls the provider (building a client makes no request).

const code = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;
const uniqueViolation = (error: unknown) => code(error) === '23505';

const requestHash = (input: CreateResourceInput) => {
  const { tenantId: _tenant, idempotencyKey: _key, ...request } = input;
  return sha256Hex(canonical(request));
};

/** The kind's spec schema, when its manifest describes itself (`manifest(...)` does). */
function specSchema(kind: ProviderResourceKind): JsonSchema {
  const describe = (kind.spec as { jsonSchema?: () => JsonSchema }).jsonSchema;
  return typeof describe === 'function' ? describe.call(kind.spec) : {};
}

/** `cloudResources.kinds`: what the pool's provider serves, with each spec's JSON Schema. */
export async function listKinds(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  input: KindsInput,
): Promise<{ items: CloudResourceKindView[] }> {
  const provider = await poolResources(deps, tx, input.tenantId, input.poolId);
  return {
    items: provider.resources.kinds().map((kind) => ({
      kind: kind.kind,
      family: kind.family,
      ...(kind.description !== undefined ? { description: kind.description } : {}),
      specSchema: specSchema(kind),
      outputs: [...kind.outputs],
      secretOutputs: [...(kind.secretOutputs ?? [])],
      regional: kind.regional,
      updatable: [...kind.updatable],
      meters: (kind.meters ?? []).map((meter) => ({ ...meter })),
      preview: kind.preview === true,
      available: kind.preview !== true || provider.previews,
      ...(kind.parent !== undefined ? { parent: kind.parent } : {}),
      quota: deps.quotaOf(kind.kind),
    })),
  };
}

/** What a create resolves before anything is written. */
interface Admitted {
  provider: ResourcesProvider;
  kind: ProviderResourceKind;
  spec: Record<string, unknown>;
  region?: string;
  parent?: ResourceRow;
  /** The kind's identity of the spec within the parent (`ProviderResourceKind.identity`). */
  identity?: string;
}

/** A child's identity within its parent, when its kind declares one: a non-empty string, else none. */
function identityOf(kind: ProviderResourceKind, spec: unknown): string | undefined {
  if (kind.parent === undefined || typeof kind.identity !== 'function') return undefined;
  const value = kind.identity(spec);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * CONFLICT when another live resource of the kind in the parent has the identity: both would manage one provider
 * resource (two firewalls of a cluster, two users of one name), each re-applying its own spec over the other's.
 */
async function assertIdentityFree(
  tx: SqlTx,
  parentId: string,
  kind: string,
  identity: string,
  except?: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM cloud_resources
      WHERE parent_id = $1 AND kind = $2 AND identity = $3 AND state NOT IN ('deleted', 'released')
        AND ($4::text IS NULL OR id <> $4)
      LIMIT 1`,
    [parentId, kind, identity, except ?? null],
  );
  if (rows[0])
    throw new ComputeError(
      'CONFLICT',
      `Cloud resource ${rows[0].id} already manages that ${kind} of ${parentId}; a provider resource has one cloud resource`,
      undefined,
      { reason: 'identity', resourceId: rows[0].id, kind },
    );
}

/** The spec through the kind's manifest: INVALID_INPUT with the manifest's issues, prefixed `spec.`. */
export async function validSpec(
  kind: ProviderResourceKind,
  spec: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const value = await validateManifest(kind.spec, spec);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new ComputeError('INVALID_INPUT', `spec: ${kind.kind} specs are objects`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'INVALID_INPUT')
      throw new ComputeError('INVALID_INPUT', `spec.${error.message}`, undefined, {
        ...(error.details ?? {}),
        field: 'spec',
        kind: kind.kind,
      });
    throw error;
  }
}

/** A regional kind's region: a string in its spec, and one the account configures (when it lists any). */
export function regionOf(
  provider: Pick<ResourcesProvider, 'regions' | 'account'>,
  kind: ProviderResourceKind,
  spec: Record<string, unknown>,
): string | undefined {
  if (!kind.regional) return undefined;
  const region = spec.region;
  if (typeof region !== 'string' || region.length === 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `spec.region: ${kind.kind} is regional; name a region`,
      undefined,
      {
        field: 'spec.region',
      },
    );
  if (provider.regions.length > 0 && !provider.regions.includes(region))
    throw new ComputeError(
      'INVALID_INPUT',
      `spec.region: ${region} is not a region of the provider account`,
      undefined,
      { field: 'spec.region', regions: provider.regions },
    );
  return region;
}

/** Refusals of a kind that do not depend on the spec: previews, and secret outputs without a store to seal them. */
function assertKindAllowed(
  deps: CloudResourcesDeps,
  provider: ResourcesProvider,
  kind: ProviderResourceKind,
): void {
  if (kind.preview === true && !provider.previews)
    throw new ComputeError(
      'UNSUPPORTED',
      `${kind.kind} is a provider preview; the account must enable previews`,
      undefined,
      { reason: 'preview', kind: kind.kind },
    );
  if ((kind.secretOutputs ?? []).length > 0 && typeof deps.secrets?.put !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `${kind.kind} returns secrets, and this deployment has no secret store to seal them in`,
      undefined,
      { reason: 'secretStore', kind: kind.kind },
    );
}

/**
 * A spec that reaches account-wide objects (`ProviderResourceKind.accountWide`) is refused on an account that is not
 * the tenant's own (a hosted pool), before anything is recorded.
 */
function assertAccountScope(
  provider: ResourcesProvider,
  tenantId: string,
  kind: ProviderResourceKind,
  spec: unknown,
): void {
  if (typeof kind.accountWide !== 'function' || provider.account.tenantId === tenantId) return;
  const fields = [...kind.accountWide(spec)];
  if (fields.length > 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `${kind.kind}: spec.${fields[0]} reaches account-wide objects; only a resource on the tenant's own account may name it`,
      undefined,
      { reason: 'accountWide', fields, kind: kind.kind },
    );
}

/**
 * The instances a spec names (`ProviderResourceKind.instances`) must be live instances of the tenant on the same
 * provider account: INVALID_INPUT otherwise, the same for one that does not exist and one of another tenant.
 */
export async function assertInstances(
  tx: SqlTx,
  tenantId: string,
  accountId: string,
  kind: ProviderResourceKind,
  spec: unknown,
  /** On an update, the stored spec: the instances it already named are not checked again (one may be gone). */
  before?: unknown,
): Promise<void> {
  if (typeof kind.instances !== 'function') return;
  const kept = new Set(before === undefined ? [] : kind.instances(before));
  const named = [...new Set(kind.instances(spec))].filter((id) => !kept.has(id));
  if (named.length === 0) return;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM instances
      WHERE id = ANY($1::text[]) AND tenant_id = $2 AND provider_account_id = $3 AND NOT draft
        AND desired_state <> 'deleted' AND state <> 'deleted'`,
    [named, tenantId, accountId],
  );
  const found = new Set(rows.map((row) => row.id));
  const missing = named.filter((id) => !found.has(id));
  if (missing.length > 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `${kind.kind}: instance ${missing[0]} is not an instance of this tenant on the pool's provider account`,
      undefined,
      { reason: 'instance', field: 'spec', instances: missing, kind: kind.kind },
    );
}

async function parentOf(
  tx: SqlTx,
  input: { tenantId: string; parentId?: string },
  kind: ProviderResourceKind,
  accountId: string,
): Promise<ResourceRow | undefined> {
  if (kind.parent === undefined) {
    if (input.parentId !== undefined)
      throw new ComputeError(
        'INVALID_INPUT',
        `${kind.kind} has no parent; drop parentId`,
        undefined,
        {
          field: 'parentId',
        },
      );
    return undefined;
  }
  if (input.parentId === undefined)
    throw new ComputeError(
      'INVALID_INPUT',
      `${kind.kind} lives in a ${kind.parent}; name it in parentId`,
      undefined,
      { field: 'parentId', parent: kind.parent },
    );
  // FOR SHARE: a concurrent delete or release of the parent (FOR UPDATE) either sees this child once it commits, or
  // committed first and its desired_state is seen here.
  const parent = await readResource(
    tx,
    { resourceId: input.parentId, tenantId: input.tenantId },
    { lock: 'share' },
  );
  if (!parent || parent.state === 'deleted' || parent.state === 'released')
    throw new ComputeError(
      'INVALID_INPUT',
      `Cloud resource ${input.parentId} not found`,
      undefined,
      {
        field: 'parentId',
      },
    );
  if (parent.kind !== kind.parent || parent.provider_account_id !== accountId)
    throw new ComputeError(
      'INVALID_INPUT',
      `parentId must be a ${kind.parent} on the same provider account`,
      undefined,
      { field: 'parentId' },
    );
  if (parent.desired_state !== 'present')
    throw new ComputeError('INVALID_STATE', `Cloud resource ${parent.id} is being deleted`);
  return parent;
}

async function admit(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  input: CreateResourceInput,
): Promise<Admitted> {
  const provider = await poolResources(deps, tx, input.tenantId, input.poolId);
  const kind = kindOf(provider, input.kind);
  assertKindAllowed(deps, provider, kind);
  const spec = await validSpec(kind, input.spec);
  assertAccountScope(provider, input.tenantId, kind, spec);
  await assertInstances(tx, input.tenantId, provider.account.id, kind, spec);
  const region = regionOf(provider, kind, spec);
  const parent = await parentOf(tx, input, kind, provider.account.id);
  const identity = parent ? identityOf(kind, spec) : undefined;
  if (parent && identity !== undefined) await assertIdentityFree(tx, parent.id, kind.kind, identity);
  return {
    provider,
    kind,
    spec,
    ...(region !== undefined ? { region } : {}),
    ...(parent ? { parent } : {}),
    ...(identity !== undefined ? { identity } : {}),
  };
}

async function assertNameFree(
  tx: SqlTx,
  tenantId: string,
  kind: string,
  name: string,
): Promise<void> {
  const taken = await tx.query(
    `SELECT 1 FROM cloud_resources
      WHERE tenant_id = $1 AND kind = $2 AND name = $3 AND state NOT IN ('deleted', 'released')`,
    [tenantId, kind, name],
  );
  if (taken.rows.length > 0) throw new ComputeError('CONFLICT', `${kind} ${name} already exists`);
}

/** QUOTA_EXCEEDED when the tenant already has its quota of the kind (resources not deleted or released). */
export async function assertAllowance(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  tenantId: string,
  kind: string,
): Promise<void> {
  const limit = deps.quotaOf(kind);
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM cloud_resources
      WHERE tenant_id = $1 AND kind = $2 AND state NOT IN ('deleted', 'released')`,
    [tenantId, kind],
  );
  if (Number(live.rows[0]!.count) >= limit)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A tenant has at most ${limit} ${kind} resources that are not deleted`,
      undefined,
      { limit, kind },
    );
}

export const authzRow = (
  resourceId: string,
  input: { tenantId: string; poolId: string; kind: string; projectId?: string },
  admitted: { provider: ResourcesProvider; kind: ProviderResourceKind; region?: string },
  ownerId: string,
) => ({
  type: 'cloud-resource',
  id: resourceId,
  tenantId: input.tenantId,
  attributes: {
    kind: input.kind,
    family: admitted.kind.family,
    provider: admitted.provider.account.provider,
    providerAccountId: admitted.provider.account.id,
    poolId: input.poolId,
    ...(admitted.region !== undefined ? { region: admitted.region } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  },
  parentType: 'tenant',
  parentId: input.tenantId,
  ownerId,
});

/**
 * `cloudResources.create` transaction 1: the idempotency lookup, the pool, kind, spec, region and parent checks,
 * and the authz projection row the decision reads (`cloud-resource/<id>`, with the kind and family a policy can
 * narrow on). A key already used replays.
 */
export async function prepareCreate(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: CreateResourceInput,
  tx: SqlTx,
): Promise<AdmissionPlan<CloudResourceView>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const resourceId = await draftId('crs', input.tenantId, caller.identityId, input.idempotencyKey);
  const existing = await readResource(tx, { resourceId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== (await requestHash(input)))
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return { status: 'replay', result: resourceView(existing) };
  }
  // Refusals come before anything is staged, so a refused request leaves no projection row behind.
  const admitted = await admit(deps, tx, input);
  await assertNameFree(tx, input.tenantId, input.kind, input.name);
  await assertAllowance(deps, tx, input.tenantId, input.kind);
  await context.authz.upsert(tx, authzRow(resourceId, input, admitted, caller.identityId));
  return { status: 'decide', resource: { type: 'cloud-resource', id: resourceId } };
}

/** `cloudResources.create` refused or abandoned: the projection row staged for a resource never created goes. */
export async function clearStaged(
  context: MethodContext,
  input: { tenantId: string; idempotencyKey: string },
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const resourceId = await draftId(
    'crs',
    input.tenantId,
    context.caller.identityId,
    input.idempotencyKey,
  );
  if (!(await readResource(tx, { resourceId })))
    await context.authz.remove(tx, {
      type: 'cloud-resource',
      id: resourceId,
      tenantId: input.tenantId,
    });
}

/**
 * `cloudResources.create` (transaction 2): records the resource `pending` and wakes the reconciler. A retry with
 * the same key returns the resource; another request under the key is CONFLICT.
 */
export async function createResource(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: CreateResourceInput,
): Promise<CloudResourceView> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const resourceId = await draftId('crs', input.tenantId, caller.identityId, input.idempotencyKey);
  const hash = await requestHash(input);
  const existing = await readResource(tx, { resourceId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return resourceView(existing);
  }
  const admitted = await admit(deps, tx, input);
  await assertNameFree(tx, input.tenantId, input.kind, input.name);
  // Concurrent creates of one tenant count one after the other.
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtext('better-compute:cloud-resources:' || $1))`,
    [input.tenantId],
  );
  await assertAllowance(deps, tx, input.tenantId, input.kind);
  try {
    await tx.query(
      `INSERT INTO cloud_resources (id, tenant_id, project_id, pool_id, provider_account_id, provider, kind, family,
                                    name, description, region, parent_id, spec, provider_name, state, desired_state,
                                    created_by, idempotency_key, request_hash, version, identity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, 'pending', 'present', $15, $16,
               decode($17, 'hex'), 1, $18)`,
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
        admitted.region ?? null,
        admitted.parent?.id ?? null,
        JSON.stringify(admitted.spec),
        providerResourceName(resourceId),
        caller.identityId,
        input.idempotencyKey,
        hash,
        admitted.identity ?? null,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error)) {
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (constraint.includes('identity'))
        throw new ComputeError(
          'CONFLICT',
          `Another cloud resource already manages that ${input.kind} of ${input.parentId}`,
          undefined,
          { reason: 'identity', kind: input.kind },
        );
      if (constraint.includes('name'))
        throw new ComputeError('CONFLICT', `${input.kind} ${input.name} already exists`);
      throw new ComputeError(
        'CONFLICT',
        'This idempotency key is already being used by a concurrent request',
      );
    }
    throw error;
  }
  await deps.authz.upsert(tx, authzRow(resourceId, input, admitted, caller.identityId));
  await deps.work.enqueue(tx, resourcesWork, resourceId);
  await publish(
    deps,
    tx,
    { id: resourceId, tenant_id: input.tenantId, kind: input.kind },
    'created',
    {
      poolId: input.poolId,
      providerAccountId: admitted.provider.account.id,
      family: admitted.kind.family,
      name: input.name,
      ...(admitted.region !== undefined ? { region: admitted.region } : {}),
    },
  );
  return resourceViewOf(tx, resourceId);
}

export async function getResource(tx: SqlTx, ref: ResourceRef): Promise<CloudResourceView> {
  return resourceView(await requireResource(tx, ref));
}

export async function listResources(
  tx: SqlTx,
  input: ListResourcesInput,
): Promise<{ items: CloudResourceView[] }> {
  const { rows } = await tx.query<ResourceRow>(
    `SELECT ${resourceColumns} FROM cloud_resources
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4::text IS NULL OR kind = $4) AND ($5::text IS NULL OR family = $5)
        AND ($6 OR state NOT IN ('deleted', 'released'))
      ORDER BY created_at, id LIMIT 500`,
    [
      input.tenantId,
      input.poolId ?? null,
      input.projectId ?? null,
      input.kind ?? null,
      input.family ?? null,
      input.includeDeleted === true,
    ],
  );
  return { items: rows.map(resourceView) };
}

/** A resource accepting changes: locked, and neither being deleted, released nor gone. */
async function openResource(tx: SqlTx, ref: ResourceRef): Promise<ResourceRow> {
  const row = await requireResource(tx, ref, { lock: true });
  if (row.desired_state !== 'present' || ['deleting', 'deleted', 'released'].includes(row.state))
    throw new ComputeError(
      'INVALID_STATE',
      `Cloud resource ${row.id} is being deleted or released`,
    );
  return row;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * `cloudResources.update`: `spec` is merged onto the stored spec and validated by the kind's manifest; the kind's
 * `updatable` fields change in place (the resource goes `updating` until the reconciler has them), any other
 * change is refused (`INVALID_STATE`, `replaceRequired`): create a new resource instead. The description is ours.
 */
export async function updateResource(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  input: UpdateResourceInput,
): Promise<CloudResourceView> {
  const row = await openResource(tx, input);
  const stored = json(row.spec);
  let spec = stored;
  let identity = row.identity;
  if (input.spec !== undefined && row.adopted && row.ready_at === null)
    // Its spec is the provider's until the takeover reads it back: a change before that has nothing to apply to.
    throw new ComputeError(
      'INVALID_STATE',
      `Cloud resource ${row.id} is still being adopted; change its spec once it is ready`,
      undefined,
      { reason: 'adopting' },
    );
  if (input.spec !== undefined) {
    const provider = await poolResources(deps, tx, row.tenant_id, row.pool_id).catch(
      async (error) => {
        // The pool may have stopped being offered: the account the resource lives on still decides the kind.
        if (code(error) !== 'NOT_FOUND') throw error;
        throw new ComputeError(
          'INVALID_STATE',
          `Pool ${row.pool_id} is no longer available to this tenant`,
        );
      },
    );
    const kind = kindOf(provider, row.kind);
    spec = await validSpec(kind, { ...stored, ...input.spec });
    assertAccountScope(provider, row.tenant_id, kind, spec);
    await assertInstances(tx, row.tenant_id, row.provider_account_id, kind, spec, stored);
    const changed = [...new Set([...Object.keys(stored), ...Object.keys(spec)])].filter(
      (field) => !same(stored[field], spec[field]),
    );
    const fixed = changed.filter((field) => !kind.updatable.includes(field));
    if (fixed.length > 0)
      throw new ComputeError(
        'INVALID_STATE',
        `${row.kind} cannot change ${fixed.join(', ')} in place; create a new resource instead`,
        undefined,
        { reason: 'replaceRequired', fields: fixed, updatable: [...kind.updatable] },
      );
    if (row.parent_id !== null) {
      identity = identityOf(kind, spec) ?? null;
      if (identity !== null && identity !== row.identity)
        await assertIdentityFree(tx, row.parent_id, row.kind, identity, row.id);
    }
  }
  const providerChange = !same(stored, spec);
  await tx.query(
    `UPDATE cloud_resources
        SET spec = $2::jsonb, description = $3, version = version + 1, updated_at = compute_now(),
            state = CASE WHEN $4 AND state IN ('ready', 'error') THEN 'updating' ELSE state END,
            message = CASE WHEN $4 AND state IN ('ready', 'error') THEN NULL ELSE message END,
            spec_changed = spec_changed OR $4, identity = $5
      WHERE id = $1`,
    [
      row.id,
      JSON.stringify(spec),
      input.description !== undefined ? input.description : row.description,
      providerChange,
      identity,
    ],
  );
  if (providerChange) {
    await deps.work.enqueue(tx, resourcesWork, row.id);
    await publish(deps, tx, row, 'updating', {
      fields: Object.keys(spec).filter((field) => !same(stored[field], spec[field])),
    });
  }
  return resourceViewOf(tx, row.id);
}

/**
 * `cloudResources.delete`: the resource (and every resource living in it) is marked for deletion and the reconciler
 * deletes it at the provider, children first. Idempotent.
 */
export async function deleteResource(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  ref: ResourceRef,
): Promise<CloudResourceView> {
  const row = await requireResource(tx, ref, { lock: true });
  if (row.desired_state !== 'present' || row.state === 'deleted' || row.state === 'released')
    return resourceView(row);
  await markDeleted(deps, tx, row, 'requested');
  return resourceViewOf(tx, row.id);
}

/** Marks a resource and its live descendants for deletion and wakes the reconciler for each. */
export async function markDeleted(
  deps: CloudResourcesDeps,
  tx: SqlTx,
  row: Pick<ResourceRow, 'id' | 'tenant_id' | 'kind'>,
  reason: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string; tenant_id: string; kind: string }>(
    `WITH RECURSIVE tree AS (
       SELECT id FROM cloud_resources WHERE id = $1
       UNION SELECT c.id FROM cloud_resources c JOIN tree t ON c.parent_id = t.id
     )
     UPDATE cloud_resources r
        SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1,
            updated_at = compute_now()
       FROM tree
      WHERE r.id = tree.id AND r.desired_state = 'present' AND r.state NOT IN ('deleted', 'released')
      RETURNING r.id, r.tenant_id, r.kind`,
    [row.id],
  );
  for (const marked of rows) {
    await deps.work.enqueue(tx, resourcesWork, marked.id);
    await publish(deps, tx, marked, 'deleting', {
      reason: marked.id === row.id ? reason : 'parent-deleted',
    });
  }
}
