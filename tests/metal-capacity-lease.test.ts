import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capacityMigrations, capacityModule, reservationWork, type CapacityApi } from '@better-compute/capacity';
import type { Caller, MethodContext, SqlExecutor, SqlTx } from '@better-compute/core';
import { defineProfile } from '@better-compute/provision';
import { createMetalSim, simFirmware, type MetalSim } from './extensions/metal-sim.js';

// binding:'node' end to end (PLAN.md §10.5, §13, v0.5): capacity's real module and metal's real
// module on one simulated site, meeting only through rows and work (the contract agreed by
// [13084d] and [9e83b6]). A tenant reserves a whole machine; capacity places it, metal deploys the
// tenant's OS under tenant-controlled trust and marks it bound, the reservation goes active; on
// release metal tears it down and the machine is leasable again, under a new identity generation.

const SITE_AGENT = 'node_s1tea000000000000000000005';
// Capacity checks site ids strictly; the sim's own sites are named for readability.
const SITE = 'site_01jz000000000000000000e2e1';
const tenantOs = defineProfile({ id: 'acme-root-os', version: 1, target: 'metal', role: 'dedicated', steps: [{ use: 'power.setPower', with: { action: 'on' } }] });
const capacity = capacityModule({ random: () => 0, topN: 1 });
const acme: Caller = { identityId: 'usr_alice', identityKind: 'user', tenantId: 'acme', sessionId: 'ses_1', sessionKind: 'user', mfa: false };
const root: Caller = { ...acme, tenantId: 'root', identityId: 'usr_root' };

let sim: MetalSim;
let api: CapacityApi;
let poolId: string;

/** The executor a handler sees inside the envelope's transaction. */
function within(tx: SqlTx): SqlExecutor {
  return { ...sim.db, query: (text, params) => tx.query(text, params) } as SqlExecutor;
}

/** A capacity method as the envelope runs it (validate, prepare, handler), with IAM allowing. */
async function call(group: string, method: string, raw: unknown, who: Caller = acme): Promise<any> {
  const definition = (api as any)[group][method] as {
    validate(raw: unknown): unknown;
    handler(context: MethodContext, input: unknown): Promise<unknown>;
    admission?: { prepare(context: MethodContext, input: unknown, tx: SqlTx): Promise<{ status: string; result?: unknown }> };
  };
  const input = definition.validate(raw);
  const context = (tx: SqlTx) => ({ ...sim.context, sql: within(tx), caller: who, requestId: 'req_e2e' }) as MethodContext;
  if (definition.admission) {
    const plan = await sim.db.transaction((tx) => definition.admission!.prepare(context(tx), input, tx));
    if (plan.status === 'replay') return plan.result;
  }
  return sim.db.transaction((tx) => definition.handler(context(tx), input));
}

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [tenantOs], migrations: capacityMigrations, reconcilers: capacity.reconcilers });
  api = capacity.api!(sim.context) as CapacityApi;
  await sim.db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'eu', 1)`, [SITE]);
  await sim.addSiteAgent(SITE_AGENT, SITE);
  const pool = await call(
    'pools',
    'create',
    { tenantId: 'root', siteId: SITE, class: 'metal-host', gpuModel: 'H100', agent: 'bcd', policy: { tenantRoot: true, firmwareBaseline: simFirmware } },
    root,
  );
  poolId = pool.id;
  await call('pools', 'offer', { tenantId: 'root', poolId, toTenantId: 'acme', quota: { gpu: 64 } }, root);
});
afterAll(() => sim.close());

async function readyMachine(n: number): Promise<string> {
  const enrolled = await sim.call('enroll', {
    tenantId: 'root',
    siteId: SITE,
    poolId,
    bmc: { address: `https://10.15.0.${n}`, driver: 'redfish', credentials: `secret://root/bmc-${n}` },
  });
  await sim.settle();
  const nodeId = enrolled.nodeId as string;
  expect((await sim.state(nodeId)).provision_state).toBe('ready');
  // Inventory as the ramdisk reported it: eight GPUs.
  for (let i = 0; i < 8; i++)
    await sim.db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100"}')`,
      [`GPU-${nodeId.slice(-4)}-${i}`, nodeId],
    );
  return nodeId;
}

