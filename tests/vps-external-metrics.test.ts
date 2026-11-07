import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  digitaloceanProvider,
  labels,
  resetBudgets,
  tagFor,
} from '@better-compute/provider-digitalocean';
import {
  createMetrics,
  externalMetricsCollector,
  storedExternalMetrics,
} from '@better-compute/observability';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { DoEmulator, type Json } from './support/do-emulator/index.js';
import { seedSshKey } from './support/do-emulator/keys.js';
import { seedMetric } from './support/do-emulator/monitoring.js';

// External host metrics through vps (DigitalOcean P9): with `vps({ externalMetrics })`, the vps.external-metrics
// worker reads the Droplet metrics of each account's live instances (ProviderImpl.readMetrics) into
// instance_external_metrics, and every process serves them as gauges through storedExternalMetrics.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

const REGION = 'nyc3';
const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';

async function world(
  options: { externalMetrics?: boolean; machineLimit?: number; instances?: number } = {
    externalMetrics: true,
  },
) {
  const emu = new DoEmulator();
  emu.validTokens = new Set(['root-do-token']);
  const fingerprint = seedSshKey(emu.state, 'platform', testKey).fingerprint as string;
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [
      vps({
        providers: [digitaloceanProvider({ fetch: emu.fetch })],
        ...(options.externalMetrics
          ? {
              externalMetrics:
                options.machineLimit !== undefined ? { machineLimit: options.machineLimit } : {},
            }
          : {}),
      }),
    ],
  });
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as any;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const { ref } = await api.secrets.put(root, {
    tenantId: tenants.root.id,
    name: 'do',
    value: 'root-do-token',
    idempotencyKey: 'do-token',
  });
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'digitalocean',
    name: 'do-main',
    config: { token: ref, regions: [REGION], sshKeyFingerprint: fingerprint },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: REGION,
    idempotencyKey: 'do-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'do-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 100, memoryGiB: 100, diskGiB: 1000, gpu: 0 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 's.1vcpu.1gb',
    vcpu: 1,
    memoryGiB: 1,
    diskGiB: 25,
    offerId: `${REGION}/s-1vcpu-1gb`,
  });
  const all: { id: string }[] = [];
  for (let n = 1; n <= (options.instances ?? 1); n++)
    all.push(
      await api.instances.create(acme, {
        tenantId: tenants.acme.id,
        poolId: pool.id,
        flavor: 's.1vcpu.1gb',
        imageId: 'ubuntu-24-04-x64',
        sshKeys: [],
        idempotencyKey: `vm-${n}`,
      }),
    );
  const created = all[0]!;
  for (let round = 0; round < 6; round++) {
    await fixture.advance(5_000);
    for (let pass = 0; pass < 2; pass++) await compute.jobs['vps.instances']!.tick();
  }
  const dropletOf = (id: string) =>
    [...emu.state.droplets.values()].find((d: Json) =>
      (d.tags as string[]).includes(tagFor(labels.instance, id)),
    )!;
  const droplet = dropletOf(created.id);
  const s = Math.floor(fixture.clock.now() / 1000);
  for (const instance of all) {
    const id = dropletOf(instance.id).id as number;
    seedMetric(emu, id, 'memory_total', {}, [[s - 30, 2_000_000_000]]);
    seedMetric(emu, id, 'memory_available', {}, [[s - 30, 500_000_000]]);
    seedMetric(emu, id, 'load_1', {}, [[s - 30, 0.75]]);
  }
  const rows = async () =>
    (
      await fixture.database.query<any>(
        `SELECT instance_id, metric, source, account_id, value FROM instance_external_metrics ORDER BY metric`,
      )
    ).rows;
  const run = async () => {
    for (let round = 0; round < 2; round++) await compute.jobs['vps.external-metrics']!.tick();
  };
  return { emu, fixture, api, acme, tenants, account, created, all, droplet, rows, run };
}

