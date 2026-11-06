import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  digitaloceanProvider,
  labels,
  resetBudgets,
  tagFor,
} from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { billingOf, invoiceItem } from './support/do-emulator/billing.js';
import { DoEmulator, type Json } from './support/do-emulator/index.js';
import { seedSshKey } from './support/do-emulator/keys.js';

// DigitalOcean P9 billing through vps: a platform DO account with `costs: true` feeds the vps.costs worker from
// its invoices, and the Droplet's item is attributed to the instance and tenant that own it (D-ops-2).

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

const REGION = 'nyc3';
const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';

/** A platform DigitalOcean account with costs on, a pool offered to acme, and acme's running Droplet. */
async function doWorld() {
  const emu = new DoEmulator();
  emu.validTokens = new Set(['root-do-token']);
  const fingerprint = seedSshKey(emu.state, 'platform', testKey).fingerprint as string;
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [digitaloceanProvider({ fetch: emu.fetch })] })],
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
  const config = { token: ref, regions: [REGION], sshKeyFingerprint: fingerprint, costs: true };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'digitalocean',
    name: 'do-main',
    config,
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
  const created = await api.instances.create(acme, {
    tenantId: tenants.acme.id,
    poolId: pool.id,
    flavor: 's.1vcpu.1gb',
    imageId: 'ubuntu-24-04-x64',
    sshKeys: [],
    idempotencyKey: 'vm-1',
  });
  for (let round = 0; round < 6; round++) {
    await fixture.advance(5_000);
    for (let pass = 0; pass < 2; pass++) await compute.jobs['vps.instances']!.tick();
  }
  const droplet = [...emu.state.droplets.values()].find((d: Json) =>
    (d.tags as string[]).includes(tagFor(labels.instance, created.id)),
  )!;
  expect(droplet).toBeDefined();

  return { emu, fixture, compute, tenants, api, root, acme, account, config, created, droplet };
}

