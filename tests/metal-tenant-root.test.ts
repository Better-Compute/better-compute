import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineProfile } from '@better-compute/provision';
import { metalWorkKind } from '@better-compute/metal';
import { createMetalSim, simFirmware, type MetalSim } from './extensions/metal-sim.js';

// Dedicated-root bare metal (PLAN.md §10.5 binding 'node', §13, v0.5) on the simulated site, with
// capacity's side (placement, bound → active, release) as the rows it writes. The v0.5 exit
// criterion: a dedicated-root lease and its release yield a new identity generation.

const SITE_AGENT = 'node_s1tea000000000000000000002';
const LESSEE = 'acme';

// The lessee's OS, deployed onto the whole machine.
const tenantOs = defineProfile({
  id: 'acme-root-os',
  version: 1,
  target: 'metal',
  role: 'dedicated',
  steps: [{ use: 'power.setPower', with: { action: 'on' } }],
});

let sim: MetalSim;
let n = 0;

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [tenantOs] });
  await sim.addSiteAgent(SITE_AGENT, 'site_a');
  await sim.db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_root', 'root', 'site_a', 'metal-dedicated', 'exclusive', 'bcd', $1::jsonb, 1),
            ('pool_plain', 'root', 'site_a', 'metal-host', 'exclusive', 'bcd', '{}', 1)`,
    [JSON.stringify({ tenantRoot: true, firmwareBaseline: simFirmware })],
  );
});
afterAll(() => sim.close());

async function readyNode(poolId = 'pool_root'): Promise<string> {
  const node = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId,
    bmc: { address: `https://10.12.0.${++n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  await sim.settle();
  expect((await sim.state(node.nodeId)).provision_state).toBe('ready');
  return node.nodeId;
}

/** Capacity placing a binding:'node' reservation on the node and reaching its start. */
async function lease(nodeId: string, poolId = 'pool_root', profile = { profileId: 'acme-root-os', profileVersion: 1 }) {
  const reservation = `rsv_${nodeId.slice(-8)}_${++n}`;
  const allocation = `alloc_${nodeId.slice(-8)}_${n}`;
  await sim.db.query(
    `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash, during, owner_identity_id, idempotency_key, version)
     VALUES ($1, $2, $3, 'binding', $4::jsonb, '\\x00', tstzrange(now() - interval '1 minute', now() + interval '8 hours'), 'id-acme', $1, 1)`,
    [reservation, LESSEE, poolId, JSON.stringify({ binding: 'node', devices: [{ class: 'gpu', count: 8 }], node: profile })],
  );
  await sim.db.query(
    `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
     VALUES ($1, $2, $3, $4, 'reservation', $5, tstzrange(now() - interval '1 minute', now() + interval '8 hours'), 1)`,
    [allocation, LESSEE, poolId, nodeId, reservation],
  );
  await sim.context.work.enqueue(sim.db, metalWorkKind, nodeId);
  await sim.settle();
  return { reservation, allocation };
}

/** Capacity releasing it (release, lapse or ends_at). */
async function endLease(nodeId: string, allocation: string) {
  await sim.db.query('UPDATE allocations SET released_at = now() WHERE id = $1', [allocation]);
  await sim.context.work.enqueue(sim.db, metalWorkKind, nodeId);
  await sim.settle();
}

const nodeRow = async (id: string) =>
  (
    await sim.db.query<{ trust: string; identity_gen: number; role: string; tenant_root: boolean; lease: string | null; last_error: any }>(
      `SELECT n.trust, n.identity_gen, n.role, m.tenant_root, m.lease_allocation_id AS lease, m.last_error
         FROM nodes n JOIN metal_nodes m ON m.node_id = n.id WHERE n.id = $1`,
      [id],
    )
  ).rows[0]!;
const liveCerts = async (id: string) =>
  (await sim.db.query<{ role: string }>('SELECT role FROM node_certs WHERE node_id = $1 AND revoked_at IS NULL', [id])).rows.map((r) => r.role);

