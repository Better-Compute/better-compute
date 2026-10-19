import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock, type Credential, type SqlExecutor } from '@better-compute/core';
import {
  createEmbeddedTestIam,
  type EmbeddedTestIam,
  type TestMember,
} from '@better-compute/iam/testing';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { gcpProvider } from '@better-compute/provider-gcp';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { vps } from '@better-compute/vps';
import { billingRow, GceEmulator } from './support/gce-emulator.js';

// Platform compute billing, end to end (Task 24): one month of platform-issued compute on the real provider-gcp
// against the Compute Engine emulator (with its BigQuery billing export), metered by every source, flushed to a
// REAL better-iam (embedded, sharing the clock) and closed into statements there.
//
// The month is a fixed past 31-day month (2026-07, UTC), so the clock never runs ahead of the wall clock. Setup runs six hours
// before it starts: every interval is open by the first hour, so each resource bills whole hours of the month, except
// A's H100 VM, which A stops on day 11 at the time the scenario observes the stop. Everything expected below is
// computed from that timeline, never read back from compute's windows.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
const ZONE = 'us-central1-a';
const REGION = 'us-central1';
const base = 'https://compute.googleapis.com/compute/v1';
const EGRESS = 'network.egress.gib';
const MULTIPLIER = 1.25;
const instanceLabel = 'better-compute-instance';

/** The month under test: [P, E), July 2026 (31 days). */
const P = Date.UTC(2026, 6, 1);
const E = Date.UTC(2026, 7, 1);
const PERIOD = new Date(P).toISOString().slice(0, 7);
/** Hours in the month. */
const M = (E - P) / HOUR;
const clock = manualClock(P - 6 * HOUR);

/** List prices (micros per unit) and A's negotiated GPU price. */
const LIST = {
  'vm.vcpu.hours': 30_000,
  'vm.memory.gib.hours': 4_000,
  'vm.gpu.h100.hours': 3_000_000,
  'vm.instance.hours': 10_000,
  'vm.grant.slot.hours': 150_000,
  'network.vpc.hours': 20_000,
  'ip.public.hours': 5_000,
  'disk.pd-balanced.gib.hours': 100,
} as const;
const A_GPU = 2_500_000;
const A_DISCOUNT = 10;

/** better-iam's rounding: amounts to the micro (3 decimals of micros), invoice lines to the cent. */
const roundMicros = (value: number) => Math.round(value * 1000) / 1000;
const roundCents = (micros: number) => Math.round(micros / 10_000) * 10_000;
const micros = (cost: number) => Math.round(cost * 1e6);

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let emu: GceEmulator;
let api: any;
let root: Credential;
let R: string;
let A: string;
let B: string;
let accountId: string;
let poolId: string;
let aAdmin: TestMember;
let bAdmin: TestMember;

/** Instances of the scenario. */
const vm = { attached: '', h100: '', granted: '', b: '', root: '' };
/** When the poll that saw A's H100 VM stopped ran: its running interval ends there. */
let h100StoppedAt = 0;

/**
 * Egress export rows (all on A's instances): one in the previous month, which the export delivers after that month
 * closed (a late charge, in this month's first hour), and four in the month, the last in its last hour.
 */
const egressRows: { at: number; gib: number; cost: number; vm: 'h100' | 'granted' }[] = [
  { at: P - 2 * HOUR, gib: 4, cost: 0.48, vm: 'h100' },
  { at: P + DAY + 3 * HOUR, gib: 3, cost: 0.36, vm: 'h100' },
  { at: P + 5 * DAY + 14 * HOUR, gib: 7, cost: 0.84, vm: 'h100' },
  { at: P + 9 * DAY + 22 * HOUR, gib: 1, cost: 0.12, vm: 'h100' },
  { at: E - HOUR, gib: 2, cost: 0.24, vm: 'granted' },
];
/** Compute export rows: never passed through (compute is metered), only cost for margins. */
const computeRows: { at: number; cost: number; vm: keyof typeof vm | null }[] = [
  { at: P + 3 * DAY, cost: 0.4, vm: 'attached' },
  { at: P + 2 * DAY, cost: 0.5, vm: 'b' },
  { at: P + 4 * DAY, cost: 0.3, vm: 'root' },
  { at: P + 6 * DAY, cost: 0.7, vm: null },
];

