import {
  ComputeError,
  defineMethod,
  type MethodContext,
  type MethodDefinition,
  type Site,
  type SiteKind,
} from '@better-compute/core';
import { siteBootLeaseName } from '../controllers/site-boot.js';
import { fields, int, notFound, patterns } from './common.js';
import { parser, v } from './input.js';
import { siteAttributes } from './sites.js';

// `sites.update` and `sites.delete` (PLAN.md §9.2, module server, v0.2), decided on
// `compute-site/{siteId}` with `compute:sites:manage`, by the site's owner. A deleted site leaves the
// projection, so nobody sees it. Its tokens are revoked, its open join requests expire and its boot
// lease is dropped. The row is removed when nothing ever referenced it, and tombstoned otherwise.

export interface UpdateSiteInput {
  tenantId: string;
  siteId: string;
  region?: string;
  iamRegion?: string;
  /** Removes `iamRegion` (then IAM uses `region`). */
  clearIamRegion?: boolean;
  /** The version read; a mismatch is `CONFLICT`. */
  version?: number;
}
export interface DeleteSiteInput {
  tenantId: string;
  siteId: string;
  version?: number;
}
export interface DeletedSite {
  siteId: string;
  /** False when the site was already deleted (a retry). */
  deleted: boolean;
  /** True when rows still reference the site, so it was tombstoned rather than removed. */
  tombstoned: boolean;
}

export type SitesManageApi = {
  sites: {
    update: MethodDefinition<UpdateSiteInput, Site>;
    delete: MethodDefinition<DeleteSiteInput, DeletedSite>;
  };
};

const region = v.string({ pattern: patterns.region, max: 63 });
const parseUpdate = parser({
  tenantId: fields.tenantId,
  siteId: fields.siteId,
  region: v.optional(region),
  iamRegion: v.optional(region),
  clearIamRegion: v.withDefault(v.boolean(), false),
  version: v.optional(fields.version),
});
function updateInput(input: unknown): UpdateSiteInput {
  const parsed = parseUpdate(input);
  if (parsed.iamRegion !== undefined && parsed.clearIamRegion)
    throw new ComputeError('INVALID_INPUT', 'iamRegion: set it or clear it, not both');
  if (parsed.region === undefined && parsed.iamRegion === undefined && !parsed.clearIamRegion)
    throw new ComputeError('INVALID_INPUT', 'Name at least one change (region, iamRegion, clearIamRegion)');
  return parsed;
}
const deleteInput: (input: unknown) => DeleteSiteInput = parser({
  tenantId: fields.tenantId,
  siteId: fields.siteId,
  version: v.optional(fields.version),
});

interface SiteRow {
  id: string;
  owner_tenant_id: string;
  kind: SiteKind;
  region: string;
  iam_region: string | null;
  version: unknown;
  deleted_at: Date | null;
}
const columns = 's.id, s.owner_tenant_id, s.kind, s.region, s.iam_region, s.version, s.deleted_at';

function toSite(row: SiteRow): Site {
  const site: Site = {
    id: row.id,
    ownerTenantId: row.owner_tenant_id,
    kind: row.kind,
    region: row.region,
    version: int(row.version),
  };
  if (row.iam_region !== null) site.iamRegion = row.iam_region;
  return site;
}

async function lockSite(context: MethodContext, input: { tenantId: string; siteId: string; version?: number }) {
  const { rows } = await context.sql.query<SiteRow>(
    `SELECT ${columns} FROM sites s WHERE s.id = $1 AND s.owner_tenant_id = $2 FOR UPDATE`,
    [input.siteId, input.tenantId],
  );
  const row = rows[0];
  if (!row) throw notFound('Site');
  return row;
}

function checkVersion(row: SiteRow, version: number | undefined) {
  if (version !== undefined && int(row.version) !== version)
    throw new ComputeError('CONFLICT', `The site changed (it is at version ${int(row.version)})`, undefined, {
      version: int(row.version),
    });
}

