import {
  ComputeError,
  isComputeError,
  type AuthzWriter,
  type Json,
  type Profile,
  type ProfileDocument,
  type SqlTx,
} from '@better-compute/core';
import type { ProfileSource } from './engine.js';
import { defineProfile } from './profile.js';

// Stored profiles (PLAN.md §11.4): versioned per tenant, immutable once a workflow used them.
// Profiles that modules ship are read-only and visible to every tenant.

interface ProfileRow {
  tenant_id: string;
  id: string;
  profile_version: number;
  document: ProfileDocument;
  visibility: 'private' | 'public';
  used_at: Date | null;
  version: number;
}

/** The tenant that owns the profiles modules ship (`profiles.list` shows them as read-only). */
export const builtinProfileTenant = 'builtin';

function toProfile(row: ProfileRow): Profile {
  const profile: Profile = {
    id: row.id,
    tenantId: row.tenant_id,
    document: row.document,
    visibility: row.visibility,
    version: Number(row.version),
  };
  if (row.used_at) profile.usedAt = row.used_at.getTime();
  return profile;
}

function moduleProfile(document: ProfileDocument): Profile {
  return { id: document.id, tenantId: builtinProfileTenant, document, visibility: 'public', version: 1 };
}

/** A source over stored profiles (the tenant's own, then public ones) and the given module profiles. */
export function profileSource(moduleProfiles: readonly ProfileDocument[]): ProfileSource & {
  find(tx: SqlTx, tenantId: string, id: string, version?: number): Promise<Profile | undefined>;
  list(tx: SqlTx, tenantId: string, page: { limit: number; after?: string }): Promise<{ items: Profile[]; cursor?: string }>;
} {
  const shipped = new Map(moduleProfiles.map((p) => [`${p.id}@${p.version}`, p]));
  async function find(tx: SqlTx, tenantId: string, id: string, version?: number): Promise<Profile | undefined> {
    const { rows } = await tx.query<ProfileRow>(
      `SELECT tenant_id, id, profile_version, document, visibility, used_at, version FROM profiles
        WHERE id = $1 AND ($2::int IS NULL OR profile_version = $2) AND deleted_at IS NULL
          AND (tenant_id = $3 OR visibility = 'public')
        ORDER BY (tenant_id = $3) DESC, profile_version DESC LIMIT 1`,
      [id, version ?? null, tenantId],
    );
    if (rows[0]) return toProfile(rows[0]);
    const candidates = [...shipped.values()].filter((p) => p.id === id && (version === undefined || p.version === version));
    const latest = candidates.sort((a, b) => b.version - a.version)[0];
    return latest ? moduleProfile(latest) : undefined;
  }
  return {
    async get(tx, tenantId, id, version) {
      return (await find(tx, tenantId, id, version))?.document;
    },
    find,
    async list(tx, tenantId, page) {
      const { rows } = await tx.query<ProfileRow>(
        `SELECT tenant_id, id, profile_version, document, visibility, used_at, version FROM profiles
          WHERE deleted_at IS NULL AND (tenant_id = $1 OR visibility = 'public')
            AND ($2::text IS NULL OR (id || '@' || lpad(profile_version::text, 10, '0')) > $2)
          ORDER BY id, profile_version LIMIT $3`,
        [tenantId, page.after ?? null, page.limit + 1],
      );
      const stored = rows.map(toProfile);
      const key = (p: Profile) => `${p.id}@${String(p.document.version).padStart(10, '0')}`;
      const builtins = [...shipped.values()]
        .map(moduleProfile)
        .filter((p) => page.after === undefined || key(p) > page.after);
      const merged = [...stored, ...builtins].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      const items = merged.slice(0, page.limit);
      return merged.length > page.limit ? { items, cursor: key(items.at(-1)!) } : { items };
    },
  };
}

function checked(document: unknown): ProfileDocument {
  try {
    return defineProfile(document as ProfileDocument);
  } catch (error) {
    // A caller's document is input, not configuration.
    if (isComputeError(error, 'INVALID_CONFIG'))
      throw new ComputeError('INVALID_INPUT', error.message, undefined, error.details as Record<string, unknown>);
    throw error;
  }
}

async function project(authz: AuthzWriter | undefined, tx: SqlTx, tenantId: string, document: ProfileDocument, visibility: string) {
  await authz?.upsert(tx, {
    type: 'profile',
    id: document.id,
    tenantId,
    attributes: { target: document.target, version: document.version, visibility },
  });
}

