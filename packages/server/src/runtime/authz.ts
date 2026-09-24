import {
  ComputeError,
  type AuthzAttributes,
  type AuthzRow,
  type AuthzWriter,
  type SqlTx,
} from '@better-compute/core';

// The authz projection (PLAN.md §12.4): one `authz_projection` row per (type, id, tenant in whose
// view it exists), written in the transaction of the domain change, plus one `authz_changes` row
// per actual change so memory-resident resolvers can tail the feed with the outbox's xmin cursor.
// `type` is the unprefixed kind (`pool`, `reservation`, …); the IAM bridge adds the prefix.

const maxAttributes = 64;
const maxText = 256;

/** Inserts or updates the row; only a real change is written and fed. */
const upsertRow = `WITH changed AS (
    INSERT INTO authz_projection AS p (type, id, tenant_id, attributes, parent_type, parent_id, owner_id)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
    ON CONFLICT (type, id, tenant_id) DO UPDATE SET attributes = EXCLUDED.attributes,
      parent_type = EXCLUDED.parent_type, parent_id = EXCLUDED.parent_id, owner_id = EXCLUDED.owner_id
    WHERE p.attributes IS DISTINCT FROM EXCLUDED.attributes
       OR p.parent_type IS DISTINCT FROM EXCLUDED.parent_type
       OR p.parent_id IS DISTINCT FROM EXCLUDED.parent_id
       OR p.owner_id IS DISTINCT FROM EXCLUDED.owner_id
    RETURNING p.type, p.id, p.tenant_id)
  INSERT INTO authz_changes (type, id, tenant_id, op) SELECT type, id, tenant_id, 'upsert' FROM changed`;

const removeRows = `WITH gone AS (
    DELETE FROM authz_projection
     WHERE type = $1 AND id = $2 AND ($3::text IS NULL OR tenant_id = $3)
    RETURNING type, id, tenant_id)
  INSERT INTO authz_changes (type, id, tenant_id, op) SELECT type, id, tenant_id, 'delete' FROM gone`;

const setPendingRow = `WITH changed AS (
    UPDATE authz_projection SET pending = $4::jsonb
     WHERE type = $1 AND id = $2 AND tenant_id = $3
    RETURNING type, id, tenant_id)
  INSERT INTO authz_changes (type, id, tenant_id, op) SELECT type, id, tenant_id, 'upsert' FROM changed`;

const rowExists = 'SELECT 1 FROM authz_projection WHERE type = $1 AND id = $2 AND tenant_id = $3';

function checkText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxText)
    throw new ComputeError('INVALID_INPUT', `An authz row's ${name} is a non-empty string`);
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  checkText(value, name);
  return value;
}

/** Attribute values IAM can read: strings, finite numbers and booleans, at most 64 of them. */
function checkAttributes(value: unknown, name: string): AuthzAttributes {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComputeError('INVALID_INPUT', `${name} is an object of attributes`);
  const entries = Object.entries(value);
  if (entries.length > maxAttributes)
    throw new ComputeError('INVALID_INPUT', `${name} has at most ${maxAttributes} attributes`);
  const out: AuthzAttributes = {};
  for (const [key, item] of entries) {
    if (
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      out[key] = item;
    else
      throw new ComputeError(
        'INVALID_INPUT',
        `${name}.${key} must be a string, a finite number or a boolean`,
      );
  }
  return out;
}

/** `ctx.authz`: writes in the caller's transaction. */
export const authzWriter: AuthzWriter = Object.freeze({
  async upsert(tx: SqlTx, row: AuthzRow) {
    if (!row || typeof row !== 'object')
      throw new ComputeError('INVALID_INPUT', 'upsert() takes an authz row');
    checkText(row.type, 'type');
    checkText(row.id, 'id');
    checkText(row.tenantId, 'tenantId');
    const attributes = checkAttributes(row.attributes, 'attributes');
    await tx.query(upsertRow, [
      row.type,
      row.id,
      row.tenantId,
      JSON.stringify(attributes),
      optionalText(row.parentType, 'parentType'),
      optionalText(row.parentId, 'parentId'),
      optionalText(row.ownerId, 'ownerId'),
    ]);
  },
  async remove(tx: SqlTx, ref: { type: string; id: string; tenantId?: string }) {
    if (!ref || typeof ref !== 'object')
      throw new ComputeError('INVALID_INPUT', 'remove() takes { type, id, tenantId? }');
    checkText(ref.type, 'type');
    checkText(ref.id, 'id');
    await tx.query(removeRows, [ref.type, ref.id, optionalText(ref.tenantId, 'tenantId')]);
  },
  async setPending(
    tx: SqlTx,
    ref: { type: string; id: string; tenantId: string },
    pending: AuthzAttributes | null,
  ) {
    if (!ref || typeof ref !== 'object')
      throw new ComputeError('INVALID_INPUT', 'setPending() takes { type, id, tenantId }');
    checkText(ref.type, 'type');
    checkText(ref.id, 'id');
    checkText(ref.tenantId, 'tenantId');
    const value = pending === null ? null : JSON.stringify(checkAttributes(pending, 'pending'));
    const { rowCount } = await tx.query(setPendingRow, [ref.type, ref.id, ref.tenantId, value]);
    if (rowCount) return;
    const exists = await tx.query(rowExists, [ref.type, ref.id, ref.tenantId]);
    if (!exists.rowCount)
      throw new ComputeError('NOT_FOUND', `No authz row for ${ref.type}/${ref.id} in that tenant`);
  },
});

/** One `authz_projection` row as the resolver reads it. */
export interface StoredAuthzRow extends AuthzRow {
  /** In-flight `extend` values the resolver reports instead of the stored ones. */
  pending?: AuthzAttributes;
}

interface ProjectionDbRow {
  type: string;
  id: string;
  tenant_id: string;
  attributes: unknown;
  parent_type: string | null;
  parent_id: string | null;
  owner_id: string | null;
  pending: unknown;
}

const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

function attributesOf(value: unknown): AuthzAttributes {
  const parsed = json(value);
  const out: AuthzAttributes = {};
  if (parsed && typeof parsed === 'object')
    for (const [name, item] of Object.entries(parsed as Record<string, unknown>))
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
        out[name] = item;
  return out;
}

/**
 * Reads one row by primary key. `type` may carry the IAM prefix (`compute-pool`), which is
 * stripped: rows store the unprefixed kind.
 */
export async function readAuthzRow(
  sql: SqlTx,
  typePrefix: string,
  type: string,
  id: string,
  tenantId: string,
): Promise<StoredAuthzRow | undefined> {
  const kind = type.startsWith(typePrefix) ? type.slice(typePrefix.length) : type;
  const { rows } = await sql.query<ProjectionDbRow>(
    `SELECT type, id, tenant_id, attributes, parent_type, parent_id, owner_id, pending
       FROM authz_projection WHERE type = $1 AND id = $2 AND tenant_id = $3`,
    [kind, id, tenantId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const out: StoredAuthzRow = {
    type: row.type,
    id: row.id,
    tenantId: row.tenant_id,
    attributes: attributesOf(row.attributes),
  };
  if (row.parent_type !== null) out.parentType = row.parent_type;
  if (row.parent_id !== null) out.parentId = row.parent_id;
  if (row.owner_id !== null) out.ownerId = row.owner_id;
  if (row.pending !== null && row.pending !== undefined) out.pending = attributesOf(row.pending);
  return out;
}
