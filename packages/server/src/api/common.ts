import {
  ComputeError,
  draftId,
  idPrefixes,
  type AdmissionContext,
  type Caller,
  type MethodContext,
} from '@better-compute/core';
import { v } from './input.js';

// Pieces every server API group shares: input fields, id patterns, derived (idempotent) ids,
// pagination, row conversions and the projection-backed visibility predicate.

/** A page of a list; `cursor` is present when more rows may follow. */
export interface Page<T> {
  items: T[];
  cursor?: string;
}

const body = '[0-9a-hjkmnp-tv-z]{26,52}';

/** Ids the server mints or JoinService assigns: `<prefix>_<ulid or 52-character digest>`. */
export const idPattern = (prefix: string) => new RegExp(`^${prefix}_${body}$`);

export const patterns = {
  tenantId: /^[A-Za-z0-9._:-]{1,128}$/,
  idempotencyKey: /^[A-Za-z0-9._~:/+=-]{1,128}$/,
  /** Pools are the capacity module's; their ids are opaque to the server. */
  poolId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  project: idPattern(idPrefixes.project),
  site: idPattern(idPrefixes.site),
  node: idPattern(idPrefixes.node),
  command: idPattern(idPrefixes.command),
  joinToken: idPattern(idPrefixes.joinToken),
  /** A region label in better-iam's region-name grammar (`eu-west-1`). */
  region: /^[a-z][a-z0-9-]{0,62}$/,
} as const;

export const fields = {
  tenantId: v.string({ pattern: patterns.tenantId, max: 128 }),
  idempotencyKey: v.string({ pattern: patterns.idempotencyKey, max: 128 }),
  poolId: v.string({ pattern: patterns.poolId, max: 128 }),
  projectId: v.string({ pattern: patterns.project, max: 64 }),
  siteId: v.string({ pattern: patterns.site, max: 64 }),
  nodeId: v.string({ pattern: patterns.node, max: 64 }),
  commandId: v.string({ pattern: patterns.command, max: 64 }),
  joinTokenId: v.string({ pattern: patterns.joinToken, max: 64 }),
  version: v.int({ min: 1 }),
  cursor: v.string({ pattern: /^[A-Za-z0-9._:-]{1,256}$/, max: 256 }),
  /** A short free-text reason recorded with events. */
  reason: v.string({ pattern: /^[^\u0000-\u001f\u007f]*$/, max: 256 }),
};

/** An optional page size: at most `max`, `fallback` (default `max`) when absent. */
export const limit = (max: number, fallback = max) =>
  v.withDefault(v.int({ min: 1, max }), fallback);

/** The authenticated caller; every non-public method has one. */
export function callerOf(context: MethodContext): Caller {
  if (!context.caller) throw new ComputeError('INVALID_STATE', 'This method needs a caller');
  return context.caller;
}

/** The recorded decision; every allowed mutation has one. */
export function admittedOf(context: MethodContext): AdmissionContext {
  if (!context.admission)
    throw new ComputeError('INVALID_STATE', 'This mutation runs only after its decision');
  return context.admission;
}

/**
 * The id a create derives from `(tenant, caller identity, idempotency key)` (PLAN.md §3.4 step 4):
 * a retry finds its own row, and the same key from another identity names another row.
 */
export function derivedId<P extends string>(
  prefix: P,
  tenantId: string,
  context: MethodContext,
  idempotencyKey: string,
): Promise<`${P}_${string}`> {
  return draftId(prefix, tenantId, callerOf(context).identityId, idempotencyKey);
}

/** The refusal of a key reused for a different request: no body, nothing about the first one. */
export const keyReused = () =>
  new ComputeError('CONFLICT', 'The idempotency key was already used for a different request');

/** Epoch milliseconds of a `timestamptz` (drivers return `Date`), or `undefined` for NULL. */
export function ms(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : undefined;
}

/** A `bigint` column (strings from node-postgres, numbers from PGlite) as a number. */
export const int = (value: unknown): number => Number(value);

/**
 * Rows `limit + 1` long become a page of `limit` items and a cursor at the last one. The extra row
 * only says that more follow.
 */
export function page<R, T>(
  rows: readonly R[],
  size: number,
  convert: (row: R) => T,
  cursorOf: (row: R) => string,
): Page<T> {
  const items = rows.slice(0, size);
  const result: Page<T> = { items: items.map(convert) };
  if (rows.length > size && items.length) result.cursor = cursorOf(items[items.length - 1]!);
  return result;
}

/**
 * SQL that holds when the projection has `(type, id)` in the tenant `$tenantParam`: the rows the
 * resolver can answer for, which is what a tenant can see (§12.4). `type` is a literal kind.
 */
export function visibleIn(
  type: 'project' | 'site' | 'node',
  idColumn: string,
  tenantParam: string,
) {
  return `EXISTS (SELECT 1 FROM authz_projection ap
    WHERE ap.type = '${type}' AND ap.id = ${idColumn} AND ap.tenant_id = ${tenantParam})`;
}

export const notFound = (what: string) => new ComputeError('NOT_FOUND', `${what} not found`);
