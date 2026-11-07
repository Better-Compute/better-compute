import { beforeEach, describe, expect, it } from 'vitest';
import {
  manualClock,
  type CallContext,
  type Logger,
  type ProviderCostRecord,
} from '@better-compute/core';
import {
  deploymentTag,
  digitaloceanProvider,
  doBilling,
} from '@better-compute/provider-digitalocean';
import { billingOf, invoiceItem } from './support/do-emulator/billing.js';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator } from './support/do-emulator/index.js';
import { build, ctx, freshBudgets } from './support/do-harness.js';

// DigitalOcean P9 billing: provider costs from invoices (D-ops-2). DO bills per invoice item, a month aggregate per
// resource; the preview is the month to date. Items carry no tags, so instance and tenant labels come from the
// account's Droplets of this deployment, by resource id.

beforeEach(freshBudgets);

const now = Date.parse('2026-10-05T12:00:00Z');
const october = { from: Date.parse('2026-10-02T12:00:00Z'), to: now };
const account = { token: 'secret://do/t', regions: ['nyc3'], costs: true };

function at(ms: number, log?: Logger): CallContext {
  return { ...ctx(), clock: manualClock(ms), ...(log ? { log } : {}) };
}

async function collect(iterable: AsyncIterable<ProviderCostRecord>): Promise<ProviderCostRecord[]> {
  const out: ProviderCostRecord[] = [];
  for await (const record of iterable) out.push(record);
  return out;
}

function world() {
  const emu = new DoEmulator({ now: () => now });
  const billing = billingOf(emu);
  billing.preview = {
    invoice_uuid: 'preview-2026-10',
    invoice_id: 'preview',
    amount: '30.00',
    invoice_period: '2026-10',
    updated_at: '2026-10-05T11:00:00Z',
  };
  billing.invoices = [
    {
      invoice_uuid: 'inv-2026-09',
      invoice_id: '9',
      amount: '40.00',
      invoice_period: '2026-09',
      updated_at: '2026-10-01T06:00:00Z',
    },
    {
      invoice_uuid: 'inv-2026-08',
      invoice_id: '8',
      amount: '40.00',
      invoice_period: '2026-08',
      updated_at: '2026-09-01T06:00:00Z',
    },
  ];
  const ours = seedDroplet(emu.state, {
    tags: [
      'better-compute-managed:true',
      deploymentTag('default'),
      'better-compute-instance:inst_1',
      'better-compute-tenant:acme',
    ],
  });
  billing.items.set('preview-2026-10', [
    invoiceItem({
      resource_id: String(ours.id),
      amount: '0.89',
      duration: '108',
      end_time: '2026-11-01T00:00:00Z',
    }),
    invoiceItem({
      product: 'Volumes',
      resource_id: '',
      resource_uuid: 'vol-1',
      description: '100 GiB',
      amount: '1.20',
    }),
  ]);
  billing.items.set('inv-2026-09', [
    invoiceItem({
      resource_id: String(ours.id),
      amount: '5.00',
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-10-01T00:00:00Z',
    }),
  ]);
  billing.items.set('inv-2026-08', [
    invoiceItem({ start_time: '2026-08-01T00:00:00Z', end_time: '2026-09-01T00:00:00Z' }),
  ]);
  return { emu, billing, ours };
}