describe('vps.external-metrics', () => {
  it("stores the newest sample of each metric of the account's live instances", async () => {
    const { fixture, account, created, rows, run, emu } = await world();
    await run();
    expect(await rows()).toEqual([
      {
        instance_id: created.id,
        metric: 'load1',
        source: 'digitalocean',
        account_id: account.id,
        value: 0.75,
      },
      {
        instance_id: created.id,
        metric: 'memory_total_bytes',
        source: 'digitalocean',
        account_id: account.id,
        value: 2_000_000_000,
      },
      {
        instance_id: created.id,
        metric: 'memory_used_bytes',
        source: 'digitalocean',
        account_id: account.id,
        value: 1_500_000_000,
      },
    ]);
    // Every request was a monitoring GET or the Droplet lifecycle, with no token in a stored row.
    const reads = emu.requests.filter((r) => r.url.pathname.startsWith('/v2/monitoring/'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.method === 'GET')).toBe(true);
    expect(JSON.stringify(await rows())).not.toContain('root-do-token');

    // Every process serves the stored samples as the external host gauges.
    let now = fixture.clock.now();
    const registry = createMetrics();
    const collector = externalMetricsCollector(
      registry,
      [storedExternalMetrics(fixture.database, 'digitalocean')],
      { now: () => now },
    );
    expect(await collector.pull()).toEqual([{ source: 'digitalocean', samples: 3 }]);
    expect(registry.expose()).toContain(
      `better_compute_external_host_load1{source="digitalocean",instance="${created.id}"} 0.75`,
    );
    now += 20 * 60_000;
    expect(registry.expose()).toContain(
      `better_compute_external_host_load1{source="digitalocean",instance="${created.id}"} NaN`,
    );
  });

  it('writes no rows for an instance deleted while the provider was read', async () => {
    const { emu, fixture, all, rows, run } = await world({ externalMetrics: true, instances: 2 });
    const [gone, kept] = all as [{ id: string }, { id: string }];
    // The instance is deleted between the page of live instances and the write (pglite runs queries in order, so
    // the update lands before the write's transaction).
    emu.beforeAction('GET /monitoring/metrics/droplet/*', () => {
      void fixture.database.query(`UPDATE instances SET state = 'deleted' WHERE id = $1`, [gone.id]);
    });
    await run();
    const stored = await rows();
    expect(stored.length).toBe(3);
    expect(new Set(stored.map((row: { instance_id: string }) => row.instance_id))).toEqual(
      new Set([kept.id]),
    );
  });

  it('drops the rows of an instance that is no longer live', async () => {
    const { fixture, created, rows, run } = await world();
    await run();
    expect(await rows()).toHaveLength(3);
    await fixture.database.query(`UPDATE instances SET state = 'deleted' WHERE id = $1`, [
      created.id,
    ]);
    await fixture.advance(5 * 60_000 + 1_000);
    await run();
    expect(await rows()).toEqual([]);
  });

  it('reads an account with more live instances than one read asks for a page per period, keeping the rest', async () => {
    const { fixture, all, rows, run } = await world({
      externalMetrics: true,
      machineLimit: 2,
      instances: 3,
    });
    const ids = all.map((instance) => instance.id).sort();
    const stored = async () =>
      [...new Set((await rows()).map((row: any) => row.instance_id))].sort();
    await run();
    expect(await stored()).toEqual(ids.slice(0, 2));
    // The next period reads the page after it (wrapping round), and the first page's rows stay.
    await fixture.advance(5 * 60_000 + 1_000);
    await run();
    expect(await stored()).toEqual(ids);
    await fixture.advance(5 * 60_000 + 1_000);
    await run();
    expect(await stored()).toEqual(ids);
    expect(() => vps({ externalMetrics: { machineLimit: 0 } })).toThrow(/machineLimit/);
  });

  it('is off unless configured, and its period is validated', async () => {
    const { fixture } = await world({ externalMetrics: false });
    expect(fixture.compute.jobs['vps.external-metrics']).toBeUndefined();
    expect(() => vps({ externalMetrics: { every: '10s' } })).toThrow(/at least 1m/);
  });

  it('storedExternalMetrics answers nothing before vps migrated the table', async () => {
    const registry = createMetrics();
    const sql = {
      async query() {
        return { rows: [{ found: null }] } as never;
      },
    };
    const collector = externalMetricsCollector(registry, [
      storedExternalMetrics(sql, 'digitalocean'),
    ]);
    expect(await collector.pull()).toEqual([{ source: 'digitalocean', samples: 0 }]);
  });
});
