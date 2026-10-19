import {
  ComputeError,
  instanceStateTable,
  type Instance,
  type InstanceState,
  type SqlTx,
} from '@better-compute/core';
import { issuedBy, labelSelectorSql, parseLabelSelector } from './instance-identity.js';
import { listedInstances } from './instances.js';
import { fail, id, int, object, optional, tenant } from './input.js';

// (U-04) `instances.issued`: the platform's view of the instances it issued, across tenants. An issued instance is
// one in a tenant other than the IAM root tenant, on a pool the root tenant owns (created there, or attached into
// it), whoever made it; `issuedBy` narrows that to what the platform recorded as its own. Root only: decided as
// `compute:instances:read` on the fleet, which resolves in the root tenant alone.

export interface IssuedInstancesInput {
  /** Only this tenant's instances. */
  tenantId?: string;
  poolId?: string;
  /** Only instances in this state; without it, deleted instances are left out. */
  state?: InstanceState;
  /** Only instances whose `issuedBy` is this; `*` for any recorded provenance. */
  issuedBy?: string;
  /** A label selector, as `instances.list` takes it. */
  labelSelector?: string;
  /** 1 to 500 (default 100). */
  limit?: number;
  cursor?: string;
}

export function parseIssuedInstances(raw: unknown): IssuedInstancesInput {
  const input = object(raw ?? {}, [
    'tenantId',
    'poolId',
    'state',
    'issuedBy',
    'labelSelector',
    'limit',
    'cursor',
  ]);
  const result: IssuedInstancesInput = {};
  const tenantId = optional(input.tenantId, (value) => tenant(value));
  if (tenantId !== undefined) result.tenantId = tenantId;
  const poolId = optional(input.poolId, (value) => id(value, 'pool', 'poolId'));
  if (poolId !== undefined) result.poolId = poolId;
  if (input.state !== undefined) {
    if (!(instanceStateTable.states as readonly unknown[]).includes(input.state))
      fail('state is invalid');
    result.state = input.state as InstanceState;
  }
  if (input.issuedBy !== undefined)
    result.issuedBy = input.issuedBy === '*' ? '*' : issuedBy(input.issuedBy);
  if (input.labelSelector !== undefined) {
    parseLabelSelector(input.labelSelector);
    if ((input.labelSelector as string).trim() !== '')
      result.labelSelector = input.labelSelector as string;
  }
  const limit = optional(input.limit, (value) => int(value, 'limit', 1, 500));
  if (limit !== undefined) result.limit = limit;
  const cursor = optional(input.cursor, (value) => {
    if (typeof value !== 'string' || !/^inst_[0-9a-z]{26,52}$/.test(value))
      fail('cursor is invalid');
    return value;
  });
  if (cursor !== undefined) result.cursor = cursor;
  return result;
}

/** The platform's issued instances, newest first, with a `cursor` when more remain. */
export async function listIssuedInstances(
  tx: SqlTx,
  input: IssuedInstancesInput,
  rootTenantId: string | undefined,
): Promise<{ items: Instance[]; cursor?: string }> {
  if (rootTenantId === undefined)
    throw new ComputeError(
      'INVALID_CONFIG',
      'instances.issued needs the IAM root tenant (IamPort.rootTenantId)',
    );
  const limit = input.limit ?? 100;
  const params: unknown[] = [
    rootTenantId,
    input.tenantId ?? null,
    input.poolId ?? null,
    input.state ?? null,
    input.issuedBy ?? null,
    input.cursor ?? null,
  ];
  const selector = labelSelectorSql(
    input.labelSelector !== undefined ? parseLabelSelector(input.labelSelector) : [],
    'i.labels',
    params,
  );
  return listedInstances(
    tx,
    `p.owner_tenant_id = $1 AND i.tenant_id <> $1 AND NOT i.draft AND i.warm_template_id IS NULL
        AND ($2::text IS NULL OR i.tenant_id = $2) AND ($3::text IS NULL OR i.pool_id = $3)
        AND (CASE WHEN $4::text IS NULL THEN i.state <> 'deleted' ELSE i.state = $4 END)
        AND (CASE WHEN $5::text IS NULL THEN true WHEN $5 = '*' THEN i.issued_by IS NOT NULL
                  ELSE i.issued_by = $5 END)
        AND (${selector})
        AND ($6::text IS NULL OR (i.created_at, i.id) <
             (SELECT created_at, id FROM instances WHERE id = $6))`,
    params,
    limit,
  );
}