async function moveTo(at: number): Promise<void> {
  if (at <= clock.now()) return;
  clock.set(at);
  await setSimClock(database, at);
}
async function tick(job: string, rounds = 2): Promise<void> {
  for (let round = 0; round < rounds; round++) await compute.jobs[job]!.tick();
}
/** Runs `vps.instances` every 5 s (GCE operations finishing in between) until the instance is in `state`. */
async function settle(tenantId: string, instanceId: string, state: string): Promise<any> {
  let current = await api.instances.get(root, { tenantId, instanceId });
  for (let round = 0; round < 12 && current.state !== state; round++) {
    emu.finishOperations();
    await moveTo(clock.now() + 5_000);
    await tick('vps.instances');
    current = await api.instances.get(root, { tenantId, instanceId });
  }
  expect(current.state).toBe(state);
  return current;
}
async function pendingWindows(): Promise<number> {
  const { rows } = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM usage_windows WHERE recorded_at IS NULL AND voided_at IS NULL`,
  );
  return rows[0]!.n;
}
/** Every metering source, then the flush to better-iam until nothing is pending. */
async function meterAll(): Promise<void> {
  await tick('vps.instances');
  await tick('vps.provider-usage');
  await tick('vps.grants');
  await tick('vps.ancillary-usage');
  await tick('vps.costs');
  for (let round = 0; round < 50 && (await pendingWindows()) > 0; round++)
    await tick('iam.usage', 1);
  expect(await pendingWindows()).toBe(0);
}

/** A new MFA session for the root administrator once the first one nears its 30 days (same credential object). */
async function renewRoot(): Promise<void> {
  const before = root.token;
  await t.renewRoot();
  expect(root.token).not.toBe(before);
  expect(await t.port.authenticate(root)).toMatchObject({ tenantId: R, mfa: true });
}

const exportLabels = (instanceId: string) => [{ key: instanceLabel, value: instanceId }];
const iso = (at: number) => new Date(at).toISOString();

let closed: any;
let statementOf: (tenantId: string) => Promise<any>;

beforeAll(async () => {
  emu = new GceEmulator();
  emu.validTokens.add('host-token');
  const gcp = gcpProvider({ fetch: emu.fetch, tokenSource: { token: async () => 'host-token' } });
  t = await createEmbeddedTestIam({
    now: () => clock.now(),
    // Sessions last better-iam's longest (30 days); root signs in again mid-month (renewRoot).
    iamOptions: {
      authentication: { sessionLifetimeMs: 30 * DAY, sessionIdleTimeoutMs: 30 * DAY },
    },
  });
  database = pglite();
  compute = betterCompute({
    database,
    iam: t.port,
    secret: 'better-compute-month-close-secret-0123456789',
    baseURL: 'http://127.0.0.1:3000',
    clock,
    modules: [
      ...t.bridge.modules,
      vps({
        providers: [gcp],
        discovery: { every: '1m' },
        reservations: { every: '1m' },
        billing: { currency: 'USD' },
      }),
    ],
  } as any);
  await compute.initialize();
  await useSimClock(database, clock.now());
  api = compute.api;
  root = t.root.credential;
  R = t.root.tenantId;
  A = t.acme.tenantId;
  B = t.other.tenantId;
  const everything = {
    version: 1 as const,
    statements: [{ effect: 'allow' as const, actions: ['compute:*'], resources: ['*'] }],
  };
  aAdmin = await t.acme.member('admin');
  await t.acme.grant(aAdmin.identityId, everything);
  aAdmin = { ...aAdmin, credential: await t.acme.signIn('admin') };
  bAdmin = await t.other.member('admin');
  await t.other.grant(bAdmin.identityId, everything);
  bAdmin = { ...bAdmin, credential: await t.other.signIn('admin') };

  // 1. The rate card: the catalog on better-iam's root, list prices from the month on, and the reported egress meter.
  await api.billing.syncMeters(root, {});
  await t.port.ensureMeters!([
    { key: EGRESS, name: 'Internet egress', unit: 'gib', pricing: 'reported' },
  ]);
  const prices = await api.billing.setPrices(root, {
    prices: [
      ...Object.entries(LIST).map(([meter, unitAmountMicros]) => ({
        meter,
        effectiveFrom: PERIOD,
        spec: { model: 'per-unit', unitAmountMicros },
      })),
      // 2. A's negotiated GPU price.
      {
        meter: 'vm.gpu.h100.hours',
        targetTenantId: A,
        effectiveFrom: PERIOD,
        spec: { model: 'per-unit', unitAmountMicros: A_GPU },
      },
    ],
  });
  expect(prices.failed).toEqual([]);
  // ... and A's contract discount (root administrators only, in better-iam).
  await t.iam.api.billing.setTerms(root, { tenantId: A, discountPercent: A_DISCOUNT });

  // 3. The platform's GCP account (with its billing export and an egress pass-through rule), a pool offered to A and B.
  const account = await api.providerAccounts.create(root, {
    tenantId: R,
    provider: 'gcp',
    name: 'gcp-platform',
    config: {
      projectId: 'p',
      zones: [ZONE],
      billingExport: emu.bigquery.table,
      billingExportLocation: 'US',
    },
    billing: { passThrough: [{ skuPattern: 'egress', meter: EGRESS, multiplier: MULTIPLIER }] },
  });
  accountId = account.id;
  const site = await api.sites.create(root, {
    tenantId: R,
    kind: 'shared',
    region: REGION,
    idempotencyKey: 'site',
  });
  poolId = (
    await api.pools.create(root, {
      tenantId: R,
      siteId: site.id,
      class: 'provider',
      providerAccountId: accountId,
      idempotencyKey: 'pool',
    })
  ).id;
  for (const toTenantId of [A, B])
    await api.pools.offer(root, {
      tenantId: R,
      poolId,
      toTenantId,
      quota: { vcpu: 1_000, memoryGiB: 10_000, diskGiB: 10_000, gpu: 16 },
    });
  await api.flavors.create(root, {
    tenantId: R,
    poolId,
    name: 'n2.standard.4',
    vcpu: 4,
    memoryGiB: 16,
    diskGiB: 100,
    offerId: `${ZONE}/n2-standard-4`,
  });
  await api.flavors.create(root, {
    tenantId: R,
    poolId,
    name: 'a3.highgpu.8g',
    vcpu: 208,
    memoryGiB: 1872,
    diskGiB: 100,
    gpus: 8,
    offerId: `${ZONE}/a3-highgpu-8g`,
  });
  // A 2-slot reservation, bound to the pool (its flavor is `rsv-rsv-a`).
  emu.reservations.push({
    kind: 'compute#reservation',
    name: 'rsv-a',
    zone: `${base}/projects/p/zones/${ZONE}`,
    selfLink: `${base}/projects/p/zones/${ZONE}/reservations/rsv-a`,
    status: 'READY',
    specificReservationRequired: true,
    specificReservation: {
      count: '2',
      inUseCount: '0',
      instanceProperties: { machineType: 'n2-standard-4' },
    },
  });
  await moveTo(clock.now() + MINUTE);
  await tick('vps.reservations');
  await api.providerAccounts.bindReservation(root, {
    tenantId: R,
    accountId,
    reservationId: `${ZONE}/rsv-a`,
    poolId,
    idempotencyKey: 'bind-rsv-a',
  });

  // 4. Root attaches a running VM (a 50 GiB pd-balanced boot disk, no public address) to A.
  emu.persistentDisks.set(`${ZONE}/legacy-boot`, { type: 'pd-balanced', sizeGb: '50' });
  emu.addInstance(ZONE, 'legacy', {
    disks: [
      {
        boot: true,
        type: 'PERSISTENT',
        diskSizeGb: '50',
        source: `${base}/projects/p/zones/${ZONE}/disks/legacy-boot`,
      },
    ],
  });
  await api.providerAccounts.discover(root, { tenantId: R, accountId });
  await moveTo(clock.now() + MINUTE);
  await tick('vps.discovery');
  vm.attached = (
    await api.instances.attach(root, {
      tenantId: A,
      poolId,
      externalId: `${ZONE}/legacy`,
      ownerIdentityId: aAdmin.identityId,
      idempotencyKey: 'attach-legacy',
    })
  ).id;
  // A creates an H100 VM and a network.
  const create = (who: Credential, tenantId: string, flavor: string, key: string) =>
    api.instances.create(who, {
      tenantId,
      poolId,
      flavor,
      imageId: 'debian-12',
      sshKeys: [],
      idempotencyKey: key,
    });
  vm.h100 = (await create(aAdmin.credential, A, 'a3.highgpu.8g', 'a-h100')).id;
  const network = await api.networks.create(aAdmin.credential, {
    tenantId: A,
    poolId,
    name: 'prod',
    idempotencyKey: 'a-net',
  });
  // Root grants A both reservation slots for the month; A's VM on the reservation joins the grant when it starts.
  const grant = await api.reservationGrants.create(root, {
    tenantId: R,
    accountId,
    reservationId: `${ZONE}/rsv-a`,
    grantTenantId: A,
    slots: 2,
    startsAt: P,
    endsAt: E,
    idempotencyKey: 'grant-a',
  });
  expect(grant.state).toBe('scheduled');
  vm.granted = (await create(aAdmin.credential, A, 'rsv-rsv-a', 'a-granted')).id;
  // 5. B creates one VM; root runs one of its own (within a quota of its own pool).
  vm.b = (await create(bAdmin.credential, B, 'n2.standard.4', 'b-vm')).id;
  for (const [resource, max] of [
    ['vcpu', 8],
    ['memoryGiB', 32],
    ['diskGiB', 200],
  ] as const)
    await api.quotas.set(root, { tenantId: R, poolId, resource, max });
  vm.root = (await create(root, R, 'n2.standard.4', 'root-vm')).id;

  for (const [tenantId, id] of [
    [A, vm.attached],
    [A, vm.h100],
    [A, vm.granted],
    [B, vm.b],
    [R, vm.root],
  ] as const)
    await settle(tenantId, id, 'running');
  for (let round = 0; round < 12; round++) {
    const view = await api.networks.get(root, { tenantId: A, networkId: network.id });
    if (view.state === 'ready') break;
    emu.finishOperations();
    await moveTo(clock.now() + 5_000);
    await tick('vps.networks');
  }
  expect(await api.networks.get(root, { tenantId: A, networkId: network.id })).toMatchObject({
    state: 'ready',
  });
  // Everything runs before the month starts.
  expect(clock.now()).toBeLessThan(P - HOUR);

  // 6. The billing export: egress labelled with A's instances, and compute rows for margins.
  const egressSku = {
    id: '984A-1F5A-A3D8',
    description: 'Network Internet Egress from Americas to EMEA',
  };
  for (const [index, row] of egressRows.entries())
    emu.bigquery.rows.push(
      billingRow({
        sku: egressSku,
        usage_start_time: iso(row.at),
        usage_end_time: iso(row.at + HOUR),
        export_time: iso(row.at + 2 * HOUR),
        labels: exportLabels(vm[row.vm]),
        resource: { name: `egress-${index}`, global_name: `//egress/${index}` },
        usage: {
          amount: row.gib,
          unit: 'gibibyte',
          amount_in_pricing_units: row.gib,
          pricing_unit: 'gibibyte',
        },
        price: {
          effective_price: 0.12,
          tier_start_amount: 0,
          unit: 'gibibyte',
          pricing_unit_quantity: 1,
        },
        cost: row.cost,
      }),
    );
  for (const [index, row] of computeRows.entries())
    emu.bigquery.rows.push(
      billingRow({
        usage_start_time: iso(row.at),
        usage_end_time: iso(row.at + HOUR),
        export_time: iso(row.at + 2 * HOUR),
        labels: row.vm ? exportLabels(vm[row.vm]) : [],
        resource: { name: `core-${index}`, global_name: `//core/${index}` },
        cost: row.cost,
      }),
    );

  // 7. The month. The grant starts (A's reservation VM joins it from P); then a pass of every source each day.
  await moveTo(P + MINUTE);
  await tick('vps.grants');
  expect((await api.reservationGrants.get(root, { tenantId: R, grantId: grant.id })).state).toBe(
    'active',
  );
  const stopAt = P + 10 * DAY + 6 * HOUR;
  for (let day = P + DAY; day <= E; day += DAY) {
    if (day > stopAt && h100StoppedAt === 0) {
      await moveTo(stopAt);
      await api.instances.stop(aAdmin.credential, { tenantId: A, instanceId: vm.h100 });
      await settle(A, vm.h100, 'stopped');
      h100StoppedAt = clock.now();
    }
    if (day === P + 15 * DAY) await renewRoot();
    await moveTo(day + 10 * MINUTE);
    await meterAll();
  }
  // Inside closeGraceHours (6) after the month, the last windows land (the export's last egress row among them,
  // still in its own month); past it, better-iam closes the month.
  await moveTo(E + 5 * HOUR);
  await meterAll();
  await moveTo(E + 7 * HOUR);
  closed = await t.iam.api.billing.closePeriod(root, { tenantId: R, period: PERIOD, draft: false });
  statementOf = async (tenantId: string) => {
    const issued = closed.issued.find((item: { accountId: string }) => item.accountId === tenantId);
    expect(issued, `a statement for ${tenantId}`).toBeDefined();
    return t.iam.api.billing.getStatement(root, { tenantId: R, statementId: issued.statementId });
  };
}, 600_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
  await database?.close();
});

