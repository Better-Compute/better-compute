import { beforeEach, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  billingSummary,
  pricesOfSizes,
  probeAccount,
  type DoConfig,
  type DoSize,
} from '@better-compute/provider-digitalocean';
import { billingOf } from './support/do-emulator/billing.js';
import { DoEmulator } from './support/do-emulator/index.js';
import {
  build,
  ctx,
  doAccount,
  freshBudgets,
  noopLog,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// DigitalOcean P9 billing: list prices (whole Droplet sizes, D-ops-1), the account's balance and invoices, and the
// billing:read scope in the probe.

beforeEach(freshBudgets);

describe('listPrices', () => {
  it('lists one on-demand instance price per size and configured region, in micros per hour', async () => {
    const emu = new DoEmulator();
    const compute = await build(emu, { token: 'secret://do/t', regions: ['nyc3', 'tor1'] });
    const prices = await compute.listPrices({}, ctx());
    const s1 = prices.filter((price) => price.sku === 's-1vcpu-1gb');
    expect(s1).toEqual([
      {
        resource: 'instance',
        region: 'nyc3',
        offerId: 'nyc3/s-1vcpu-1gb',
        spot: false,
        unitPriceMicros: 7_440,
        unit: 'hour',
        currency: 'USD',
        sku: 's-1vcpu-1gb',
      },
      expect.objectContaining({ region: 'tor1', offerId: 'tor1/s-1vcpu-1gb' }),
    ]);
    // Only the account's regions: atl1 sizes are not listed; the 8-GPU size is one price, not per GPU.
    expect(prices.some((price) => price.region === 'atl1')).toBe(false);
    expect(prices.find((price) => price.sku === 'gpu-h100x8-640gb')).toMatchObject({
      region: 'tor1',
      unitPriceMicros: 23_920_000,
    });
    // No vCPU, memory or GPU parts are derived from a size price.
    expect(new Set(prices.map((price) => price.resource))).toEqual(new Set(['instance']));
  });

  it('narrows to the regions asked, and shares the offers catalog (one read for both)', async () => {
    const emu = new DoEmulator();
    const compute = await build(emu, { token: 'secret://do/t', regions: ['nyc3', 'tor1'] });
    await compute.listOffers({});
    const before = emu.requests.length;
    const prices = await compute.listPrices({ regions: ['tor1', 'sfo3'] }, ctx());
    expect(emu.requests.length).toBe(before);
    expect(new Set(prices.map((price) => price.region))).toEqual(new Set(['tor1']));
  });

  it('skips a size whose price is missing, zero or not a number (fail closed)', () => {
    const size = (slug: string, price: unknown): DoSize =>
      ({
        slug,
        memory: 1024,
        vcpus: 1,
        disk: 25,
        price_hourly: price,
        regions: ['nyc3'],
        available: true,
      }) as DoSize;
    const prices = pricesOfSizes(
      [size('a', 0), size('b', -1), size('c', 'x'), size('d', Number.NaN), size('e', 0.5)],
      ['nyc3'],
    );
    expect(prices.map((price) => price.sku)).toEqual(['e']);
    expect(prices[0]!.unitPriceMicros).toBe(500_000);
  });

  it('is UNAVAILABLE, not an empty list, when the sizes cannot be read', async () => {
    const emu = new DoEmulator();
    const compute = await build(emu, undefined, {}, { clock: manualClock(1_000_000) });
    emu.failNext({ method: 'GET', path: /^\/sizes$/ }, 503, {
      id: 'service_unavailable',
      message: 'x',
    });
    await expect(compute.listPrices({}, ctx())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

const probeContext = {
  clock: manualClock(1_000_000),
  secrets,
  log: noopLog,
  account: platformAccount,
};

describe('billingSummary', () => {
  it('reads the balance, the invoices and the month to date as micros of USD', async () => {
    const emu = new DoEmulator();
    const billing = billingOf(emu);
    billing.preview = {
      invoice_uuid: 'p',
      invoice_period: '2026-10',
      amount: '12.50',
      updated_at: '2026-10-05T11:00:00Z',
    };
    billing.invoices = [
      { invoice_uuid: 'i9', invoice_period: '2026-09', amount: '40.01' },
      { invoice_uuid: 'i8', invoice_period: '2026-08', amount: 'n/a' },
    ];
    billing.history = [
      {
        description: 'Invoice for September 2026',
        amount: '40.01',
        invoice_uuid: 'i9',
        date: '2026-10-01T00:00:00Z',
        type: 'Invoice',
      },
      {
        description: 'Payment (Visa 1234)',
        amount: '-40.01',
        date: '2026-10-02T00:00:00Z',
        type: 'Payment',
      },
    ];
    const summary = await billingSummary(doAccount as DoConfig, probeContext, { fetch: emu.fetch });
    expect(summary).toEqual({
      currency: 'USD',
      balance: {
        monthToDateBalanceMicros: 23_440_000,
        accountBalanceMicros: 12_230_000,
        monthToDateUsageMicros: 11_210_000,
        generatedAt: Date.parse('2026-10-05T12:00:00Z'),
      },
      monthToDate: {
        period: '2026-10',
        amountMicros: 12_500_000,
        updatedAt: Date.parse('2026-10-05T11:00:00Z'),
      },
      // An invoice whose amount is not a decimal is left out, never read as zero.
      invoices: [{ period: '2026-09', amountMicros: 40_010_000, uuid: 'i9' }],
      // Newest first.
      history: [
        {
          date: Date.parse('2026-10-02T00:00:00Z'),
          type: 'Payment',
          description: 'Payment (Visa 1234)',
          amountMicros: -40_010_000,
        },
        {
          date: Date.parse('2026-10-01T00:00:00Z'),
          type: 'Invoice',
          description: 'Invoice for September 2026',
          amountMicros: 40_010_000,
          invoiceUuid: 'i9',
        },
      ],
    });
    expect(emu.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('keeps the newest history entries only (at most 50)', async () => {
    const emu = new DoEmulator();
    billingOf(emu).history = Array.from({ length: 70 }, (_, i) => ({
      description: `row ${i}`,
      amount: '1.00',
      date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
      type: 'Invoice',
    }));
    const summary = await billingSummary(doAccount as DoConfig, probeContext, { fetch: emu.fetch });
    expect(summary.history).toHaveLength(50);
    expect(summary.history[0]!.description).toBe('row 69');
  });

  it('is ACCESS_DENIED without billing:read', async () => {
    const emu = new DoEmulator();
    emu.failNext({ path: /^\/customers\/my\/balance$/ }, 403, emu.error('forbidden').body);
    await expect(
      billingSummary(doAccount as DoConfig, probeContext, { fetch: emu.fetch }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});

describe('probeAccount operations', () => {
  it('probes the operations scopes only when asked, and names the missing ones', async () => {
    const emu = new DoEmulator();
    const plain = await probeAccount(doAccount as DoConfig, probeContext, { fetch: emu.fetch });
    expect(plain).not.toHaveProperty('operations');
    expect(emu.requests.some((r) => r.url.pathname.startsWith('/v2/customers/'))).toBe(false);

    emu.failNext({ path: /^\/customers\/my\/balance$/ }, 403, emu.error('forbidden').body);
    const report = await probeAccount(
      doAccount as DoConfig,
      probeContext,
      { fetch: emu.fetch },
      { operations: true },
    );
    expect(report.operations).toEqual({ billing: 'denied', projects: 'ok', monitoring: 'ok' });
    expect(report.missing).toEqual(['billing:read']);
  });
});
