import {
  ComputeError,
  defineMethod,
  fleetResourceId,
  type AuthzAttributes,
  type MethodDefinition,
  type Site,
  type SiteKind,
  type SqlTx,
} from '@better-compute/core';
import { defineListMethod, type ListRecipe } from '../list.js';
import {
  admittedOf,
  derivedId,
  fields,
  int,
  keyReused,
  limit,
  notFound,
  page,
  patterns,
  visibleIn,
  type Page,
} from './common.js';
import { parser, v } from './input.js';

// `sites` (PLAN.md §9.2, module server): boot and failure domains. Platform sites (`shared`,
// `dedicated`) belong to the root tenant and are created under `compute-fleet/global`; a tenant's
// own hardware lives on its `custom` sites (D11), created under `compute-tenant/{t}`. What a tenant
// sees is what the projection holds for it.

export interface CreateSiteInput {
  /** The owner: the root tenant for `shared` and `dedicated` sites, the tenant for `custom` ones. */
  tenantId: string;
  kind: SiteKind;
  /** A region label (`eu-west-1`). */
  region: string;
  /** The IAM region name, when it differs from `region`. */
  iamRegion?: string;
  idempotencyKey: string;
}
export interface GetSiteInput {
  tenantId: string;
  siteId: string;
}
export interface ListSitesInput {
  tenantId: string;
  kind?: SiteKind;
  region?: string;
  /** At most 50 (the default). */
  limit?: number;
  cursor?: string;
}

export type SitesApi = {
  sites: {
    list: MethodDefinition<ListSitesInput, Page<Site>>;
    get: MethodDefinition<GetSiteInput, Site>;
    create: MethodDefinition<CreateSiteInput, Site>;
  };
};

const kinds = ['shared', 'dedicated', 'custom'] as const;
const createInput: (input: unknown) => CreateSiteInput = parser({
  tenantId: fields.tenantId,
  kind: v.option(kinds),
  region: v.string({ pattern: patterns.region, max: 63 }),
  iamRegion: v.optional(v.string({ pattern: patterns.region, max: 63 })),
  idempotencyKey: fields.idempotencyKey,
});
const getInput: (input: unknown) => GetSiteInput = parser({
  tenantId: fields.tenantId,
  siteId: fields.siteId,
});
const listInput: (input: unknown) => ListSitesInput = parser({
  tenantId: fields.tenantId,
  kind: v.optional(v.option(kinds)),
  region: v.optional(v.string({ pattern: patterns.region, max: 63 })),
  limit: limit(50),
  cursor: v.optional(fields.cursor),
});

interface SiteRow {
  id: string;
  owner_tenant_id: string;
  kind: SiteKind;
  region: string;
  iam_region: string | null;
  version: unknown;
}
const columns = 's.id, s.owner_tenant_id, s.kind, s.region, s.iam_region, s.version';

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

/** The site as IAM policies see it (`compute-site` attributes, §12.3). */
export function siteAttributes(site: Site): AuthzAttributes {
  const attributes: AuthzAttributes = { region: site.region, kind: site.kind };
  if (site.iamRegion !== undefined) attributes.iamRegion = site.iamRegion;
  return attributes;
}

async function ownedSite(tx: SqlTx, ownerTenantId: string, id: string): Promise<Site | undefined> {
  const { rows } = await tx.query<SiteRow>(
    `SELECT ${columns} FROM sites s WHERE s.id = $1 AND s.owner_tenant_id = $2`,
    [id, ownerTenantId],
  );
  return rows[0] && toSite(rows[0]);
}

const sameRequest = (site: Site, input: CreateSiteInput) =>
  site.kind === input.kind && site.region === input.region && site.iamRegion === input.iamRegion;

/** `compute-fleet/global` for platform sites, `compute-tenant/{t}` for a tenant's custom sites. */
const scopeOf = (input: CreateSiteInput) =>
  input.kind === 'custom'
    ? { type: 'tenant' as const, id: input.tenantId }
    : { type: 'fleet' as const, id: fleetResourceId };

export function sitesApi(lists: ListRecipe): SitesApi {
  return {
    sites: {
      list: defineListMethod<ListSitesInput, Page<Site>>({
        action: 'compute:sites:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: listInput,
        async handler(context, input) {
          const size = input.limit ?? 50;
          let result: Page<Site> = { items: [] };
          const items = await lists.authorizeItems(
            context,
            input.tenantId,
            async () => {
              const { rows } = await context.sql.query<SiteRow>(
                `SELECT ${columns} FROM sites s
                 WHERE ${visibleIn('site', 's.id', '$1')}
                   AND ($2::text IS NULL OR s.kind = $2) AND ($3::text IS NULL OR s.region = $3)
                   AND ($4::text IS NULL OR s.id > $4)
                 ORDER BY s.id LIMIT $5`,
                [
                  input.tenantId,
                  input.kind ?? null,
                  input.region ?? null,
                  input.cursor ?? null,
                  size + 1,
                ],
              );
              result = page(rows, size, toSite, (row) => row.id);
              return result.items;
            },
            { action: 'compute:sites:read', type: 'site', id: (site) => site.id },
          );
          return { ...result, items };
        },
      }),
      get: defineMethod<GetSiteInput, Site>({
        action: 'compute:sites:read',
        kind: 'read',
        resource: (input) => ({ type: 'site', id: input.siteId }),
        validate: getInput,
        async handler(context, input) {
          const { rows } = await context.sql.query<SiteRow>(
            `SELECT ${columns} FROM sites s WHERE s.id = $2 AND ${visibleIn('site', 's.id', '$1')}`,
            [input.tenantId, input.siteId],
          );
          if (!rows[0]) throw notFound('Site');
          return toSite(rows[0]);
        },
      }),
      create: defineMethod<CreateSiteInput, Site>({
        action: 'compute:sites:manage',
        kind: 'mutation',
        resource: scopeOf,
        validate: createInput,
        admission: {
          async prepare(context, input, tx) {
            const id = await derivedId('site', input.tenantId, context, input.idempotencyKey);
            const existing = await ownedSite(tx, input.tenantId, id);
            if (existing) {
              if (!sameRequest(existing, input)) throw keyReused();
              return { status: 'replay', result: existing };
            }
            return { status: 'decide', resource: scopeOf(input) };
          },
        },
        async handler(context, input) {
          // Fleet decisions are made in the root tenant, which owns every platform site.
          const owner = admittedOf(context).tenantId;
          if (input.tenantId !== owner)
            throw new ComputeError(
              'INVALID_INPUT',
              `tenantId: ${input.kind} sites belong to the root tenant`,
            );
          const id = await derivedId('site', owner, context, input.idempotencyKey);
          const { rows } = await context.sql.query<SiteRow>(
            `INSERT INTO sites AS s (id, owner_tenant_id, kind, region, iam_region, version)
             VALUES ($1, $2, $3, $4, $5, 1)
             ON CONFLICT DO NOTHING
             RETURNING ${columns}`,
            [id, owner, input.kind, input.region, input.iamRegion ?? null],
          );
          if (!rows[0]) {
            const existing = await ownedSite(context.sql, owner, id);
            if (existing && sameRequest(existing, input)) return existing;
            throw keyReused();
          }
          const site = toSite(rows[0]);
          await context.authz.upsert(context.sql, {
            type: 'site',
            id,
            tenantId: owner,
            attributes: siteAttributes(site),
          });
          await context.events.publish(context.sql, {
            type: 'site.created',
            tenantId: owner,
            subject: `site/${id}`,
            data: { siteId: id, kind: site.kind, region: site.region },
          });
          return site;
        },
      }),
    },
  };
}