describe('a dedicated-root lease', () => {
  it('deploys the lessee’s profile under tenant-controlled trust, and marks the allocation bound', async () => {
    const node = await readyNode();
    const before = await nodeRow(node);
    expect(before).toMatchObject({ trust: 'platform', tenant_root: false, lease: null });
    const { allocation, reservation } = await lease(node);

    expect(await sim.state(node)).toMatchObject({ provision_state: 'deployed', role: 'dedicated', maintenance: false });
    const leased = await nodeRow(node);
    expect(leased).toMatchObject({ trust: 'tenant-controlled', tenant_root: true, lease: allocation });
    expect(leased.identity_gen).toBe(before.identity_gen + 1);
    // The platform identity is gone before any tenant code runs.
    expect(await liveCerts(node)).not.toContain('node');
    const { rows } = await sim.db.query<{ bound: boolean; binding: unknown }>('SELECT bound_at IS NOT NULL AS bound, binding FROM allocations WHERE id = $1', [
      allocation,
    ]);
    expect(rows[0]).toEqual({ bound: true, binding: { node: true } });
    const workflows = await sim.db.query<{ tenant_id: string }>(`SELECT tenant_id FROM workflows WHERE node_id = $1 AND profile_id = 'acme-root-os'`, [node]);
    expect(workflows.rows).toEqual([{ tenant_id: LESSEE }]);
    expect(sim.events.map((e) => e.type)).toEqual(expect.arrayContaining(['node.tenant-root.leased', 'node.tenant-root.bound']));
    expect(sim.events.find((e) => e.type === 'node.tenant-root.leased')!.data).toMatchObject({ reservationId: reservation, lesseeTenantId: LESSEE });

    // The release is the §13 teardown, ending in a new identity generation and platform trust.
    await endLease(node, allocation);
    expect(await sim.state(node)).toMatchObject({ provision_state: 'ready', maintenance: false });
    const after = await nodeRow(node);
    expect(after).toMatchObject({ trust: 'platform', tenant_root: false, lease: null });
    expect(after.identity_gen).toBeGreaterThan(leased.identity_gen);
    const teardown = await sim.db.query<{ action: string; result: any }>(
      `SELECT s.action, s.result FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
        WHERE w.node_id = $1 AND w.profile_id = 'metal-tenant-root-release' AND s.phase = 'main' ORDER BY s.index`,
      [node],
    );
    expect(teardown.rows.map((row) => row.action)).toEqual([
      'power.setPower',
      'metal.fenceTenant',
      'metal.rotateBmcCredential',
      'metal.ensureRamdisk',
      'disk.wipe',
      'diag.dcgm',
      'metal.firmwareCheck',
      'metal.exitTenantRoot',
      'power.setPower',
    ]);
    expect(teardown.rows.find((row) => row.action === 'disk.wipe')!.result).toMatchObject({ mode: 'secure-erase', attested: true });
    expect(teardown.rows.find((row) => row.action === 'metal.firmwareCheck')!.result).toEqual({ verified: 3 });
  });

  it('quarantines a machine whose firmware drifted during the lease', async () => {
    const node = await readyNode();
    const { allocation } = await lease(node);
    sim.machineOf(node).firmware.bios = '2.4.1-tampered';
    await endLease(node, allocation);
    expect(await sim.state(node)).toMatchObject({ provision_state: 'failed', failed_from: 'releasing', maintenance: true });
    const row = await nodeRow(node);
    expect(JSON.stringify(row.last_error)).toContain('bios');
    // Still tenant-root: only a completed teardown clears it.
    expect(row).toMatchObject({ tenant_root: true, trust: 'tenant-controlled' });
  });

  it('rotates the BMC password the lessee may have seen, and quarantines when it cannot', async () => {
    const node = await readyNode();
    const first = await lease(node);
    await endLease(node, first.allocation);
    expect((await sim.state(node)).provision_state).toBe('ready');
    const { rows } = await sim.db.query<{ state: string }>('SELECT state FROM bmc_credential_versions WHERE node_id = $1 ORDER BY version', [node]);
    expect(rows.map((row) => row.state)).toEqual(['superseded', 'current']);

    const second = await lease(node);
    sim.faults.rotateRejected = true;
    try {
      await endLease(node, second.allocation);
    } finally {
      sim.faults.rotateRejected = false;
    }
    expect(await sim.state(node)).toMatchObject({ provision_state: 'failed', failed_from: 'releasing', maintenance: true });
  });

  it("never lets the lessee's own identity attest the wipe that ends its lease", async () => {
    const node = await readyNode();
    const { allocation } = await lease(node);
    // The lessee's OS got a node-tenant certificate for this node; it signs the "wipe result".
    sim.faults.signWith = await sim.issueNodeCert(node, 'node-tenant');
    try {
      await endLease(node, allocation);
    } finally {
      sim.faults.signWith = undefined;
    }
    expect(await sim.state(node)).toMatchObject({ provision_state: 'failed', failed_from: 'releasing' });
  });

  it('ignores node bindings in pools without tenantRoot, and refuses a lease without a profile', async () => {
    const plain = await readyNode('pool_plain');
    await lease(plain, 'pool_plain');
    expect((await sim.state(plain)).provision_state).toBe('ready');
    expect((await nodeRow(plain)).trust).toBe('platform');

    const node = await readyNode();
    await lease(node, 'pool_root', { profileId: '', profileVersion: 0 });
    expect((await sim.state(node)).provision_state).toBe('ready');
    expect(sim.events.some((e) => e.type === 'node.tenant-root.refused' && e.data.nodeId === node)).toBe(true);
  });

  it('a failed deploy still tears down as tenant-root after recover', async () => {
    const node = await readyNode();
    sim.faults.siteAgentDown = true; // the lessee deploy cannot reach the BMC…
    const { allocation } = await lease(node);
    await sim.call('abort', { tenantId: 'root', nodeId: node });
    sim.faults.siteAgentDown = false;
    await sim.settle();
    expect(await sim.state(node)).toMatchObject({ provision_state: 'failed', failed_from: 'deploying' });
    await sim.db.query('UPDATE allocations SET released_at = now() WHERE id = $1', [allocation]);
    await sim.call('recover', { tenantId: 'root', nodeId: node });
    await sim.settle();
    expect(await sim.state(node)).toMatchObject({ provision_state: 'ready' });
    const profiles = await sim.db.query<{ profile_id: string }>(`SELECT profile_id FROM workflows WHERE node_id = $1 ORDER BY created_at, id`, [node]);
    expect(profiles.rows.map((row) => row.profile_id)).toContain('metal-tenant-root-release');
    expect(await nodeRow(node)).toMatchObject({ trust: 'platform', tenant_root: false });
  });
});
