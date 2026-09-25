import type { Migration, SqlTx } from '@better-compute/core';
import type {
  FleetConfig,
  FleetFlavor,
  FleetPool,
  FleetProviderAccount,
  FleetSandboxTemplate,
  FleetSite,
} from './config.js';

/** Names fleet gave the objects it manages (pools and sites have no name column of their own). */
export const fleetNamesMigration: Migration = {
  name: 'fleet/0001_names',
  sql: `
CREATE TABLE fleet_names (
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('site', 'pool', 'providerAccount')),
  name text NOT NULL,
  object_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (tenant_id, kind, name),
  UNIQUE (tenant_id, kind, object_id)
);
`,
};

export type NamedKind = 'site' | 'pool' | 'providerAccount';

/** The tenant's current platform objects, with ids, in FleetConfig terms. */
export interface FleetState {
  tenantId: string;
  sites: (FleetSite & { id: string })[];
  providerAccounts: (FleetProviderAccount & { id: string })[];
  pools: (Required<Pick<FleetPool, 'ownerQuota' | 'policy' | 'offers'>> &
    FleetPool & { id: string; siteId: string; providerAccountId?: string })[];
  flavors: (FleetFlavor & { poolId: string })[];
  /** Every field filled in (runtime, TTL bounds, warm, network); `userData` and `env` only when set. */
  sandboxTemplates: (Required<Omit<FleetSandboxTemplate, 'userData' | 'env'>> &
    Pick<FleetSandboxTemplate, 'userData' | 'env'> & {
      id: string;
      poolId: string;
      warm: { min: number; max: number };
    })[];
  /** Tables of modules this deployment does not run (vps: flavors, provider accounts, sandbox templates). */
  missing: string[];
}

const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

async function tableExists(tx: SqlTx, table: string): Promise<boolean> {
  const { rows } = await tx.query<{ found: string | null }>(
    'SELECT to_regclass($1)::text AS found',
    [table],
  );
  return Boolean(rows[0]?.found);
}