describe('DigitalOcean invoices through vps.costs', () => {
  it('ingests the month-to-date items and attributes the Droplet’s to its instance', async () => {
    const { emu, fixture, compute, tenants, api, account, created, droplet } = await doWorld();
    // The sim clock starts on 2026-01-01: January's preview holds the Droplet and a Spaces item.
    const billing = billingOf(emu);
    billing.preview = {
      invoice_uuid: 'preview-jan',
      invoice_period: '2026-01',
      updated_at: '2026-01-01T00:00:30Z',
    };
    billing.items.set('preview-jan', [
      invoiceItem({
        resource_id: String(droplet.id),
        amount: '0.01',
        duration: '1',
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      }),
      invoiceItem({
        product: 'Spaces',
        resource_id: '',
        resource_uuid: 'bucket-1',
        description: 'Spaces subscription',
        amount: '5.00',
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      }),
    ]);
    await fixture.advance(60_000);
    for (let round = 0; round < 2; round++) await compute.jobs['vps.costs']!.tick();

    const { rows } = await fixture.database.query<any>(
      `SELECT cost_micros, instance_id, tenant_id, attribution, record->>'service' AS service
         FROM provider_costs WHERE account_id = $1 ORDER BY service`,
      [account.id],
    );
    expect(rows.map((row: any) => ({ ...row, cost_micros: Number(row.cost_micros) }))).toEqual([
      {
        cost_micros: 10_000,
        instance_id: created.id,
        tenant_id: tenants.acme.id,
        attribution: 'instance',
        service: 'Droplets',
      },
      {
        cost_micros: 5_000_000,
        instance_id: null,
        // A platform account's row that names no instance or tenant is the platform's to explain.
        tenant_id: null,
        attribution: 'unattributed',
        service: 'Spaces',
      },
    ]);
    // Every billing read was a GET with the account's token, and the token is in no stored row.
    const billingReads = emu.requests.filter((r) => r.url.pathname.startsWith('/v2/customers/my/'));
    expect(billingReads.length).toBeGreaterThan(0);
    expect(billingReads.every((r) => r.method === 'GET')).toBe(true);
    const { rows: all } = await fixture.database.query<any>(`SELECT record FROM provider_costs`);
    expect(JSON.stringify(all)).not.toContain('root-do-token');

    // Leaks (periodRows): an hour billed for a Droplet that has run a minute is within the tolerance...
    const leaks = async () =>
      (
        await fixture.database.query<any>(`SELECT payload FROM outbox WHERE topic = 'billing.leak'`)
      ).rows.map((row: any) => row.payload.data);
    expect(await leaks()).toEqual([]);
    // ...48 hours of it after 6 hours of running is a leak, raised for the instance's January item (the next
    // pass is 6 hours on).
    billing.items.get('preview-jan')![0]!.duration = '48';
    billing.preview.updated_at = '2026-01-01T06:00:00Z';
    await fixture.advance(6 * 3_600_000 + 60_000);
    for (let round = 0; round < 2; round++) await compute.jobs['vps.costs']!.tick();
    expect(await leaks()).toEqual([
      expect.objectContaining({
        accountId: account.id,
        instanceId: created.id,
        tenantId: tenants.acme.id,
        day: '2026-01-01',
        providerHours: 48,
      }),
    ]);
  });

  it('passes a Droplet’s backups through to its tenant on a reported meter, never its compute', async () => {
    const { emu, fixture, compute, tenants, api, root, account, config, created, droplet } = await doWorld();
    const backupsMeter = 'do.backups.usd';
    Object.assign(fixture.iam, { listMeters: async () => [{ key: backupsMeter, pricing: 'reported' }] });
    const setRules = (passThrough: unknown[]) =>
      api.providerAccounts.update(root, {
        tenantId: tenants.root.id,
        accountId: account.id,
        config,
        billing: { passThrough },
      });
    // Droplet hours are compute's own meters: a rule that would pass them through is refused.
    await expect(setRules([{ skuPattern: 'Droplets', meter: backupsMeter, multiplier: 1 }])).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('matches SKUs compute'),
    });
    await setRules([{ skuPattern: 'backup', meter: backupsMeter, multiplier: 1.5 }]);

    const billing = billingOf(emu);
    billing.preview = {
      invoice_uuid: 'preview-jan',
      invoice_period: '2026-01',
      updated_at: '2026-01-01T00:00:30Z',
    };
    billing.items.set('preview-jan', [
      invoiceItem({
        resource_id: String(droplet.id),
        amount: '0.01',
        duration: '1',
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      }),
      invoiceItem({
        product: 'Droplet Backups',
        resource_id: String(droplet.id),
        description: 'Weekly backups',
        amount: '0.40',
        duration: '1',
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      }),
    ]);
    await fixture.advance(60_000);
    for (let round = 0; round < 2; round++) await compute.jobs['vps.costs']!.tick();

    // The backups item is acme's (its Droplet's), passed through at cost × 1.5 on the reported meter, so acme's
    // Better IAM budgets count it with the rest of its usage; the Droplet's own hours stay compute's.
    const { rows } = await fixture.database.query<any>(
      `SELECT tenant_id, meter, cost_micros, source_id FROM usage_windows WHERE source_kind = 'cost'`,
    );
    expect(rows.map((row: any) => ({ ...row, cost_micros: Number(row.cost_micros) }))).toEqual([
      {
        tenant_id: tenants.acme.id,
        meter: backupsMeter,
        cost_micros: 600_000,
        source_id: expect.stringMatching(new RegExp(`^${account.id}:`)),
      },
    ]);
    const { rows: costs } = await fixture.database.query<any>(
      `SELECT record->>'service' AS service, instance_id, passed_through_at IS NOT NULL AS passed
         FROM provider_costs WHERE account_id = $1 ORDER BY service`,
      [account.id],
    );
    expect(costs).toEqual([
      { service: 'Droplet Backups', instance_id: created.id, passed: true },
      { service: 'Droplets', instance_id: created.id, passed: false },
    ]);
  });
});
