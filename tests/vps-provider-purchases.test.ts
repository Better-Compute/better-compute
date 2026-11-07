import { afterEach, describe, expect, it } from 'vitest';
import type { SqlExecutor, SqlTx } from '@better-compute/core';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import {
  describePurchase,
  describePurchaseFor,
  preparePurchase,
  ProviderClients,
  reconcilePurchase,
  requestPurchase,
  vps,
  type PurchaseDeps,
} from '@better-compute/vps';
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

/**
 * Whether the calling code runs inside a transaction of `database`: a transaction-local setting
 * survives into the next statement only inside one.
 */
async function inTransaction(database: SqlExecutor): Promise<boolean> {
  await database.query(`SELECT set_config('bc_test.marker', 'set', true)`);
  const { rows } = await database.query<{ value: string | null }>(
    `SELECT current_setting('bc_test.marker', true) AS value`,
  );
  return rows[0]?.value === 'set';
}

/**
 * `database` whose transactions refuse the statements `refuses` picks (a lost lease: the fenced
 * executor refuses a stale run's writes; or the settle transaction failing), and run `before`
 * first in the same transaction (another run's write landing just before).
 */
function fenced(
  database: SqlExecutor,
  refuses: (text: string) => boolean,
  before?: (text: string, tx: SqlTx) => Promise<void>,
): SqlExecutor {
  const wrap = (tx: SqlTx) =>
    new Proxy(tx, {
      get(target, key) {
        if (key === 'query')
          return async (text: string, params?: unknown[]) => {
            if (refuses(text)) throw new Error('the write was refused: the lease was lost');
            await before?.(text, target);
            return target.query(text, params);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as SqlTx;
  return new Proxy(database, {
    get(target, key) {
      if (key === 'transaction')
        return (fn: (tx: SqlTx) => Promise<unknown>) => target.transaction((tx) => fn(wrap(tx)));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SqlExecutor;
}

const settlesPurchased = (text: string) => /SET state = 'purchased'/.test(text);
const claims = (text: string) => /attempts = attempts \+ 1/.test(text);

async function world(config: Record<string, unknown> = { allowPurchases: true }) {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const capacity = new CapacityEmulator(emu, ec2);
  /** Per AWS call: whether a transaction of the store was open (once the fixture exists). */
  const inTx: boolean[] = [];
  let database: SqlExecutor | undefined;
  const fetch: typeof emu.fetch = async (input, init) => {
    if (database) inTx.push(await inTransaction(database));
    return emu.fetch(input, init);
  };
  const aws = awsProvider({ fetch, credentials: emu.ambient });
  const fixture = await computeFixture({ clock: 'sim', modules: [vps({ providers: [aws] })] });
  database = fixture.database;
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
    aws,
    inTx,
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
    async events(prefix: string) {
      const { rows } = await fixture.database.query<{ topic: string; payload: { data: any } }>(
        `SELECT topic, payload FROM outbox WHERE topic LIKE $1 ORDER BY seq`,
        [`${prefix}%`],
      );
      return rows.map((row) => ({ type: row.topic, data: row.payload.data }));
    },
    async list() {
      return (await api.providerAccounts.purchases(root, ref)).items as any[];
    },
    /** Deps for calling the reconciler directly; what it publishes, enqueues and logs is kept. */
    direct(overrides: Partial<PurchaseDeps> = {}) {
      const published: { type: string; data: any }[] = [];
      const enqueued: string[] = [];
      const warnings: [string, unknown][] = [];
      const deps: PurchaseDeps = {
        clock: fixture.clock,
        events: {
          publish: async (_tx: unknown, event: any) => void published.push(event),
        } as any,
        work: { enqueue: async (_tx: unknown, kind: string) => void enqueued.push(kind) } as any,
        log: {
          debug() {},
          info() {},
          warn: (message: string, fields: unknown) => void warnings.push([message, fields]),
          error() {},
        },
        secrets: { resolve: async () => '' },
        clients: new ProviderClients(new Map([['aws', aws]])),
        rootTenantId: tenants.root.id,
        ...overrides,
      };
      return { deps, published, enqueued, warnings };
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
    // The request itself is refused: no row, no event, nothing for the worker.
    const w = await world({});
    const offering = block(await w.offerings());
    await expect(w.purchase(offering.id)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      details: { reason: 'purchases-unavailable' },
    });
    await w.work('vps.purchases');
    expect(await w.list()).toEqual([]);
    expect(await w.events('provider.purchase.')).toEqual([]);
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(0);
    expect(w.capacity.purchases).toEqual([]);
  });

  it('offerings are root-only, on platform accounts, read with no transaction open', async () => {
    const w = await world();
    w.inTx.length = 0;
    await w.offerings();
    expect(w.inTx.length).toBeGreaterThan(0);
    expect(new Set(w.inTx)).toEqual(new Set([false]));
    const query = { instanceType: 'p5.48xlarge', count: 1, durationHours: 24 };
    // A tenant may not list offerings (nor drive provider traffic with them).
    await expect(
      w.api.providerAccounts.reservationOfferings(w.acme, { ...w.ref, query }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    // Not even on its own account; nor root on a tenant's account.
    const tenantId = w.fixture.tenants.acme.id;
    const theirs = await w.api.providerAccounts.create(w.acme, {
      tenantId,
      provider: 'aws',
      name: 'acme-aws',
      config: {
        region: 'us-east-1',
        zones: ['us-east-1a'],
        assumeRoleArn: 'arn:aws:iam::333333333333:role/bc',
      },
    });
    w.inTx.length = 0;
    for (const who of [w.acme, w.root])
      await expect(
        w.api.providerAccounts.reservationOfferings(who, { tenantId, accountId: theirs.id, query }),
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(w.inTx).toEqual([]);
  });

  it('providerAccounts.offers reads the provider with no transaction open', async () => {
    const w = await world();
    w.inTx.length = 0;
    await w.api.providerAccounts.offers(w.root, { ...w.ref, query: {} });
    expect(w.inTx.length).toBeGreaterThan(0);
    expect(new Set(w.inTx)).toEqual(new Set([false]));
  });

  const loseFirstPurchase = (w: Awaited<ReturnType<typeof world>>) => {
    let lost = true;
    w.emu.afterAction('PurchaseCapacityBlock', () => {
      if (lost) {
        lost = false;
        throw new TypeError('fetch failed: connection reset');
      }
    });
  };

  it('a lost Capacity Block answer is never bought twice, nor reported failed', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    // EC2 could sell more blocks like it, and shows the one it sold only after a while (its tag
    // later still): the retries must find it rather than buy again.
    w.capacity.blockOfferings[0]!.stock = 5;
    w.capacity.purchaseLag = { hiddenReads: 6, tagsHiddenReads: 12 };
    loseFirstPurchase(w);
    await w.purchase(offering.id);
    for (let round = 0; round < 12; round++) {
      await w.work('vps.purchases');
      await w.fixture.advance(60_000);
    }
    const [purchase] = await w.list();
    expect(purchase).toMatchObject({
      state: 'purchased',
      reservationId: expect.stringMatching(/^cb:cr-/),
    });
    expect(purchase.attempts).toBeGreaterThan(2);
    expect(w.capacity.purchases).toHaveLength(1);
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(1);
    expect((await w.events('provider.purchase.')).map((e) => e.type)).toEqual([
      'provider.purchase.requested',
      'provider.purchase.completed',
    ]);
  });

  it('a lost answer whose block went off sale waits for the block rather than failing', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    // Sold out by this purchase itself; EC2 shows the block only after a few reads.
    w.capacity.purchaseLag = { hiddenReads: 6, tagsHiddenReads: 6 };
    loseFirstPurchase(w);
    await w.purchase(offering.id);
    for (let round = 0; round < 12; round++) {
      await w.work('vps.purchases');
      await w.fixture.advance(60_000);
    }
    expect(await w.list()).toMatchObject([{ state: 'purchased' }]);
    expect(w.capacity.purchases).toHaveLength(1);
    expect(await w.events('provider.purchase.failed')).toEqual([]);
  });

  it('attempts running out after a lost answer leave the purchase unknown, never failed', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    w.emu.afterAction('PurchaseCapacityBlock', () => {
      // EC2 bought; the answer is lost, and EC2 stops answering reads.
      w.emu.failNext('DescribeCapacityReservations', 'ServiceUnavailable', 503, 100_000);
      throw new TypeError('fetch failed: connection reset');
    });
    await w.purchase(offering.id);
    for (let round = 0; round < 30; round++) {
      await w.work('vps.purchases');
      await w.fixture.advance(16 * 60_000);
    }
    const [purchase] = await w.list();
    expect(purchase).toMatchObject({ state: 'unknown', attempts: 20 });
    expect(w.capacity.purchases).toHaveLength(1);
    expect((await w.events('provider.purchase.')).map((e) => e.type)).toEqual([
      'provider.purchase.requested',
      'provider.purchase.unknown',
    ]);
  });

  const signal = () => new AbortController().signal;
  const settle = async (w: Awaited<ReturnType<typeof world>>, rounds = 30) => {
    for (let round = 0; round < rounds; round++) {
      await w.work('vps.purchases');
      await w.fixture.advance(60_000);
    }
  };

  it('a settle that fails after EC2 sold the block never buys twice, nor reports failed', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    // EC2 could sell more blocks like it, and shows the one it sold (and later its tag) only after
    // a while.
    w.capacity.blockOfferings[0]!.stock = 5;
    w.capacity.purchaseLag = { hiddenReads: 6, tagsHiddenReads: 12 };
    const requested = await w.purchase(offering.id);
    // EC2 sells the block, then recording it fails (the settle transaction throws).
    const { deps } = w.direct();
    await expect(
      reconcilePurchase(deps, fenced(w.fixture.database, settlesPurchased), requested.id, signal()),
    ).rejects.toThrow(/refused/);
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(1);
    await settle(w);
    expect(await w.list()).toMatchObject([
      { state: 'purchased', reservationId: expect.stringMatching(/^cb:cr-/) },
    ]);
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(1);
    expect(w.capacity.purchases).toHaveLength(1);
    expect(await w.events('provider.purchase.failed')).toEqual([]);
  });

  it('a run that lost its lease after a lost answer never lets the next run buy twice', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    w.capacity.blockOfferings[0]!.stock = 5;
    w.capacity.purchaseLag = { hiddenReads: 6, tagsHiddenReads: 12 };
    loseFirstPurchase(w);
    const requested = await w.purchase(offering.id);
    // The claim commits; every later write of the run is refused (its lease expired), so nothing
    // records that the attempt may have bought.
    const { deps } = w.direct();
    const lost = fenced(
      w.fixture.database,
      (text) => /UPDATE provider_purchases/.test(text) && !claims(text),
    );
    await expect(reconcilePurchase(deps, lost, requested.id, signal())).rejects.toThrow(/refused/);
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(1);
    await settle(w);
    expect(await w.list()).toMatchObject([{ state: 'purchased' }]);
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(1);
    expect(await w.events('provider.purchase.failed')).toEqual([]);
  });

  it('a refusal after an attempt that may have bought leaves the purchase unknown', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    // The first attempt buys but its answer is lost; EC2 shows nothing for a long time.
    w.capacity.purchaseLag = { hiddenReads: 1_000, tagsHiddenReads: 1_000 };
    loseFirstPurchase(w);
    await w.purchase(offering.id);
    await w.work('vps.purchases');
    expect(await w.list()).toMatchObject([{ state: 'purchasing', attempts: 1 }]);
    // The second attempt is refused: the account's credentials stopped working.
    w.emu.failNext('DescribeCapacityReservations', 'AuthFailure', 401, 10);
    await w.fixture.advance(60_000);
    await w.work('vps.purchases');
    expect(await w.list()).toMatchObject([
      { state: 'unknown', attempts: 2, error: { code: 'UNAUTHENTICATED' } },
    ]);
    expect((await w.events('provider.purchase.')).map((e) => e.type)).toEqual([
      'provider.purchase.requested',
      'provider.purchase.unknown',
    ]);
    expect(w.capacity.purchases).toHaveLength(1);
  });

  it('an answer that is not readable after EC2 sold the block is retried, not failed', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    // EC2 answers PurchaseCapacityBlock with a state this code does not know.
    w.capacity.purchaseAnswerState = 'payment-processing';
    await w.purchase(offering.id);
    await settle(w, 4);
    expect(await w.list()).toMatchObject([{ state: 'purchased' }]);
    expect(w.capacity.purchases).toHaveLength(1);
    expect(await w.events('provider.purchase.failed')).toEqual([]);
  });

  it("the provider's answer is recorded even after another run settled the purchase", async () => {
    const w = await world();
    const offering = block(await w.offerings());
    const requested = await w.purchase(offering.id);
    // Another run (this one's lease had expired) settled it failed while EC2 was selling.
    const { deps, published, enqueued } = w.direct();
    const raced = fenced(
      w.fixture.database,
      () => false,
      async (text, tx) => {
        if (settlesPurchased(text))
          await tx.query(
            `UPDATE provider_purchases SET state = 'failed', error = '{"code":"CAPACITY_UNAVAILABLE","message":"gone"}'::jsonb WHERE id = $1`,
            [requested.id],
          );
      },
    );
    await reconcilePurchase(deps, raced, requested.id, signal());
    const [purchase] = await w.list();
    expect(purchase).toMatchObject({
      state: 'purchased',
      reservationId: expect.stringMatching(/^cb:cr-/),
    });
    expect(purchase.error).toBeUndefined();
    expect(published.map((e) => e.type)).toEqual(['provider.purchase.completed']);
    expect(enqueued).toEqual(['vps.reservations']);
  });

  it('an answer that cannot be recorded is logged for a person to reconcile', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    const requested = await w.purchase(offering.id);
    const { deps, warnings, published } = w.direct();
    // Another run recorded another reservation for this purchase.
    const raced = fenced(
      w.fixture.database,
      () => false,
      async (text, tx) => {
        if (settlesPurchased(text))
          await tx.query(
            `UPDATE provider_purchases SET state = 'purchased', reservation_id = 'cb:cr-0ther' WHERE id = $1`,
            [requested.id],
          );
      },
    );
    await reconcilePurchase(deps, raced, requested.id, signal());
    expect(published).toEqual([]);
    expect(warnings).toEqual([
      [
        'vps.purchase_unrecorded',
        { purchaseId: requested.id, reservationId: expect.stringMatching(/^cb:cr-/) },
      ],
    ]);
  });

  it('a reservation another purchase recorded is never recorded twice', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    w.capacity.blockOfferings[0]!.stock = 2;
    await w.purchase(offering.id);
    await w.work('vps.purchases');
    const [first] = await w.list();
    expect(first).toMatchObject({ state: 'purchased' });
    const second = await w.purchase(offering.id, { idempotencyKey: 'buy-2' });
    // The provider answers the second purchase with the first one's block (taken for its own).
    const attempts: any[] = [];
    const clients = {
      client: async () => ({
        purchaseReservation: async (_id: string, _context: unknown, attempt: unknown) => {
          attempts.push(attempt);
          return first.reservation;
        },
      }),
    } as any;
    const { deps, published, warnings } = w.direct({ clients });
    const next = await reconcilePurchase(deps, w.fixture.database, second.id, signal());
    expect(next).toBeGreaterThan(w.fixture.clock.now());
    expect(published).toEqual([]);
    expect(warnings.map(([message]) => message)).toEqual(['vps.purchase_duplicate']);
    let rows = (await w.list()).filter((p) => p.id === second.id);
    expect(rows).toMatchObject([{ state: 'purchasing' }]);
    expect(rows[0].reservationId).toBeUndefined();
    // The next attempt is uncertain (it may have bought) and leaves out what is recorded.
    await w.fixture.advance(60_000);
    await reconcilePurchase(deps, w.fixture.database, second.id, signal());
    expect(attempts[1]).toMatchObject({
      attempt: 2,
      uncertainSince: expect.any(Number),
      excludeReservationIds: [first.reservationId],
    });
    rows = (await w.list()).filter((p) => p.id === second.id);
    expect(rows[0].reservationId).toBeUndefined();
  });

  it('a provider account with a purchase in flight is not deleted; its purchases outlive it', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    const requested = await w.purchase(offering.id);
    await expect(w.api.providerAccounts.delete(w.root, w.ref)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { purchaseIds: [requested.id] },
    });
    await w.work('vps.purchases');
    expect(await w.list()).toMatchObject([{ state: 'purchased' }]);
    await w.api.providerAccounts.delete(w.root, w.ref);
    const { rows } = await w.fixture.database.query<{ state: string }>(
      'SELECT state FROM provider_purchases WHERE id = $1',
      [requested.id],
    );
    expect(rows).toEqual([{ state: 'purchased' }]);
  });

  it("the approver reads the account's own provider's description only", async () => {
    const w = await world();
    const offering = block(await w.offerings());
    const input = { ...w.ref, offeringId: offering.id, idempotencyKey: 'k', confirm: true };
    const other = { describeOffering: () => 'a free block, nothing to pay' };
    const providers = new Map<string, any>([
      ['other', other],
      ['aws', w.aws],
    ]);
    // Before the admission read the account, nothing describes the id.
    expect(describePurchaseFor(input, providers)).not.toContain('free block');
    await w.fixture.database.transaction((tx) =>
      preparePurchase(tx, input, { tenantId: w.ref.tenantId, identityId: 'idn_x' } as any),
    );
    const text = describePurchaseFor(input, providers);
    expect(text).toContain('1179.84 USD paid up front');
    expect(text).not.toContain('free block');
  });

  it('two requests racing on one key record one purchase', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    const first = await w.purchase(offering.id, { idempotencyKey: 'race-1' });
    const { rows } = await w.fixture.database.query<{ created_by: string }>(
      'SELECT created_by FROM provider_purchases WHERE id = $1',
      [first.id],
    );
    const caller = { tenantId: w.ref.tenantId, identityId: rows[0]!.created_by } as any;
    const published: unknown[] = [];
    const deps: PurchaseDeps = {
      clock: w.fixture.clock,
      events: {
        publish: async (_tx: unknown, event: unknown) => void published.push(event),
      } as any,
      work: { enqueue: async () => {} } as any,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      secrets: { resolve: async () => '' },
      clients: new ProviderClients(new Map([['aws', w.aws]])),
      rootTenantId: w.ref.tenantId,
    };
    // The second request looked the key up before the first committed: it misses the row.
    const second = await w.fixture.database.transaction((tx) => {
      let hide = true;
      const racing = new Proxy(tx, {
        get(target, key) {
          if (key === 'query')
            return (text: string, params?: unknown[]) => {
              if (hide && /FROM provider_purchases\s+WHERE tenant_id/.test(text)) {
                hide = false;
                return Promise.resolve({ rows: [] });
              }
              return target.query(text, params);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as SqlTx;
      return requestPurchase(
        deps,
        racing,
        { ...w.ref, offeringId: offering.id, idempotencyKey: 'race-1', confirm: true },
        caller,
      );
    });
    expect(second.id).toBe(first.id);
    expect(published).toEqual([]);
    expect(await w.list()).toHaveLength(1);
  });

  it('the approver reads what is bought, where, when and for how much', async () => {
    const w = await world();
    const offering = block(await w.offerings());
    const text = describePurchase(
      { ...w.ref, offeringId: offering.id, idempotencyKey: 'k', confirm: true },
      [w.aws],
    );
    expect(text).toContain('1 × p5.48xlarge in us-east-1a');
    expect(text).toContain(`from ${new Date(w.start).toISOString().replace('.000Z', 'Z')}`);
    expect(text).toContain('1179.84 USD paid up front');
    expect(text).toContain('spends money');
    const odcr = describePurchase(
      { ...w.ref, offeringId: 'odcr:us-east-1a/p5.48xlarge/2/48', idempotencyKey: 'k' },
      [w.aws],
    );
    expect(odcr).toContain('billed hourly at on-demand rates');
    expect(odcr).toContain('96 instance-hours');
    // An id no provider describes is shown as it is.
    expect(describePurchase({ ...w.ref, offeringId: 'x:1', idempotencyKey: 'k' })).toContain('x:1');
  });
});