/** Reads what `tenantId` owns now. Objects fleet never named are named by their id. */
export async function readFleetState(tx: SqlTx, tenantId: string): Promise<FleetState> {
  const names = new Map<string, string>();
  for (const row of (
    await tx.query<{ kind: string; name: string; object_id: string }>(
      'SELECT kind, name, object_id FROM fleet_names WHERE tenant_id = $1',
      [tenantId],
    )
  ).rows)
    names.set(`${row.kind}:${row.object_id}`, row.name);
  const nameOf = (kind: NamedKind, id: string) => names.get(`${kind}:${id}`) ?? id;
  const missing: string[] = [];

  const sites = (
    await tx.query<{
      id: string;
      kind: FleetSite['kind'];
      region: string;
      iam_region: string | null;
    }>('SELECT id, kind, region, iam_region FROM sites WHERE owner_tenant_id = $1 ORDER BY id', [
      tenantId,
    ])
  ).rows.map((row) => ({
    id: row.id,
    name: nameOf('site', row.id),
    kind: row.kind,
    region: row.region,
    ...(row.iam_region ? { iamRegion: row.iam_region } : {}),
  }));
  const siteName = new Map(sites.map((site) => [site.id, site.name]));

  let providerAccounts: FleetState['providerAccounts'] = [];
  if (await tableExists(tx, 'provider_accounts'))
    providerAccounts = (
      await tx.query<{ id: string; provider: string; name: string; config: unknown }>(
        'SELECT id, provider, name, config FROM provider_accounts WHERE tenant_id = $1 ORDER BY id',
        [tenantId],
      )
    ).rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      config: (parse(row.config) ?? {}) as Record<string, unknown>,
    }));
  else missing.push('provider_accounts');
  const accountName = new Map(providerAccounts.map((account) => [account.id, account.name]));

  const archived =
    (
      await tx.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'pools' AND column_name = 'archived_at'`,
      )
    ).rows.length > 0;
  const poolRows = (
    await tx.query<{
      id: string;
      site_id: string;
      class: string;
      gpu_model: string | null;
      sharing: string;
      agent: 'bcd' | 'none';
      policy: unknown;
      provider_account_id?: string | null;
    }>(
      `SELECT * FROM pools WHERE owner_tenant_id = $1 ${archived ? 'AND archived_at IS NULL' : ''} ORDER BY id`,
      [tenantId],
    )
  ).rows;
  const poolIds = poolRows.map((row) => row.id);
  const quotas = (
    await tx.query<{ tenant_id: string; pool_id: string; resource: string; max: string | number }>(
      'SELECT tenant_id, pool_id, resource, max FROM quota_usage WHERE pool_id = ANY($1::text[])',
      [poolIds],
    )
  ).rows;
  const offers = (
    await tx.query<{
      pool_id: string;
      tenant_id: string;
      include_descendants: boolean;
      priority?: number | null;
    }>('SELECT * FROM pool_offers WHERE pool_id = ANY($1::text[]) AND tenant_id <> $2', [
      poolIds,
      tenantId,
    ])
  ).rows;
  const quotaOf = (poolId: string, tenant: string) =>
    Object.fromEntries(
      quotas
        .filter((row) => row.pool_id === poolId && row.tenant_id === tenant)
        .sort((a, b) => a.resource.localeCompare(b.resource))
        .map((row) => [row.resource, Number(row.max)]),
    );
  const pools: FleetState['pools'] = poolRows.map((row) => {
    const pool: FleetState['pools'][number] = {
      id: row.id,
      siteId: row.site_id,
      name: nameOf('pool', row.id),
      site: siteName.get(row.site_id) ?? row.site_id,
      class: row.class,
      sharing: row.sharing,
      agent: row.agent,
      policy: (parse(row.policy) ?? {}) as Record<string, unknown>,
      ownerQuota: quotaOf(row.id, tenantId),
      offers: offers
        .filter((offer) => offer.pool_id === row.id)
        .sort((a, b) => a.tenant_id.localeCompare(b.tenant_id))
        .map((offer) => ({
          tenant: offer.tenant_id,
          quota: quotaOf(row.id, offer.tenant_id),
          includeDescendants: offer.include_descendants,
          ...(offer.priority !== undefined && offer.priority !== null && offer.priority !== 0
            ? { priority: offer.priority }
            : {}),
        })),
    };
    if (row.gpu_model) pool.gpuModel = row.gpu_model;
    if (row.provider_account_id) {
      pool.providerAccountId = row.provider_account_id;
      pool.providerAccount = accountName.get(row.provider_account_id) ?? row.provider_account_id;
    }
    return pool;
  });
  const poolName = new Map(pools.map((pool) => [pool.id, pool.name]));

  let flavors: FleetState['flavors'] = [];
  if (await tableExists(tx, 'flavors'))
    flavors = (
      await tx.query<{
        pool_id: string;
        name: string;
        vcpu: number;
        memory_gib: number;
        disk_gib: number;
        gpus: number | null;
        offer_id: string | null;
      }>(
        `SELECT pool_id, name, vcpu, memory_gib, disk_gib, gpus, offer_id FROM flavors
          WHERE pool_id = ANY($1::text[]) AND NOT archived ORDER BY pool_id, name`,
        [poolIds],
      )
    ).rows.map((row) => ({
      poolId: row.pool_id,
      pool: poolName.get(row.pool_id) ?? row.pool_id,
      name: row.name,
      vcpu: Number(row.vcpu),
      memoryGiB: Number(row.memory_gib),
      diskGiB: Number(row.disk_gib),
      ...(row.gpus ? { gpus: Number(row.gpus) } : {}),
      ...(row.offer_id ? { offerId: row.offer_id } : {}),
    }));
  else missing.push('flavors');

  let sandboxTemplates: FleetState['sandboxTemplates'] = [];
  if (await tableExists(tx, 'sandbox_templates'))
    sandboxTemplates = (
      await tx.query<{
        id: string;
        name: string;
        pool_id: string;
        flavor: string;
        image_id: string;
        runtime: string;
        user_data: string | null;
        default_ttl_seconds: number;
        max_ttl_seconds: number;
        warm_min: number;
        warm_max: number;
        env: unknown;
        network: 'egress' | 'private' | 'none';
      }>(
        `SELECT id, name, pool_id, flavor, image_id, runtime, user_data, default_ttl_seconds,
                max_ttl_seconds, warm_min, warm_max, env, network
           FROM sandbox_templates WHERE tenant_id = $1 AND NOT deleted ORDER BY name`,
        [tenantId],
      )
    ).rows.map((row) => ({
      id: row.id,
      poolId: row.pool_id,
      name: row.name,
      // Offered pools are not the tenant's, so they are named by id.
      pool: poolName.get(row.pool_id) ?? row.pool_id,
      flavor: row.flavor,
      imageId: row.image_id,
      runtime: row.runtime,
      ...(row.user_data !== null ? { userData: row.user_data } : {}),
      defaultTtlSeconds: Number(row.default_ttl_seconds),
      maxTtlSeconds: Number(row.max_ttl_seconds),
      warm: { min: Number(row.warm_min), max: Number(row.warm_max) },
      network: row.network,
      ...(Object.keys((parse(row.env) ?? {}) as object).length
        ? { env: parse(row.env) as Record<string, string> }
        : {}),
    }));
  else missing.push('sandbox_templates');

  return { tenantId, sites, providerAccounts, pools, flavors, sandboxTemplates, missing };
}

/** The current state as a FleetConfig document (`fleet.export`). */
export function exportFleetConfig(state: FleetState): FleetConfig {
  const config: FleetConfig = { version: 1 };
  if (state.sites.length) config.sites = state.sites.map(({ id: _id, ...site }) => site);
  if (state.providerAccounts.length)
    config.providerAccounts = state.providerAccounts.map(({ id: _id, ...account }) => account);
  if (state.pools.length)
    config.pools = state.pools.map(
      ({ id: _id, siteId: _site, providerAccountId: _account, offers, ...pool }) => ({
        ...pool,
        ...(offers.length ? { offers } : {}),
      }),
    );
  if (state.flavors.length)
    config.flavors = state.flavors.map(({ poolId: _pool, ...flavor }) => flavor);
  if (state.sandboxTemplates.length)
    config.sandboxTemplates = state.sandboxTemplates.map(
      ({ id: _id, poolId: _pool, ...template }) => template,
    );
  return config;
}