/** `profiles.create`: stores a new profile version. `CONFLICT` if that version exists. */
export async function createProfile(
  tx: SqlTx,
  authz: AuthzWriter | undefined,
  tenantId: string,
  input: { document: unknown; visibility?: 'private' | 'public' },
): Promise<Profile> {
  const document = checked(input.document);
  const visibility = input.visibility ?? 'private';
  const inserted = await tx.query<ProfileRow>(
    `INSERT INTO profiles (tenant_id, id, profile_version, target, document, visibility)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT DO NOTHING
     RETURNING tenant_id, id, profile_version, document, visibility, used_at, version`,
    [tenantId, document.id, document.version, document.target, JSON.stringify(document), visibility],
  );
  if (!inserted.rows[0])
    throw new ComputeError('CONFLICT', `Profile ${document.id}@${document.version} already exists; create version ${document.version + 1}`);
  await project(authz, tx, tenantId, document, visibility);
  return toProfile(inserted.rows[0]);
}

async function lockOwn(tx: SqlTx, tenantId: string, id: string, version: number): Promise<ProfileRow> {
  const { rows } = await tx.query<ProfileRow>(
    `SELECT tenant_id, id, profile_version, document, visibility, used_at, version FROM profiles
      WHERE tenant_id = $1 AND id = $2 AND profile_version = $3 AND deleted_at IS NULL FOR UPDATE`,
    [tenantId, id, version],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Profile ${id}@${version} does not exist`);
  return rows[0];
}

/**
 * `profiles.update`: replaces an unused version's document (same id and version) or visibility.
 * A version a workflow used is immutable: `INVALID_STATE`, create the next version instead.
 * `expectedVersion` (the row version) guards against lost updates: `CONFLICT`.
 */
export async function updateProfile(
  tx: SqlTx,
  authz: AuthzWriter | undefined,
  tenantId: string,
  input: { profileId: string; profileVersion: number; document?: unknown; visibility?: 'private' | 'public'; expectedVersion?: number },
): Promise<Profile> {
  const row = await lockOwn(tx, tenantId, input.profileId, input.profileVersion);
  if (input.expectedVersion !== undefined && Number(row.version) !== input.expectedVersion)
    throw new ComputeError('CONFLICT', `Profile ${input.profileId}@${input.profileVersion} changed (version ${row.version})`);
  let document = row.document;
  if (input.document !== undefined) {
    if (row.used_at)
      throw new ComputeError(
        'INVALID_STATE',
        `Profile ${input.profileId}@${input.profileVersion} is in use and immutable; create version ${input.profileVersion + 1}`,
      );
    document = checked(input.document);
    if (document.id !== input.profileId || document.version !== input.profileVersion)
      throw new ComputeError('INVALID_INPUT', 'An update keeps the profile id and version');
  }
  const visibility = input.visibility ?? row.visibility;
  const { rows } = await tx.query<ProfileRow>(
    `UPDATE profiles SET document = $4::jsonb, target = $5, visibility = $6, version = version + 1
      WHERE tenant_id = $1 AND id = $2 AND profile_version = $3
      RETURNING tenant_id, id, profile_version, document, visibility, used_at, version`,
    [tenantId, input.profileId, input.profileVersion, JSON.stringify(document), document.target, visibility],
  );
  await project(authz, tx, tenantId, document, visibility);
  return toProfile(rows[0]!);
}

/**
 * `profiles.delete`: hides a version (or every version) from new workflows. Workflows already
 * running keep their expanded steps. Deleting the last version removes the authz row.
 */
export async function deleteProfile(
  tx: SqlTx,
  authz: AuthzWriter | undefined,
  tenantId: string,
  input: { profileId: string; profileVersion?: number },
): Promise<{ deleted: number }> {
  const result = await tx.query(
    `UPDATE profiles SET deleted_at = compute_now(), version = version + 1
      WHERE tenant_id = $1 AND id = $2 AND ($3::int IS NULL OR profile_version = $3) AND deleted_at IS NULL`,
    [tenantId, input.profileId, input.profileVersion ?? null],
  );
  if (result.rowCount === 0)
    throw new ComputeError('NOT_FOUND', `Profile ${input.profileId}${input.profileVersion ? `@${input.profileVersion}` : ''} does not exist`);
  const left = await tx.query('SELECT 1 FROM profiles WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tenantId, input.profileId]);
  if (left.rowCount === 0) await authz?.remove(tx, { type: 'profile', id: input.profileId, tenantId });
  return { deleted: result.rowCount };
}

export type { Json };
