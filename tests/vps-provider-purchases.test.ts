import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { CapacityEmulator } from './support/aws-emulator/capacity.js';

// AWS A3 purchases through vps: providerAccounts.reservationOfferings lists what an account could
// buy, and providerAccounts.purchaseReservation buys one, root-only, confirmed and exactly once (the
// vps.purchases worker buys outside any transaction with a key of its own). The real provider-aws
// against the emulator.

afterEach(closeFixtures);

type Api = any;
const HOUR = 3_600_000;

async function world(config: Record<string, unknown> = { allowPurchases: true }) {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const capacity = new CapacityEmulator(emu, ec2);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture = await computeFixture({ clock: 'sim', modules: [vps({ providers: [aws] })] });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'aws',
    name: 'aws-use1',
    config: { region: 'us-east-1', zones: ['us-east-1a'], ...config },
  });
  const start = fixture.clock.now() + 48 * HOUR;
  capacity.blockOfferings.push({
    id: 'cb-0aaaaaaaaaaaaaaa1',
    type: 'p5.48xlarge',
    zone: 'us-east-1a',
    count: 1,
    start,
    hours: 24,
    upfrontFee: 1_179.84,
  });
  const ref = { tenantId: tenants.root.id, accountId: account.id };
  return {
    emu,
    capacity,
    fixture,
    api,
    root,
    acme,
    ref,
    start,
    async work(job: string) {
      await fixture.advance(1_000);
      for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
    },
    offerings: async () =>
      (
        await api.providerAccounts.reservationOfferings(root, {
          ...ref,
          query: { instanceType: 'p5.48xlarge', count: 1, durationHours: 24 },
        })
      ).items as any[],
    purchase: (offeringId: string, extra: Record<string, unknown> = {}, who = root) =>
      api.providerAccounts.purchaseReservation(who, {
        ...ref,
        offeringId,
        idempotencyKey: 'buy-1',
        confirm: true,
        ...extra,
      }),
  };
}

const block = (items: any[]) => items.find((item) => item.id.startsWith('cb:'))!;

describe('provider capacity purchases', () => {
  it('lists what the account could buy', async () => {
    const w = await world();
    const items = await w.offerings();
    expect(items.map((item) => [item.id.split(':')[0], item.zone, item.upfrontPrice])).toEqual([
      ['odcr', 'us-east-1a', 0],
      ['cb', 'us-east-1a', 1_179.84],
    ]);
    expect(block(items)).toMatchObject({ startsAt: w.start, endsAt: w.start + 24 * HOUR });
    expect(w.capacity.purchases).toEqual([]);
  });

  it('purchase requires confirmation and is idempotent', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    await expect(w.purchase(offering.id, { confirm: undefined })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { reason: 'confirm-spend', offeringId: offering.id },
    });
    await expect(w.purchase(offering.id, { confirm: false })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    const requested = await w.purchase(offering.id);
    expect(requested).toMatchObject({ state: 'requested', offeringId: offering.id, attempts: 0 });
    // Nothing is bought inside the request: the worker buys.
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(0);
    await w.work('vps.purchases');
    const [done] = (await w.api.providerAccounts.purchases(w.root, w.ref)).items;
    expect(done).toMatchObject({
      id: requested.id,
      state: 'purchased',
      attempts: 1,
      reservationId: expect.stringMatching(/^cb:cr-/),
      reservation: { machineType: 'p5.48xlarge', total: 1, state: 'scheduled' },
    });
    expect(w.capacity.purchases).toEqual(['cb-0aaaaaaaaaaaaaaa1']);
    // A retry of the request replays the same purchase; the worker never buys again.
    const again = await w.purchase(offering.id);
    expect(again.id).toBe(requested.id);
    await w.work('vps.purchases');
    expect(w.capacity.purchases).toHaveLength(1);
    // The same key for another offering is a conflict.
    await expect(w.purchase('odcr:us-east-1a/p5.48xlarge/1/24')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // The reservations worker lists what was bought, so it can be bound.
    await w.work('vps.reservations');
    const reservations = (await w.api.providerAccounts.reservations(w.root, w.ref)).items;
    expect(reservations.map((r: any) => r.id)).toEqual([done.reservationId]);
  });

  it('a purchase whose attempt timed out is retried with the same key and buys once', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    // The purchase reaches EC2, which buys, but the answer is lost (the connection resets).
    let lost = true;
    w.emu.afterAction('PurchaseCapacityBlock', () => {
      if (lost) {
        lost = false;
        throw new TypeError('fetch failed: connection reset');
      }
    });
    await w.purchase(offering.id);
    await w.work('vps.purchases');
    let [purchase] = (await w.api.providerAccounts.purchases(w.root, w.ref)).items;
    expect(purchase).toMatchObject({ state: 'purchasing', attempts: 1 });
    // The retry finds the block the lost attempt bought by its purchase tag.
    await w.fixture.advance(60_000);
    await w.work('vps.purchases');
    [purchase] = (await w.api.providerAccounts.purchases(w.root, w.ref)).items;
    expect(purchase).toMatchObject({ state: 'purchased', attempts: 2 });
    expect(w.capacity.purchases).toHaveLength(1);
  });

  it('non-root purchase is ACCESS_DENIED', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    await expect(w.purchase(offering.id, {}, w.acme)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await expect(w.api.providerAccounts.purchases(w.acme, w.ref)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect((await w.api.providerAccounts.purchases(w.root, w.ref)).items).toEqual([]);
  });

  it("root never spends from a tenant's own provider account", async () => {
    const w = await world();
    const tenantId = w.fixture.tenants.acme.id;
    const theirs = await w.api.providerAccounts.create(w.acme, {
      tenantId,
      provider: 'aws',
      name: 'acme-aws',
      config: {
        region: 'us-east-1',
        zones: ['us-east-1a'],
        assumeRoleArn: 'arn:aws:iam::333333333333:role/bc',
        allowPurchases: true,
      },
    });
    await expect(
      w.api.providerAccounts.purchaseReservation(w.root, {
        tenantId,
        accountId: theirs.id,
        offeringId: 'odcr:us-east-1a/p5.48xlarge/1/24',
        idempotencyKey: 'buy-theirs',
        confirm: true,
      }),
    ).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      message: expect.stringContaining("platform's own provider accounts"),
    });
    await w.work('vps.purchases');
    expect(w.emu.calls('CreateCapacityReservation')).toHaveLength(0);
  });

  it('allowPurchases=false refuses', async () => {
    const w = await world({});
    const offering = block(await w.offerings());
    await w.purchase(offering.id);
    await w.work('vps.purchases');
    const [purchase] = (await w.api.providerAccounts.purchases(w.root, w.ref)).items;
    expect(purchase).toMatchObject({ state: 'failed', error: { code: 'ACCESS_DENIED' } });
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(0);
    expect(w.capacity.purchases).toEqual([]);
  });
});