describe('costs', () => {
  it('is absent unless the account turns it on', async () => {
    const { emu } = world();
    const off = await build(emu, { token: 'secret://do/t', regions: ['nyc3'] });
    expect(off.costs).toBeUndefined();
    const on = await build(emu, account);
    expect(typeof on.costs).toBe('function');
  });

  it('maps the month-to-date items overlapping the window, with labels from the Droplet’s tags', async () => {
    const { emu, ours } = world();
    const compute = await build(emu, account);
    const records = await collect(compute.costs!(october, at(now)));
    expect(records).toHaveLength(2);
    const droplet = records.find((record) => record.service === 'Droplets')!;
    expect(droplet).toMatchObject({
      service: 'Droplets',
      sku: 'Droplets',
      skuDescription: 's-1vcpu-1gb',
      project: 'default',
      resourceName: String(ours.id),
      usageStart: Date.parse('2026-10-01T00:00:00Z'),
      // The preview's month is not over: usage ends at the read, never in the future.
      usageEnd: now,
      quantity: 108,
      unit: 'hours',
      costMicros: 890_000,
      creditsMicros: 0,
      currency: 'USD',
      labels: { 'better-compute-instance': 'inst_1', 'better-compute-tenant': 'acme' },
      exportTime: Date.parse('2026-10-05T11:00:00Z'),
    });
    expect(droplet.costType).toBeUndefined();
    expect(droplet.sourceRowId).toMatch(/^[0-9a-f]{64}$/);
    const volume = records.find((record) => record.service === 'Volumes')!;
    expect(volume).toMatchObject({ resourceName: 'vol-1', costMicros: 1_200_000, labels: {} });
  });

  it('reads only the invoices whose month overlaps the window', async () => {
    const { emu } = world();
    const compute = await build(emu, account);
    const window = { from: Date.parse('2026-09-29T00:00:00Z'), to: now };
    const records = await collect(compute.costs!(window, at(now)));
    expect(records.map((record) => record.costMicros).sort()).toEqual(
      [1_200_000, 5_000_000, 890_000].sort(),
    );
    const read = emu.requests.map((request) => request.url.pathname);
    expect(read).toContain('/v2/customers/my/invoices/inv-2026-09');
    expect(read).not.toContain('/v2/customers/my/invoices/inv-2026-08');
  });

  it('keeps a row’s id as the month to date grows, and lets the final invoice replace the preview', async () => {
    const { emu, billing } = world();
    const compute = await build(emu, account);
    const first = await collect(compute.costs!(october, at(now)));
    billing.items.get('preview-2026-10')![0]!.amount = '1.78';
    billing.items.get('preview-2026-10')![0]!.duration = '216';
    billing.preview!.updated_at = '2026-10-09T11:00:00Z';
    const later = Date.parse('2026-10-09T12:00:00Z');
    const second = await collect(compute.costs!({ from: october.from, to: later }, at(later)));
    const id = (records: ProviderCostRecord[]) => records.find((r) => r.service === 'Droplets')!;
    expect(id(second).sourceRowId).toBe(id(first).sourceRowId);
    expect(id(second)).toMatchObject({ costMicros: 1_780_000, quantity: 216 });
    expect(id(second).exportTime).toBeGreaterThan(id(first).exportTime);

    // The month closes: October's final invoice is listed and the preview moves on to November.
    billing.invoices.unshift({
      invoice_uuid: 'inv-2026-10',
      invoice_period: '2026-10',
      amount: '30',
      updated_at: '2026-11-01T06:00:00Z',
    });
    billing.items.set('inv-2026-10', [
      { ...billing.items.get('preview-2026-10')![0]!, amount: '5.00', duration: '744' },
    ]);
    billing.items.set('preview-2026-10', []);
    const closed = Date.parse('2026-11-02T00:00:00Z');
    const third = await collect(
      compute.costs!({ from: Date.parse('2026-10-25T00:00:00Z'), to: closed }, at(closed)),
    );
    expect(id(third).sourceRowId).toBe(id(first).sourceRowId);
    expect(id(third)).toMatchObject({
      costMicros: 5_000_000,
      usageEnd: Date.parse('2026-11-01T00:00:00Z'),
    });
  });

  it('keeps the row when the final invoice words an item differently from the preview', async () => {
    const { emu, billing } = world();
    const compute = await build(emu, account);
    const preview = await collect(compute.costs!(october, at(now)));
    const previewTotal = preview.reduce((total, r) => total + r.costMicros, 0);
    expect(previewTotal).toBe(2_090_000);
    // October closes; its final invoice describes both items differently (unverified at DigitalOcean, so the id
    // must not depend on it) and starts the Droplet's usage at another time.
    billing.invoices.unshift({
      invoice_uuid: 'inv-2026-10',
      invoice_period: '2026-10',
      amount: '2.09',
      updated_at: '2026-11-01T06:00:00Z',
    });
    const [droplet, volume] = billing.items.get('preview-2026-10')!;
    billing.items.set('inv-2026-10', [
      {
        ...droplet!,
        description: 's-1vcpu-1gb (final)',
        group_description: 'Droplets (October)',
        project_name: 'Renamed',
        category: 'iaas',
        start_time: '2026-10-01T00:30:00Z',
      },
      { ...volume!, description: '100 GiB volume', project_name: 'Renamed' },
    ]);
    billing.items.set('preview-2026-10', []);
    const closed = Date.parse('2026-11-02T00:00:00Z');
    const final = await collect(
      compute.costs!({ from: Date.parse('2026-10-25T00:00:00Z'), to: closed }, at(closed)),
    );
    // Upserted by id, the stored month is the final invoice's: the same ids, the same total, no row beside them.
    const stored = new Map(preview.map((r) => [r.sourceRowId, r]));
    for (const record of final) stored.set(record.sourceRowId, record);
    expect(new Set(final.map((r) => r.sourceRowId))).toEqual(new Set(stored.keys()));
    expect([...stored.values()].reduce((total, r) => total + r.costMicros, 0)).toBe(previewTotal);
  });

  it('prefers the final invoice when a month has both', async () => {
    const { emu, billing } = world();
    billing.invoices.unshift({
      invoice_uuid: 'inv-2026-10',
      invoice_period: '2026-10',
      amount: '1',
      updated_at: '2026-10-05T11:30:00Z',
    });
    billing.items.set('inv-2026-10', [invoiceItem({ amount: '2.00' })]);
    const compute = await build(emu, account);
    const records = await collect(compute.costs!(october, at(now)));
    expect(records.map((record) => record.costMicros)).toEqual([2_000_000]);
    expect(emu.requests.some((r) => r.url.pathname.endsWith('/preview-2026-10'))).toBe(false);
  });

  it('sums items that share an identity, and marks credits and taxes', async () => {
    const { emu, billing } = world();
    billing.items.set('preview-2026-10', [
      invoiceItem({ amount: '1.10', duration: '10' }),
      invoiceItem({ amount: '0.20', duration: '2' }),
      invoiceItem({
        product: 'Credits',
        resource_id: '',
        category: 'credit',
        description: 'promo',
        amount: '-3.00',
      }),
      invoiceItem({
        product: 'Taxes',
        resource_id: '',
        category: 'tax',
        description: 'VAT',
        amount: '0.40',
      }),
    ]);
    const compute = await build(emu, account);
    const records = await collect(compute.costs!(october, at(now)));
    expect(records.find((r) => r.service === 'Droplets')).toMatchObject({
      costMicros: 1_300_000,
      quantity: 12,
    });
    expect(records.find((r) => r.service === 'Credits')).toMatchObject({
      costMicros: -3_000_000,
      costType: 'adjustment',
    });
    expect(records.find((r) => r.service === 'Taxes')).toMatchObject({
      costMicros: 400_000,
      costType: 'tax',
    });
  });

  it('labels only Droplet items of this deployment; a deleted or foreign Droplet is named by id, for vps to resolve', async () => {
    const { emu, billing, ours } = world();
    const foreign = seedDroplet(emu.state, {
      tags: ['better-compute-instance:inst_x', 'better-compute-tenant:evil'],
    });
    billing.items.set('preview-2026-10', [
      invoiceItem({ resource_id: String(foreign.id), description: 'foreign' }),
      invoiceItem({ resource_id: '999999', description: 'deleted' }),
      invoiceItem({
        product: 'Snapshots',
        resource_id: String(ours.id),
        description: 'same id, not a Droplet',
      }),
    ]);
    const compute = await build(emu, account);
    const records = await collect(compute.costs!(october, at(now)));
    expect(records.map((record) => record.labels)).toEqual([{}, {}, {}]);
    // vps attributes by the Droplet id only against its own account's instances (a foreign one has none there);
    // a Snapshot's resource id is not a Droplet's.
    expect(records.map((record) => record.instanceExternalId)).toEqual([
      String(foreign.id),
      '999999',
      undefined,
    ]);
  });

  it('fails as PROVIDER_ERROR on an item it cannot read, rather than guessing', async () => {
    const { emu, billing } = world();
    billing.items.set('preview-2026-10', [invoiceItem({ amount: 'twelve' })]);
    const compute = await build(emu, account);
    await expect(collect(compute.costs!(october, at(now)))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: expect.objectContaining({ reason: 'malformedRow' }),
    });
    billing.items.set('preview-2026-10', [invoiceItem({ start_time: undefined })]);
    await expect(collect(compute.costs!(october, at(now)))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('refuses a scope it lacks as ACCESS_DENIED and never logs the token', async () => {
    const { emu } = world();
    const lines: string[] = [];
    const log: Logger = {
      debug: (...args) => void lines.push(JSON.stringify(args)),
      info: (...args) => void lines.push(JSON.stringify(args)),
      warn: (...args) => void lines.push(JSON.stringify(args)),
      error: (...args) => void lines.push(JSON.stringify(args)),
    };
    const compute = await build(emu, account, {}, { log });
    emu.failNext({ path: /^\/customers\/my\/invoices$/ }, 403, {
      id: 'forbidden',
      message: 'You are not authorized to perform this operation',
    });
    const error = await collect(compute.costs!(october, at(now, log))).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ACCESS_DENIED' });
    await collect(compute.costs!(october, at(now, log)));
    expect(JSON.stringify([lines, error, (error as Error).message])).not.toContain('do-token');
  });
});

describe('billing SKU matchers', () => {
  it('names Droplet rows as compute and volumes and reserved IPs as metered', () => {
    expect(digitaloceanProvider().billing).toBe(doBilling);
    const row = (service: string, sku = service) => ({ service, sku });
    expect(doBilling.computeSku(row('Droplets'))).toBe(true);
    expect(doBilling.computeSku(row('GPU Droplets'))).toBe(true);
    expect(doBilling.computeSku(row('Droplet Backups'))).toBe(false);
    expect(doBilling.computeSku(row('Volumes'))).toBe(false);
    expect(doBilling.meteredSku(row('Volumes'))).toBe(true);
    expect(doBilling.meteredSku(row('Reserved IPs'))).toBe(true);
    expect(doBilling.meteredSku(row('Spaces'))).toBe(false);
    // An invoice item is a month aggregate of hours, and DigitalOcean bills a powered-off Droplet.
    expect(doBilling.periodRows).toBe(true);
    expect(doBilling.billsStopped).toBe(true);
  });

  it('reads a pass-through pattern (empty service) the same way', () => {
    const probe = (pattern: string) => ({ service: '', sku: pattern, skuDescription: pattern });
    expect(doBilling.computeSku(probe('droplet'))).toBe(true);
    expect(doBilling.computeSku(probe('GPU Droplets'))).toBe(true);
    expect(doBilling.computeSku(probe('Droplet Backups'))).toBe(false);
    expect(doBilling.meteredSku(probe('volume'))).toBe(true);
    expect(doBilling.meteredSku(probe('reserved ip'))).toBe(true);
    expect(doBilling.computeSku(probe('Spaces'))).toBe(false);
    expect(doBilling.meteredSku(probe('Managed Databases'))).toBe(false);
  });
});
