import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, type Site } from '@better-compute/core';
import { ACME, OTHER } from './support/server.js';
import { OUTSIDER, USER, type Harness } from './support/server-api.js';
import { seedJoinRequest, v02Harness } from './support/server-v02.js';

// `sites.update`/`sites.delete` and `nodes.delete` (PLAN.md §9.2, v0.2): deletes leave the projection,
// tombstone what audit rows and other tables reference, and release a node's capacity rows first.

let h: Harness;

beforeAll(async () => {
  h = await v02Harness();
  h.iam.allow({ token: USER });
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const projected = async (type: string, id: string) =>
  (await h.store.query('SELECT 1 FROM authz_projection WHERE type = $1 AND id = $2', [type, id])).rowCount;

describe('sites.update', () => {
  it('changes region labels with a version check and refreshes every viewer’s attributes', async () => {
    const site = await h.seed.site(ACME, { visibleTo: [ACME, OTHER] });
    const updated = await h.call<Site>('sites/update', USER, { tenantId: ACME, siteId: site, iamRegion: 'eu-central-1', version: 1 });
    expect(updated).toMatchObject({ id: site, region: 'eu-west-1', iamRegion: 'eu-central-1', version: 2 });
    expect(h.ports.authz.rows.map((row) => [row.tenantId, row.attributes])).toEqual([
      [ACME, { region: 'eu-west-1', kind: 'custom', iamRegion: 'eu-central-1' }],
      [OTHER, { region: 'eu-west-1', kind: 'custom', iamRegion: 'eu-central-1' }],
    ]);
    expect(h.ports.events.published.map((event) => event.type)).toEqual(['site.updated']);
    expect((await h.failure('sites/update', USER, { tenantId: ACME, siteId: site, region: 'us-east-1', version: 1 })).code).toBe('CONFLICT');
    const cleared = await h.call<Site>('sites/update', USER, { tenantId: ACME, siteId: site, clearIamRegion: true });
    expect(cleared.iamRegion).toBeUndefined();
    h.reset();
    // No change, no write.
    expect(await h.call('sites/update', USER, { tenantId: ACME, siteId: site, region: 'eu-west-1' })).toEqual(cleared);
    expect(h.ports.events.published).toEqual([]);
    for (const input of [{}, { iamRegion: 'x', clearIamRegion: true }, { region: 'EU' }])
      expect((await h.failure('sites/update', USER, { tenantId: ACME, siteId: site, ...input })).code).toBe('INVALID_INPUT');
  });
});

describe('sites.delete', () => {
  it('removes a site nothing referenced, and revokes its tokens', async () => {
    const site = await h.seed.site(ACME);
    await h.store.query(
      `INSERT INTO join_tokens (id, tenant_id, role, site_id, secret_hash, uses_left, allow_reclaim, expires_at)
       VALUES ($1, $2, 'site', $3, '\\x00', 1, false, compute_now() + interval '1 hour')`,
      [newId('jt'), ACME, site],
    );
    expect(await h.call('sites/delete', USER, { tenantId: ACME, siteId: site })).toEqual({ siteId: site, deleted: true, tombstoned: false });
    expect((await h.store.query('SELECT 1 FROM sites WHERE id = $1', [site])).rowCount).toBe(0);
    expect((await h.store.query('SELECT 1 FROM join_tokens WHERE site_id = $1 AND revoked_at IS NULL', [site])).rowCount).toBe(0);
    expect(await projected('site', site)).toBe(0);
    expect(h.ports.events.published.map((event) => event.type)).toEqual(['site.deleted']);
  });

  it('refuses a site with live pools or nodes, and tombstones one they referenced', async () => {
    const site = await h.seed.site(ACME);
    const pool = await h.seed.pool(ACME, site);
    const error = await h.failure('sites/delete', USER, { tenantId: ACME, siteId: site });
    expect(error.code).toBe('INVALID_STATE');
    expect(error.details).toEqual({ pools: 1, nodes: 0 });
    const request = await seedJoinRequest(h.store, { tenantId: ACME, siteId: site, hardwareKey: 'site-delete' });
    await h.store.query('UPDATE pools SET archived_at = compute_now() WHERE id = $1', [pool]);
    expect(await h.call('sites/delete', USER, { tenantId: ACME, siteId: site })).toEqual({ siteId: site, deleted: true, tombstoned: true });
    const { rows } = await h.store.query<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM sites WHERE id = $1', [site]);
    expect(rows[0]!.deleted).toBe(true);
    const { rows: requests } = await h.store.query<{ state: string }>('SELECT state FROM join_requests WHERE id = $1', [request]);
    expect(requests[0]!.state).toBe('expired');
    // A retry answers without deleting again; the deleted site is gone from reads.
    expect(await h.call('sites/delete', USER, { tenantId: ACME, siteId: site })).toEqual({ siteId: site, deleted: false, tombstoned: true });
    expect((await h.failure('sites/get', USER, { tenantId: ACME, siteId: site })).code).toBe('NOT_FOUND');
    expect((await h.failure('siteTokens/create', USER, { tenantId: ACME, siteId: site, ttlSeconds: 60, idempotencyKey: 'late' })).code).toBe(
      'INVALID_STATE',
    );
  });

  it("refuses other tenants' sites", async () => {
    const site = await h.seed.site(ACME);
    expect((await h.failure('sites/delete', OUTSIDER, { tenantId: ACME, siteId: site })).code).toBe('ACCESS_DENIED');
  });
});

describe('nodes.delete', () => {
  let site: string;
  let pool: string;
  beforeAll(async () => {
    site = await h.seed.site(ACME);
    pool = await h.seed.pool(ACME, site);
  });

  async function nodeWithCapacity(state: string) {
    const node = await h.seed.node(ACME, site, { poolId: pool, state });
    const device = newId('dev' as never);
    await h.store.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1, $2, 'gpu', true, true, '{}')`,
      [device, node],
    );
    await h.store.query(
      `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, 'vcpu', 64, 1, 0)`,
      [node],
    );
    await h.store.query(
      `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
       VALUES ($1, $2, 'node', 0, '\\x01', '\\x02', compute_now(), compute_now() + interval '1 day')`,
      [`serial-${node}`, node],
    );
    // Unique per node: the trusted hardware key and the binding subject are both unique columns.
    const digest = (label: string) => new Uint8Array(createHash('sha256').update(`${label}:${node}`).digest());
    await h.store.query(`INSERT INTO node_bindings (attestor, subject, node_id) VALUES ('tpm', $1, $2)`, [digest('ek'), node]);
    await h.store.query('UPDATE nodes SET hardware_key = $2, hardware_key_trusted = true WHERE id = $1', [node, digest('hk')]);
    return { node, device };
  }

  it('tombstones a retired node after releasing its capacity rows', async () => {
    const { node, device } = await nodeWithCapacity('retired');
    const deleted = await h.call('nodes/delete', USER, { tenantId: ACME, nodeId: node, reason: 'decommissioned' });
    expect(deleted).toEqual({ nodeId: node, deleted: true });
    const { rows } = await h.store.query<{ deleted: boolean; pool_id: string | null; trusted: boolean; identity_gen: number }>(
      'SELECT deleted_at IS NOT NULL AS deleted, pool_id, hardware_key_trusted AS trusted, identity_gen FROM nodes WHERE id = $1',
      [node],
    );
    expect(rows[0]).toEqual({ deleted: true, pool_id: null, trusted: false, identity_gen: 1 });
    expect((await h.store.query('SELECT 1 FROM node_resources WHERE node_id = $1', [node])).rowCount).toBe(0);
    expect((await h.store.query('SELECT 1 FROM node_bindings WHERE node_id = $1', [node])).rowCount).toBe(0);
    const { rows: devices } = await h.store.query<{ bookable: boolean }>('SELECT bookable FROM devices WHERE id = $1', [device]);
    expect(devices[0]!.bookable).toBe(false);
    const { rows: certs } = await h.store.query<{ reason: string }>('SELECT revocation_reason AS reason FROM node_certs WHERE node_id = $1', [node]);
    expect(certs).toEqual([{ reason: 'node-deleted' }]);
    expect(await projected('node', node)).toBe(0);
    expect(h.ports.events.published).toEqual([
      {
        type: 'node.deleted',
        tenantId: ACME,
        subject: `node/${node}`,
        data: { nodeId: node, poolId: pool, provisionState: 'retired', reason: 'decommissioned' },
      },
    ]);
    const { rows: rollup } = await h.store.query<{ total: string }>(
      `SELECT total::text FROM pool_capacity_rollup WHERE pool_id = $1 AND resource = 'gpu'`,
      [pool],
    );
    // The pool's only node left it: nothing counts toward its capacity any more.
    expect(rollup.every((row) => row.total === '0')).toBe(true);
    // Idempotent retry.
    expect(await h.call('nodes/delete', USER, { tenantId: ACME, nodeId: node })).toEqual({ nodeId: node, deleted: false });
  });

  it('deletes a cordoned adopted node (no retire workflow), freeing its EK binding for a rejoin', async () => {
    // e.g. the machine's TPM was replaced: the old identity must go so the machine can join anew.
    const { node } = await nodeWithCapacity('adopted');
    await h.store.query('UPDATE nodes SET cordoned = true WHERE id = $1', [node]);
    expect(await h.call('nodes/delete', USER, { tenantId: ACME, nodeId: node, reason: 'tpm replaced' })).toEqual({
      nodeId: node,
      deleted: true,
    });
    expect((await h.store.query('SELECT 1 FROM node_bindings WHERE node_id = $1', [node])).rowCount).toBe(0);
    const { rows: certs } = await h.store.query<{ reason: string }>('SELECT revocation_reason AS reason FROM node_certs WHERE node_id = $1', [node]);
    expect(certs).toEqual([{ reason: 'node-deleted' }]);
  });

  it('refuses nodes that are in service or hold allocations', async () => {
    const { node: live } = await nodeWithCapacity('adopted');
    const error = await h.failure('nodes/delete', USER, { tenantId: ACME, nodeId: live });
    expect(error.code).toBe('INVALID_STATE');
    expect(error.details).toEqual({ provisionState: 'adopted', cordoned: false });
    expect(error.message).toMatch(/Cordon the adopted node first/);

    const { node: busy } = await nodeWithCapacity('retired');
    await h.store.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
       VALUES ($1, $2, $3, $4, 'reservation', 'rsv_x', tstzrange(compute_now(), compute_now() + interval '1 hour'), 1)`,
      [newId('alloc'), ACME, pool, busy],
    );
    expect((await h.failure('nodes/delete', USER, { tenantId: ACME, nodeId: busy })).details).toEqual({ allocations: 1 });

    const { node: failedEarly } = await nodeWithCapacity('failed');
    await h.store.query(`UPDATE nodes SET failed_from = 'enrolling' WHERE id = $1`, [failedEarly]);
    expect(await h.call('nodes/delete', USER, { tenantId: ACME, nodeId: failedEarly })).toEqual({ nodeId: failedEarly, deleted: true });
    expect((await h.failure('nodes/delete', OUTSIDER, { tenantId: ACME, nodeId: live })).code).toBe('ACCESS_DENIED');
  });
});
