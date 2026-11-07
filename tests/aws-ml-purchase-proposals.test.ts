import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { blockDurationHours, proposalQuery, purchaseProposalsWork, vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { CapacityEmulator } from './support/aws-emulator/capacity.js';

// AWS A10 calendar → Capacity Blocks: a capacity reservation booked ahead on a provider pool whose
// provider sells capacity ahead of time (an AWS platform account) and that the pool cannot place yet
// gets, 48 hours before it starts, a purchase proposal: the cheapest-waste Capacity Block offering that
// covers it. Nothing is bought: root reads the proposal (providerAccounts.purchaseProposals) and buys it
// through providerAccounts.purchaseReservation, confirmed, as any other purchase.

afterEach(closeFixtures);

type Api = any;
const HOUR = 3_600_000;
const ZONE = 'us-east-1a';

async function world() {
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
  const owner = root;
  const ownerTenant = tenants.root.id;
  const account = await api.providerAccounts.create(owner, {
    tenantId: ownerTenant,
    provider: 'aws',
    name: 'aws-use1',
    config: { region: 'us-east-1', zones: [ZONE], allowPurchases: true },
  });
  const site = await api.sites.create(owner, {
    tenantId: ownerTenant,
    kind: 'shared',
    region: 'us-east-1',
    idempotencyKey: 'aws-site',
  });
  const pool = await api.pools.create(owner, {
    tenantId: ownerTenant,
    siteId: site.id,
    class: 'provider',
    gpuModel: 'H100',
    providerAccountId: account.id,
    idempotencyKey: 'aws-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { gpu: 64, vcpu: 2048, memoryGiB: 16384, diskGiB: 100000 },
  });
  for (const flavor of [
    { name: 'm7i.large', vcpu: 2, memoryGiB: 8, diskGiB: 100, offerId: `${ZONE}/m7i.large` },
    {
      name: 'p5.48xlarge',
      vcpu: 192,
      memoryGiB: 2048,
      diskGiB: 1000,
      gpus: 8,
      offerId: `${ZONE}/p5.48xlarge`,
    },
  ])
    await api.flavors.create(owner, { tenantId: ownerTenant, poolId: pool.id, ...flavor });

  const t0 = fixture.clock.now();
  return {
    emu,
    capacity,
    fixture,
    api,
    root,
    acme,
    t0,
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    ownerTenant,
    owner,
    accountId: account.id as string,
    poolId: pool.id as string,
    /** Acme books `gpus` GPUs of the provider pool for `hours`, starting at `start`. */
    async reserve(key: string, start: number, gpus = 16, duration = '24h', extra: object = {}) {
      return api.reservations.create(acme, {
        tenantId: tenants.acme.id,
        poolId: pool.id,
        devices: [{ class: 'gpu', count: gpus }],
        start,
        duration,
        idempotencyKey: key,
        ...extra,
      });
    },
    async tick(advanceMs = 1_000) {
      await fixture.advance(advanceMs);
      for (let round = 0; round < 2; round++) await compute.jobs[purchaseProposalsWork]!.tick();
    },
    async proposals(who = root, tenantId = tenants.root.id) {
      return (
        await api.providerAccounts.purchaseProposals(who, { tenantId, accountId: account.id })
      ).items as any[];
    },
    async outbox(prefix: string) {
      const { rows } = await fixture.database.query<{ topic: string; payload: { data: any } }>(
        `SELECT topic, payload FROM outbox WHERE topic LIKE $1 ORDER BY seq`,
        [`${prefix}%`],
      );
      return rows.map((row) => ({ type: row.topic, data: row.payload.data }));
    },
  };
}

describe('calendar → Capacity Blocks (AWS A10)', () => {
  it('block durations are whole days up to 14 days, then whole weeks up to 182 days', () => {
    expect(blockDurationHours(1)).toBe(24);
    expect(blockDurationHours(24)).toBe(24);
    expect(blockDurationHours(25)).toBe(48);
    expect(blockDurationHours(14 * 24)).toBe(14 * 24);
    expect(blockDurationHours(14 * 24 + 1)).toBe(21 * 24);
    expect(blockDurationHours(182 * 24)).toBe(182 * 24);
    expect(blockDurationHours(182 * 24 + 1)).toBeUndefined();
  });

  it('asks for whole machines of the pool flavor that wastes the fewest GPUs, for the whole window', () => {
    const start = 100 * HOUR;
    const flavors = [
      { name: 'small', gpus: 1, offerId: `${ZONE}/g6.xlarge` },
      { name: 'big', gpus: 8, offerId: `${ZONE}/p5.48xlarge` },
      { name: 'reserved', gpus: 8, offerId: `${ZONE}/p5.48xlarge@cr-0123456789abcdef0` },
      { name: 'spot', gpus: 8, offerId: `${ZONE}/p5.48xlarge:spot` },
    ];
    const reservation = { start, end: start + 24 * HOUR, gpus: 16, machinesPer: 1 };
    expect(proposalQuery(reservation, flavors, 10 * HOUR)).toEqual({
      instanceType: 'p5.48xlarge',
      count: 2,
      durationHours: 48,
      earliestStart: start - 24 * HOUR,
      latestStart: start,
    });
    // 3 GPUs: three 1-GPU machines waste nothing; one 8-GPU machine wastes 5.
    expect(proposalQuery({ ...reservation, gpus: 3 }, flavors, 10 * HOUR)).toMatchObject({
      instanceType: 'g6.xlarge',
      count: 3,
    });
    // A gang of 4 members of 8 GPUs each: 4 machines.
    expect(
      proposalQuery({ ...reservation, gpus: 8, machinesPer: 4 }, flavors, 10 * HOUR),
    ).toMatchObject({
      instanceType: 'p5.48xlarge',
      count: 4,
    });
    // Starting within a day: the window opens now.
    expect(proposalQuery(reservation, flavors, start - 5 * HOUR)).toMatchObject({
      earliestStart: start - 5 * HOUR,
      durationHours: 48,
    });
    expect(proposalQuery(reservation, [flavors[2]!, flavors[3]!], 10 * HOUR)).toBeUndefined();
    expect(proposalQuery({ ...reservation, gpus: 0 }, flavors, 10 * HOUR)).toBeUndefined();
  });

  it('proposes the covering Capacity Block 48 hours before a pending reservation starts', async () => {
    const w = await world();
    const start = w.t0 + 72 * HOUR;
    const reservation = await w.reserve('r-1', start);
    expect(reservation.state).toBe('pending');
    // Earliest start in the window, the latest covering one wins (least capacity paid for before the
    // reservation starts); a block that ends before the reservation does is never proposed.
    w.capacity.blockOfferings.push(
      {
        id: 'cb-0aaaaaaaaaaaaaaa1',
        type: 'p5.48xlarge',
        zone: ZONE,
        count: 2,
        start: start - 20 * HOUR,
        hours: 48,
        upfrontFee: 2_000,
      },
      {
        id: 'cb-0aaaaaaaaaaaaaaa2',
        type: 'p5.48xlarge',
        zone: ZONE,
        count: 2,
        start: start - 4 * HOUR,
        hours: 48,
        upfrontFee: 2_500,
      },
      {
        id: 'cb-0aaaaaaaaaaaaaaa3',
        type: 'p5.48xlarge',
        zone: ZONE,
        count: 2,
        start: start - 30 * HOUR,
        hours: 48,
        upfrontFee: 1_000,
      },
    );

    // 72 h out: too early.
    await w.tick();
    expect(await w.proposals()).toEqual([]);

    // 47 h out.
    await w.tick(25 * HOUR);
    const [proposal, ...rest] = await w.proposals();
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      accountId: w.accountId,
      reservationId: reservation.id,
      poolId: w.poolId,
      tenantId: w.acmeTenant,
      state: 'proposed',
      startsAt: start,
      endsAt: start + 24 * HOUR,
      query: { instanceType: 'p5.48xlarge', count: 2, durationHours: 48 },
      offering: {
        instanceType: 'p5.48xlarge',
        zone: ZONE,
        count: 2,
        startsAt: start - 4 * HOUR,
        endsAt: start + 44 * HOUR,
        upfrontPrice: 2_500,
        currency: 'USD',
      },
    });
    expect(proposal.id).toMatch(/^ppro_/);
    expect(proposal.offering.id).toMatch(
      /^cb:us-east-1a\/p5\.48xlarge\/2\/48\/\d+\/250000\/cb-0aaaaaaaaaaaaaaa2$/,
    );
    expect(proposal.description).toContain('AWS Capacity Block: 2 × p5.48xlarge');
    expect(proposal.purchase).toBeUndefined();
    expect(await w.outbox('provider.purchase.')).toEqual([
      {
        type: 'provider.purchase.proposed',
        data: {
          accountId: w.accountId,
          proposalId: proposal.id,
          reservationId: reservation.id,
          poolId: w.poolId,
          offeringId: proposal.offering.id,
          startsAt: start - 4 * HOUR,
          upfrontPrice: 2_500,
          currency: 'USD',
        },
      },
    ]);

    // One proposal per reservation, however often the worker runs; nothing was bought.
    await w.tick(HOUR);
    expect(await w.proposals()).toHaveLength(1);
    expect(w.capacity.purchases).toEqual([]);

    // Root buys it as any purchase; the proposal shows the purchase.
    await w.api.providerAccounts.purchaseReservation(w.root, {
      tenantId: w.rootTenant,
      accountId: w.accountId,
      offeringId: proposal.offering.id,
      idempotencyKey: 'buy-proposal',
      confirm: true,
    });
    const [after] = await w.proposals();
    expect(after.purchase).toMatchObject({
      state: expect.stringMatching(/requested|purchasing|purchased/),
    });
    expect(after.purchase.id).toMatch(/^ppur_/);
  });

  it('records that nothing covers the reservation, once', async () => {
    const w = await world();
    const start = w.t0 + 30 * HOUR;
    const reservation = await w.reserve('r-1', start);
    // Only a block too short to cover it.
    w.capacity.blockOfferings.push({
      id: 'cb-0aaaaaaaaaaaaaaa1',
      type: 'p5.48xlarge',
      zone: ZONE,
      count: 2,
      start: start - 2 * HOUR,
      hours: 24,
      upfrontFee: 900,
    });
    await w.tick();
    const [proposal] = await w.proposals();
    expect(proposal).toMatchObject({
      reservationId: reservation.id,
      state: 'none',
      reason: 'no-offering',
    });
    expect(proposal.offering).toBeUndefined();
    expect(await w.outbox('provider.purchase.')).toEqual([]);
    await w.tick(HOUR);
    expect(await w.proposals()).toHaveLength(1);
  });

  it('records a pool with no GPU flavor it can buy as none, without asking the provider', async () => {
    const w = await world();
    const start = w.t0 + 30 * HOUR;
    await w.fixture.database.query(`UPDATE flavors SET archived = true WHERE gpus > 0`);
    const reservation = await w.reserve('r-1', start);
    await w.tick();
    expect(await w.proposals()).toMatchObject([
      { reservationId: reservation.id, state: 'none', reason: 'no-flavor' },
    ]);
    expect(w.emu.calls('DescribeCapacityBlockOfferings')).toEqual([]);
  });

  it('leaves placed, started, past and far reservations alone', async () => {
    const w = await world();
    await w.reserve('now', w.t0); // starts now (pending, but no longer ahead)
    await w.reserve('far', w.t0 + 100 * HOUR);
    const cancelled = await w.reserve('cancelled', w.t0 + 30 * HOUR);
    await w.api.reservations.cancel(w.acme, {
      tenantId: w.acmeTenant,
      reservationId: cancelled.id,
    });
    await w.tick();
    expect(await w.proposals()).toEqual([]);
  });

  it('only for the platform: a tenant account is never scanned, and only root reads proposals', async () => {
    // The account behind the pool is a tenant's (as if it changed hands): never scanned.
    const tenantWorld = await world();
    await tenantWorld.reserve('r-1', tenantWorld.t0 + 30 * HOUR);
    await tenantWorld.fixture.database.query(`UPDATE provider_accounts SET tenant_id = $1`, [
      tenantWorld.acmeTenant,
    ]);
    await tenantWorld.tick();
    const { rows } = await tenantWorld.fixture.database.query(
      `SELECT id FROM provider_purchase_proposals`,
    );
    expect(rows).toEqual([]);

    const w = await world();
    await w.reserve('r-1', w.t0 + 30 * HOUR);
    await w.tick();
    expect(await w.proposals()).toHaveLength(1);
    await expect(w.proposals(w.acme, w.acmeTenant)).rejects.toMatchObject({
      code: expect.stringMatching(/ACCESS_DENIED|NOT_FOUND/),
    });
  });

  it('a provider failure is retried on later passes, and gives up after five attempts', async () => {
    const w = await world();
    const start = w.t0 + 40 * HOUR;
    const reservation = await w.reserve('r-1', start);
    // Five failed attempts of r-1, then one of r-2 (a 400 the client does not retry itself).
    w.emu.failNext('DescribeCapacityBlockOfferings', 'InvalidParameterValue', 400, 6);
    await w.tick();
    const [first] = await w.proposals();
    expect(first).toMatchObject({ reservationId: reservation.id, state: 'error', attempts: 1 });
    expect(first.error.code).toBeTypeOf('string');
    expect(JSON.stringify(first.error)).not.toMatch(/secret|AKIA|Authorization/i);
    for (let pass = 0; pass < 8; pass++) await w.tick(20 * 60_000);
    const [last] = await w.proposals();
    expect(last).toMatchObject({ state: 'error', attempts: 5 });

    // Recovery before the attempts run out: a fresh reservation is proposed once the provider answers.
    const other = await w.reserve('r-2', start);
    await w.tick(20 * 60_000);
    w.capacity.blockOfferings.push({
      id: 'cb-0aaaaaaaaaaaaaaa1',
      type: 'p5.48xlarge',
      zone: ZONE,
      count: 2,
      start: start - 3 * HOUR,
      hours: 48,
      upfrontFee: 2_000,
    });
    await w.tick(20 * 60_000);
    const items = await w.proposals();
    expect(items.find((item) => item.reservationId === other.id)).toMatchObject({
      state: 'proposed',
      attempts: 2,
    });
  });
});