const reservation = async (id: string) => call('reservations', 'get', { tenantId: 'acme', reservationId: id });
const node = async (id: string) =>
  (
    await sim.db.query<{ provision_state: string; trust: string; identity_gen: number }>(
      'SELECT provision_state, trust, identity_gen FROM nodes WHERE id = $1',
      [id],
    )
  ).rows[0]!;

describe('binding: node, end to end', () => {
  it('leases a whole machine, deploys the tenant OS, activates, and returns the machine after a teardown', async () => {
    const machine = await readyMachine(1);
    const before = await node(machine);

    const created = await call('reservations', 'create', {
      tenantId: 'acme',
      poolId,
      devices: [{ class: 'gpu', count: 8 }],
      duration: '8h',
      binding: 'node',
      node: { profileId: 'acme-root-os', profileVersion: 1 },
      idempotencyKey: 'e2e-lease-1',
    });
    expect(created.state).toBe('placed');
    await sim.context.work.enqueue(sim.db, reservationWork, created.id);
    await sim.settle();

    // Capacity moved it to binding and woke metal; metal deployed and marked it bound; capacity activated it.
    expect((await reservation(created.id)).state).toBe('active');
    expect(await node(machine)).toMatchObject({ provision_state: 'deployed', trust: 'tenant-controlled' });
    const leased = await node(machine);
    expect(leased.identity_gen).toBeGreaterThan(before.identity_gen);

    // A second whole-node lease finds nothing leasable while this one runs.
    const second = await call('reservations', 'create', {
      tenantId: 'acme',
      poolId,
      devices: [{ class: 'gpu', count: 8 }],
      duration: '1h',
      binding: 'node',
      node: { profileId: 'acme-root-os', profileVersion: 1 },
      idempotencyKey: 'e2e-lease-2',
    });
    expect(second.state).toBe('pending');

    // Release: metal tears the machine down; once it is ready and platform-owned again, capacity
    // wakes the waiting lease, which gets the same machine, under yet another identity generation.
    await call('reservations', 'release', { tenantId: 'acme', reservationId: created.id });
    await sim.settle();
    expect((await reservation(created.id)).state).toBe('released');
    // One allocation per lease: the waiting lease was never moved or repaired off the machine.
    const allocations = await sim.db.query<{ first: boolean; released: boolean; bound: boolean }>(
      `SELECT a.owner_id = $2 AS first, a.released_at IS NOT NULL AS released, a.bound_at IS NOT NULL AS bound
         FROM allocations a WHERE a.node_id = $1 ORDER BY lower(a.during), a.id`,
      [machine, created.id],
    );
    expect(allocations.rows).toEqual([
      { first: true, released: true, bound: true },
      { first: false, released: false, bound: true },
    ]);
    const teardowns = await sim.db.query<{ state: string }>(
      `SELECT state FROM workflows WHERE node_id = $1 AND profile_id = 'metal-tenant-root-release'`,
      [machine],
    );
    expect(teardowns.rows).toEqual([{ state: 'succeeded' }]);
    const order = sim.events.filter((e) => e.data.nodeId === machine && e.type.startsWith('node.tenant-root.')).map((e) => e.type);
    expect(order).toEqual([
      'node.tenant-root.leased',
      'node.tenant-root.bound',
      'node.tenant-root.ending',
      'node.tenant-root.leased',
      'node.tenant-root.bound',
    ]);
    expect((await reservation(second.id)).state).toBe('active');
    const again = await node(machine);
    expect(again).toMatchObject({ provision_state: 'deployed', trust: 'tenant-controlled' });
    expect(again.identity_gen).toBeGreaterThan(leased.identity_gen + 1); // teardown (2) + the new lease (1)

    // And after the second lease ends, the machine is back in the pool, ready and platform-owned.
    await call('reservations', 'release', { tenantId: 'acme', reservationId: second.id });
    await sim.settle();
    expect(await node(machine)).toMatchObject({ provision_state: 'ready', trust: 'platform' });
  });
});