/** The tenants that see the site (the projection rows the resolver answers from). */
async function viewers(context: MethodContext, siteId: string): Promise<string[]> {
  const { rows } = await context.sql.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM authz_projection WHERE type = 'site' AND id = $1 ORDER BY tenant_id`,
    [siteId],
  );
  return rows.map((row) => row.tenant_id);
}

export function sitesManageApi(): SitesManageApi {
  return {
    sites: {
      update: defineMethod<UpdateSiteInput, Site>({
        action: 'compute:sites:manage',
        kind: 'mutation',
        resource: (input) => ({ type: 'site', id: input.siteId }),
        validate: updateInput,
        async handler(context, input) {
          const row = await lockSite(context, input);
          if (row.deleted_at !== null) throw notFound('Site');
          checkVersion(row, input.version);
          const iamRegion = input.clearIamRegion ? null : (input.iamRegion ?? row.iam_region);
          const nextRegion = input.region ?? row.region;
          if (nextRegion === row.region && iamRegion === row.iam_region) return toSite(row);
          const { rows } = await context.sql.query<SiteRow>(
            `UPDATE sites s SET region = $2, iam_region = $3, version = s.version + 1
              WHERE s.id = $1 RETURNING ${columns}`,
            [row.id, nextRegion, iamRegion],
          );
          const site = toSite(rows[0]!);
          // Every tenant that sees the site sees the new attributes (IAM conditions on region).
          for (const tenantId of await viewers(context, site.id))
            await context.authz.upsert(context.sql, {
              type: 'site',
              id: site.id,
              tenantId,
              attributes: siteAttributes(site),
            });
          await context.events.publish(context.sql, {
            type: 'site.updated',
            tenantId: site.ownerTenantId,
            subject: `site/${site.id}`,
            data: { siteId: site.id, region: site.region, iamRegion: site.iamRegion ?? null },
          });
          return site;
        },
      }),
      delete: defineMethod<DeleteSiteInput, DeletedSite>({
        action: 'compute:sites:manage',
        kind: 'mutation',
        resource: (input) => ({ type: 'site', id: input.siteId }),
        validate: deleteInput,
        async handler(context, input) {
          // The row lock also holds off pools and nodes being created on the site (their FK).
          const row = await lockSite(context, input);
          if (row.deleted_at !== null) return { siteId: row.id, deleted: false, tombstoned: true };
          checkVersion(row, input.version);
          const { rows: live } = await context.sql.query<{ pools: number; nodes: number }>(
            `SELECT (SELECT count(*)::int FROM pools WHERE site_id = $1 AND archived_at IS NULL) AS pools,
                    (SELECT count(*)::int FROM nodes WHERE site_id = $1 AND deleted_at IS NULL) AS nodes`,
            [row.id],
          );
          const { pools, nodes } = live[0]!;
          if (pools || nodes)
            throw new ComputeError(
              'INVALID_STATE',
              'Archive the site’s pools and delete its nodes first',
              undefined,
              { pools, nodes },
            );
          await context.sql.query(
            'UPDATE join_tokens SET revoked_at = compute_now() WHERE site_id = $1 AND revoked_at IS NULL',
            [row.id],
          );
          await context.sql.query(
            `UPDATE join_requests SET state = 'expired', expires_at = LEAST(expires_at, compute_now()),
               version = version + 1
              WHERE site_id = $1 AND state IN ('pending', 'approved')`,
            [row.id],
          );
          await context.sql.query('DELETE FROM leases WHERE name = $1', [siteBootLeaseName(row.id)]);
          const { rows: refs } = await context.sql.query<{ referenced: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pools WHERE site_id = $1)
                 OR EXISTS (SELECT 1 FROM nodes WHERE site_id = $1)
                 OR EXISTS (SELECT 1 FROM join_requests WHERE site_id = $1) AS referenced`,
            [row.id],
          );
          const tombstoned = refs[0]!.referenced;
          for (const tenantId of await viewers(context, row.id))
            await context.authz.remove(context.sql, { type: 'site', id: row.id, tenantId });
          if (tombstoned)
            await context.sql.query(
              'UPDATE sites SET deleted_at = compute_now(), version = version + 1 WHERE id = $1',
              [row.id],
            );
          // Revoked tokens stay (they carry no foreign key) as the record of what could have joined.
          else await context.sql.query('DELETE FROM sites WHERE id = $1', [row.id]);
          await context.events.publish(context.sql, {
            type: 'site.deleted',
            tenantId: row.owner_tenant_id,
            subject: `site/${row.id}`,
            data: { siteId: row.id, tombstoned },
          });
          return { siteId: row.id, deleted: true, tombstoned };
        },
      }),
    },
  };
}
