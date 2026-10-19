import { ComputeError, type Instance, type MethodContext, type SqlTx } from '@better-compute/core';
import {
  assertPlatformProvenance,
  displayName,
  instanceLabels,
  instanceMetadata,
  issuedBy,
} from './instance-identity.js';
import {
  instanceView,
  platformCaller,
  publishInstance,
  readInstance,
  sameLabels,
  updateInstance,
  wake,
  type InstanceDeps,
  type InstanceRow,
} from './instances.js';
import { fail, id, int, object, optional, tenant } from './input.js';

// (U-04) `instances.update`: a tenant renames an instance and replaces its metadata and labels; the platform
// records or corrects its provenance (`issuedBy`). Nothing about the machine itself changes: in a provider pool,
// new labels are written on the machine and its boot disk by the `vps.instances` reconciler (`setLabels`).

export interface UpdateInstanceInput {
  tenantId: string;
  instanceId: string;
  /** The new display name; null clears it. */
  name?: string | null;
  /** The new metadata, replacing the old; null (or `{}`) clears it. */
  metadata?: Record<string, string> | null;
  /** The new labels, replacing the old; null (or `{}`) clears them. */
  labels?: Record<string, string> | null;
  /** The platform's provenance (root callers only); null clears it. */
  issuedBy?: string | null;
  /** The instance's `version` the caller read: CONFLICT when it has moved on. */
  expectedVersion?: number;
}

const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
  value === null ? null : parse(value);

/** Empty maps clear, as null does. */
const orNull = (value: Record<string, string> | null): Record<string, string> | null =>
  value === null || Object.keys(value).length === 0 ? null : value;

export function parseUpdateInstance(raw: unknown): UpdateInstanceInput {
  const input = object(raw, [
    'tenantId',
    'instanceId',
    'name',
    'metadata',
    'labels',
    'issuedBy',
    'expectedVersion',
  ]);
  const result: UpdateInstanceInput = {
    tenantId: tenant(input.tenantId),
    instanceId: id(input.instanceId, 'inst', 'instanceId'),
  };
  if (input.name !== undefined) result.name = nullable(input.name, (value) => displayName(value));
  if (input.metadata !== undefined)
    result.metadata = orNull(nullable(input.metadata, (value) => instanceMetadata(value)));
  if (input.labels !== undefined)
    result.labels = orNull(nullable(input.labels, (value) => instanceLabels(value)));
  if (input.issuedBy !== undefined)
    result.issuedBy = nullable(input.issuedBy, (value) => issuedBy(value));
  const expected = optional(input.expectedVersion, (value) =>
    int(value, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER),
  );
  if (expected !== undefined) result.expectedVersion = expected;
  if (
    result.name === undefined &&
    result.metadata === undefined &&
    result.labels === undefined &&
    result.issuedBy === undefined
  )
    fail('Give at least one of name, metadata, labels or issuedBy');
  return result;
}

/** Which of the identity fields the update changes, in a fixed order. */
function changes(row: InstanceRow, input: UpdateInstanceInput): string[] {
  const changed: string[] = [];
  if (input.name !== undefined && (input.name ?? undefined) !== row.name) changed.push('name');
  if (input.metadata !== undefined && !sameLabels(input.metadata ?? undefined, row.metadata))
    changed.push('metadata');
  if (input.labels !== undefined && !sameLabels(input.labels ?? undefined, row.labels))
    changed.push('labels');
  if (input.issuedBy !== undefined && (input.issuedBy ?? undefined) !== row.issuedBy)
    changed.push('issuedBy');
  return changed;
}

/**
 * `instances.update`. Sandboxes' and warm instances follow their sandbox (`sandboxes.update`): INVALID_STATE.
 * A deleted instance keeps what it had: INVALID_STATE. An update that changes nothing returns the instance as
 * it is, without a new version or event.
 */
export async function updateInstanceIdentity(
  deps: Pick<InstanceDeps, 'events' | 'work' | 'desired' | 'rootTenantId'>,
  context: Pick<MethodContext, 'caller'>,
  tx: SqlTx,
  input: UpdateInstanceInput,
): Promise<Instance> {
  // The platform alone records provenance, before anything is read.
  if (input.issuedBy !== undefined) {
    const caller = context.caller;
    if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
    assertPlatformProvenance(platformCaller(caller, input.tenantId, deps.rootTenantId));
  }
  const row = await readInstance(tx, input.instanceId, { tenantId: input.tenantId, lock: true });
  if (!row || row.draft)
    throw new ComputeError('NOT_FOUND', `Instance ${input.instanceId} not found`);
  if (row.sandboxId !== undefined)
    throw new ComputeError(
      'INVALID_STATE',
      `Instance ${row.id} is managed by sandbox ${row.sandboxId}; use sandboxes.update`,
    );
  if (row.warmTemplateId !== undefined)
    throw new ComputeError(
      'INVALID_STATE',
      `Instance ${row.id} is a warm instance of sandbox template ${row.warmTemplateId}`,
    );
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version)
    throw new ComputeError(
      'CONFLICT',
      `Instance ${row.id} is at version ${row.version}, not ${input.expectedVersion}`,
      undefined,
      { version: row.version },
    );
  if (row.state === 'deleted' || row.desiredState === 'deleted')
    throw new ComputeError('INVALID_STATE', `Instance ${row.id} is being deleted`);
  const changed = changes(row, input);
  if (changed.length === 0) return instanceView(row);
  const next = await updateInstance(tx, row, {
    ...(changed.includes('name') ? { name: input.name ?? null } : {}),
    ...(changed.includes('metadata') ? { metadata: input.metadata ?? null } : {}),
    ...(changed.includes('labels') ? { labels: input.labels ?? null } : {}),
    ...(changed.includes('issuedBy') ? { issuedBy: input.issuedBy ?? null } : {}),
  });
  await publishInstance(deps, tx, next, 'instance.updated', { changed });
  // New labels of a provider machine: the reconciler writes them.
  if (next.labelsPending) await wake(deps, tx, next);
  return instanceView(next);
}