interface Expected {
  quantity: number;
  /** Micros per unit; absent: unpriced (informational). */
  unit?: number;
  /** A reported meter's rated amount (before better-iam rounds the invoice line to the cent). */
  amountMicros?: number;
}

/** Usage lines of a statement by meter (each meter at most once). */
function linesOf(statement: { lines: any[] }): Map<string, any> {
  const usage = statement.lines.filter((line) => line.meter !== undefined);
  const byMeter = new Map(usage.map((line) => [line.meter as string, line]));
  expect(byMeter.size, 'one line per meter').toBe(usage.length);
  return byMeter;
}

function expectLines(statement: { lines: any[] }, expected: Record<string, Expected>): void {
  const lines = linesOf(statement);
  expect([...lines.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [meter, want] of Object.entries(expected)) {
    const line = lines.get(meter)!;
    expect(line.quantity, `${meter} quantity`).toBeCloseTo(want.quantity, 5);
    if (want.amountMicros !== undefined)
      expect(line.amountMicros, meter).toBe(roundCents(want.amountMicros));
    else if (want.unit !== undefined) {
      expect(line.unitAmountMicros, `${meter} unit price`).toBe(want.unit);
      expect(line.amountMicros, `${meter} amount`).toBe(
        roundCents(roundMicros(want.quantity * want.unit)),
      );
    } else {
      expect(line.unpriced, `${meter} unpriced`).toBe(true);
      expect(line.amountMicros).toBe(0);
    }
  }
}

/** Hours A's H100 VM ran in the month: from P until the poll that saw it stopped. */
const h100Hours = () => (h100StoppedAt - P) / HOUR;

/** A's month, from the timeline: the attached n2 (4 vCPU, 16 GiB, 50 GiB disk, no public address) all month, the
 * H100 VM (208 vCPU, 1872 GiB, 8 H100, 100 GiB disk, public address) running until its stop and keeping its disk
 * after it, the granted VM (100 GiB disk, public address) all month inside the 2-slot grant, the network all month,
 * and the egress rows at cost x multiplier: the month's, and the previous month's late one. */
function expectedA(): Record<string, Expected> {
  const h = h100Hours();
  const egress = egressRows.filter((row) => row.at < E);
  return {
    'vm.vcpu.hours': { quantity: 4 * M + 208 * h, unit: LIST['vm.vcpu.hours'] },
    'vm.memory.gib.hours': { quantity: 16 * M + 1872 * h, unit: LIST['vm.memory.gib.hours'] },
    'vm.gpu.h100.hours': { quantity: 8 * h, unit: A_GPU },
    'vm.instance.hours': { quantity: M + h, unit: LIST['vm.instance.hours'] },
    'vm.grant.slot.hours': { quantity: 2 * M, unit: LIST['vm.grant.slot.hours'] },
    'vm.grant.usage.hours': { quantity: M },
    'network.vpc.hours': { quantity: M, unit: LIST['network.vpc.hours'] },
    'ip.public.hours': { quantity: M + h, unit: LIST['ip.public.hours'] },
    'disk.pd-balanced.gib.hours': {
      quantity: (50 + 100 + 100) * M,
      unit: LIST['disk.pd-balanced.gib.hours'],
    },
    [EGRESS]: {
      quantity: egress.reduce((sum, row) => sum + row.gib, 0),
      amountMicros: egress.reduce((sum, row) => sum + Math.round(micros(row.cost) * MULTIPLIER), 0),
    },
  };
}

/** B's month: its one n2 VM (4 vCPU, 16 GiB, 100 GiB disk, public address) all month, at list prices. */
function expectedB(): Record<string, Expected> {
  return {
    'vm.vcpu.hours': { quantity: 4 * M, unit: LIST['vm.vcpu.hours'] },
    'vm.memory.gib.hours': { quantity: 16 * M, unit: LIST['vm.memory.gib.hours'] },
    'vm.instance.hours': { quantity: M, unit: LIST['vm.instance.hours'] },
    'ip.public.hours': { quantity: M, unit: LIST['ip.public.hours'] },
    'disk.pd-balanced.gib.hours': { quantity: 100 * M, unit: LIST['disk.pd-balanced.gib.hours'] },
  };
}

/** What better-iam's spend rates for a tenant (before the contract discount and cent rounding). */
function revenueOf(expected: Record<string, Expected>): number {
  return Object.values(expected).reduce(
    (sum, line) =>
      sum +
      (line.amountMicros ?? (line.unit === undefined ? 0 : roundMicros(line.quantity * line.unit))),
    0,
  );
}

describe('month close of platform-issued compute', () => {
  it('A’s statement has one line per meter, with the hours of the timeline', async () => {
    expect(h100StoppedAt).toBeGreaterThan(P + 10 * DAY + 6 * HOUR - MINUTE);
    const statement = await statementOf(A);
    expect(statement).toMatchObject({ period: PERIOD, periodStart: P, periodEnd: E });
    expectLines(statement, expectedA());
  });

  it('A’s amounts use its negotiated GPU price and its 10 % discount', async () => {
    const statement = await statementOf(A);
    const gpu = linesOf(statement).get('vm.gpu.h100.hours')!;
    expect(gpu.unitAmountMicros).toBe(A_GPU);
    expect(gpu.amountMicros).toBe(roundCents(roundMicros(8 * h100Hours() * A_GPU)));
    const subtotal = statement.lines.reduce(
      (sum: number, line: { amountMicros: number }) => sum + line.amountMicros,
      0,
    );
    expect(statement.subtotalMicros).toBe(subtotal);
    const discount = roundCents((subtotal * A_DISCOUNT) / 100);
    expect(statement.discount).toEqual({ percent: A_DISCOUNT, amountMicros: discount });
    expect(statement.totalMicros).toBe(subtotal - discount);
  });

  it('egress is the provider’s cost times the multiplier, with the previous month’s late row', async () => {
    const egress = linesOf(await statementOf(A)).get(EGRESS)!;
    expect(egress.pricing).toBe('reported');
    // 0.36 + 0.84 + 0.12 + 0.24 (the last hour of the month) = 1.56, plus the previous month's 0.48, exported
    // after that month closed (FW-4): 2.04 × 1.25.
    expect(egress.amountMicros).toBe(2_550_000);
    expect(egress.quantity).toBe(17);
    // The late row's window is this month's first hour; its stored usage start is its own hour.
    const { rows } = await database.query<{ start: number; usage: number }>(
      `SELECT (extract(epoch FROM w.window_start) * 1000)::float8 AS start,
              (extract(epoch FROM c.usage_start) * 1000)::float8 AS usage
         FROM usage_windows w JOIN provider_costs c ON c.pass_through_key = w.idempotency_key
        WHERE w.source_kind = 'cost' AND w.quantity = 4`,
    );
    expect(rows.map((row) => [Number(row.start), Number(row.usage)])).toEqual([[P, P - 2 * HOUR]]);
  });

  it('B’s statement has only its own VM, at list prices, with no discount', async () => {
    const statement = await statementOf(B);
    expectLines(statement, expectedB());
    expect(statement.discount).toBeUndefined();
    // Nothing of A's: no GPU, grant, network or egress line, and B's quantities above are its VM's alone.
  });

  it('root’s own usage is metered and recorded, but never invoiced', async () => {
    const { rows } = await database.query<{ outcome: string; n: number }>(
      `SELECT outcome, count(*)::int AS n FROM usage_windows
        WHERE tenant_id = $1 AND window_start >= to_timestamp($2::float8 / 1000)
          AND window_start < to_timestamp($3::float8 / 1000)
        GROUP BY outcome`,
      [R, P, E],
    );
    // Its n2 VM all month: vCPU, memory, instance, public address and disk hours.
    expect(rows).toEqual([{ outcome: 'recorded', n: 5 * M }]);
    expect(closed.issued.map((item: { accountId: string }) => item.accountId).sort()).toEqual(
      [A, B].sort(),
    );
    const listed = await t.iam.api.billing.listStatements(root, { tenantId: R, period: PERIOD });
    expect(listed.map((item: { tenantId: string }) => item.tenantId).sort()).toEqual([A, B].sort());
  });

  it('nothing was dead-lettered', async () => {
    expect((await api.usage.deadLetters(root, {})).items).toEqual([]);
  });

  it('margins per tenant are revenue minus the export’s cost', async () => {
    const result = await api.billing.margins(root, { from: P, to: E, groupBy: 'tenant' });
    expect(result).toMatchObject({ currency: 'USD', from: P, to: E });
    const inMonth = <T extends { at: number }>(rows: T[]) =>
      rows.filter((row) => row.at >= P && row.at < E);
    const costOf = (instances: string[]) =>
      inMonth(egressRows)
        .filter((row) => instances.includes(row.vm))
        .reduce((sum, row) => sum + micros(row.cost), 0) +
      inMonth(computeRows)
        .filter((row) => row.vm !== null && instances.includes(row.vm))
        .reduce((sum, row) => sum + micros(row.cost), 0);
    const rows = new Map(result.rows.map((row: { key: string }) => [row.key, row]));
    for (const row of result.rows)
      if (row.revenueMicros !== null)
        expect(row.marginMicros).toBeCloseTo(row.revenueMicros - row.costMicros, 3);
    const a: any = rows.get(A);
    const b: any = rows.get(B);
    expect(a.costMicros).toBe(costOf(['attached', 'h100', 'granted']));
    expect(b.costMicros).toBe(costOf(['b']));
    // Revenue is better-iam's spend: the rated usage, before A's contract discount and cent rounding.
    expect(Math.abs(a.revenueMicros - revenueOf(expectedA()))).toBeLessThan(10);
    expect(Math.abs(b.revenueMicros - revenueOf(expectedB()))).toBeLessThan(10);
    expect(a.marginMicros).toBeCloseTo(a.revenueMicros - a.costMicros, 3);
    expect(b.marginMicros).toBeCloseTo(b.revenueMicros - b.costMicros, 3);
    expect(result.unattributedCostMicros).toBe(micros(0.7));
    // Root's own usage is never revenue (better-iam never invoices the platform); its VM's cost stays.
    const r: any = rows.get(R);
    expect(r.revenueMicros).toBe(0);
    expect(r.costMicros).toBe(micros(0.3));
    expect(r.marginMicros).toBe(-micros(0.3));
  });
});
