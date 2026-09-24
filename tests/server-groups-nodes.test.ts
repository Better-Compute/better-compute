import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ComputeEvent } from '@better-compute/core';
import type { NodeDetail, NodeInfo, RevokeIdentityResult } from '@better-compute/server';
import { ACME, OTHER, ROOT } from './support/server.js';
import { ADMIN, OUTSIDER, USER, serverHarness, type Harness } from './support/server-api.js';

// `nodes` (PLAN.md §9.2, module server): reads decided on the node (the list on the tenant, then
// per item), guarded updates with `version`, events, work for the node controllers, and the
// projection refresh when the lifecycle moves.

let h: Harness;
let site: string;
let pool: string;
beforeAll(async () => {
  h = await serverHarness();
  site = await h.seed.site(ACME);
  pool = await h.seed.pool(ACME, site);
  h.iam.allow({ token: USER });
  h.iam.allow({ token: ADMIN });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => h.reset());

const node = (options: Parameters<Harness['seed']['node']>[2] = {}) =>
  h.seed.node(ACME, site, { poolId: pool, ...options });
const change = <T = NodeInfo>(method: string, nodeId: string, input: object = {}) =>
  h.call<T>(`nodes/${method}`, USER, { tenantId: ACME, nodeId, ...input });

describe('reads', () => {
  it('gets a node with labels, conditions and session, decided on compute-node/{id}', async () => {
    const id = await node();
    await h.store.query(
      "INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, 'gpu.model', 'H100', 'inventory')",
      [id],
    );
    await h.store.query(
      `INSERT INTO node_conditions (node_id, type, status, reason, since)
       VALUES ($1, 'GpuCountMismatch', 'false', 'ok', '2026-01-01T00:00:00Z')`,
      [id],
    );
    const detail = await h.call<NodeDetail>('nodes/get', USER, { tenantId: ACME, nodeId: id });
    expect(detail).toMatchObject({
      id,
      siteId: site,
      poolId: pool,
      ownerTenantId: ACME,
      role: 'host',
      provisionState: 'adopted',
      cordoned: false,
      trust: 'tenant-owned',
      version: 1,
      labels: [{ key: 'gpu.model', value: 'H100', source: 'inventory' }],
      conditions: [
        { type: 'GpuCountMismatch', status: 'false', reason: 'ok', since: Date.UTC(2026, 0, 1) },
      ],
      session: { epoch: 0 },
    });
    expect(h.iam.calls[1]!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:nodes:read',
      resource: { type: 'compute-node', id },
    });
  });

  it('hides nodes the projection does not hold for the tenant, and outsiders get no further', async () => {
    const hidden = await node({ visible: false });
    expect((await h.failure('nodes/get', USER, { tenantId: ACME, nodeId: hidden })).code).toBe(
      'NOT_FOUND',
    );
    const visible = await node();
    expect((await h.failure('nodes/get', ADMIN, { tenantId: OTHER, nodeId: visible })).code).toBe(
      'NOT_FOUND',
    );
    h.reset();
    expect((await h.failure('nodes/get', OUTSIDER, { tenantId: ACME, nodeId: visible })).code).toBe(
      'ACCESS_DENIED',
    );
    expect(h.database.log).toEqual([]);
  });

  it('filters the list', async () => {
    const cordoned = await node({ cordoned: true });
    const page = await h.call<{ items: NodeInfo[] }>('nodes/list', USER, {
      tenantId: ACME,
      cordoned: true,
      poolId: pool,
    });
    expect(page.items.map((item) => item.id)).toContain(cordoned);
    expect(page.items.every((item) => item.cordoned)).toBe(true);
    const adopting = await h.call<{ items: NodeInfo[] }>('nodes/list', USER, {
      tenantId: ACME,
      provisionState: 'retired',
    });
    expect(adopting.items).toEqual([]);
    expect(
      (await h.failure('nodes/list', USER, { tenantId: ACME, provisionState: 'nope' })).code,
    ).toBe('INVALID_INPUT');
  });
});

describe('cordon, uncordon and drain', () => {
  it('cordons once, with a version bump, an event and work for the node controller', async () => {
    const id = await node();
    const cordoned = await change('cordon', id, { reason: 'bad fan' });
    expect(cordoned).toMatchObject({ id, cordoned: true, version: 2 });
    expect(h.iam.calls.at(-1)!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:nodes:cordon',
      resource: { type: 'compute-node', id },
    });
    expect(h.ports.events.published).toEqual([
      {
        type: 'node.cordoned',
        tenantId: ACME,
        subject: `node/${id}`,
        data: { nodeId: id, reason: 'bad fan' },
      },
    ]);
    expect(h.ports.work.enqueued).toEqual([{ kind: 'node', key: id }]);
    h.reset();
    // Cordoning a cordoned node changes nothing.
    expect(await change('cordon', id)).toMatchObject({ version: 2 });
    expect(h.ports.events.published).toEqual([]);
    const uncordoned = await change('uncordon', id);
    expect(uncordoned).toMatchObject({ cordoned: false, version: 3 });
    expect(h.iam.calls.at(-1)!.decision!.action).toBe('compute:nodes:cordon');
  });

  it('refuses a stale version with CONFLICT', async () => {
    const id = await node();
    const error = await h.failure('nodes/cordon', USER, { tenantId: ACME, nodeId: id, version: 7 });
    expect(error).toMatchObject({ code: 'CONFLICT', details: { version: 1 } });
    expect(await change('cordon', id, { version: 1 })).toMatchObject({ version: 2 });
  });

  it('drains: cordoned, marked draining, handed to the Drain controller; uncordon ends it', async () => {
    const id = await node({ reasons: ['taint:keep'] });
    const drained = await change('drain', id);
    expect(drained).toMatchObject({
      cordoned: true,
      noScheduleReasons: ['taint:keep', 'draining'],
    });
    expect(h.iam.calls.at(-1)!.decision!.action).toBe('compute:nodes:drain');
    expect(h.ports.work.enqueued).toEqual([
      { kind: 'node', key: id },
      { kind: 'drain', key: id },
    ]);
    expect(h.ports.events.published.map((event) => event.type)).toEqual(['node.draining']);
    const back = await change('uncordon', id);
    expect(back).toMatchObject({ cordoned: false, noScheduleReasons: ['taint:keep'] });
  });
});

describe('labels and taints', () => {
  it('sets and removes operator labels, never inventory ones', async () => {
    const id = await node();
    await h.store.query(
      "INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, 'gpu.product', 'H100-SXM5-80GB', 'inventory')",
      [id],
    );
    const labeled = await change<NodeDetail>('label', id, {
      set: { rack: 'r12', 'team/owner': 'ml' },
    });
    expect(labeled.labels).toEqual([
      { key: 'gpu.product', value: 'H100-SXM5-80GB', source: 'inventory' },
      { key: 'rack', value: 'r12', source: 'operator' },
      { key: 'team/owner', value: 'ml', source: 'operator' },
    ]);
    expect(labeled.version).toBe(2);
    expect(h.iam.calls.at(-1)!.decision!.action).toBe('compute:nodes:update');
    const removed = await change<NodeDetail>('label', id, { remove: ['rack', 'gpu.product'] });
    expect(removed.labels.map((label) => label.key)).toEqual(['gpu.product', 'team/owner']);
    const refused = await h.failure('nodes/label', USER, {
      tenantId: ACME,
      nodeId: id,
      set: { 'gpu.product': 'fake' },
    });
    expect(refused).toMatchObject({ code: 'INVALID_INPUT' });
    for (const input of [{}, { set: { 'bad key!': 'x' } }, { set: { a: 'x' }, remove: ['a'] }])
      expect(
        (await h.failure('nodes/label', USER, { tenantId: ACME, nodeId: id, ...input })).code,
      ).toBe('INVALID_INPUT');
  });

  it('adds and removes operator taints only', async () => {
    const id = await node({ reasons: ['unreachable'] });
    const tainted = await change('taint', id, { add: ['maintenance-window', 'dedicated=acme'] });
    expect(tainted.noScheduleReasons).toEqual([
      'unreachable',
      'taint:maintenance-window',
      'taint:dedicated=acme',
    ]);
    // `unreachable` is Liveness's: a taint of that name is another entry.
    const cleared = await change('taint', id, { remove: ['maintenance-window', 'unreachable'] });
    expect(cleared.noScheduleReasons).toEqual(['unreachable', 'taint:dedicated=acme']);
    expect(h.ports.events.published.map((event) => event.type)).toEqual([
      'node.tainted',
      'node.tainted',
    ]);
    h.reset();
    expect(await change('taint', id, { remove: ['never-set'] })).toMatchObject({
      version: cleared.version,
    });
    expect(h.ports.events.published).toEqual([]);
  });
});

describe('adopt and revokeIdentity', () => {
  it('re-runs acceptance from adopted, refreshing the projection row', async () => {
    const id = await node();
    const adopting = await change('adopt', id);
    expect(adopting).toMatchObject({ provisionState: 'adopting', version: 2 });
    expect(h.iam.calls.at(-1)!.decision!.action).toBe('compute:nodes:provision');
    expect(h.ports.authz.rows).toEqual([
      {
        type: 'node',
        id,
        tenantId: ACME,
        attributes: {
          region: 'eu-west-1',
          gpuCount: 0,
          lifecycle: 'adopting',
          trust: 'tenant-owned',
          gpuModel: 'H100',
        },
        parentType: 'pool',
        parentId: pool,
      },
    ]);
    expect(h.ports.work.enqueued).toEqual([{ kind: 'node', key: id }]);
    const deployed = await node({ state: 'deployed' });
    expect((await h.failure('nodes/adopt', USER, { tenantId: ACME, nodeId: deployed })).code).toBe(
      'INVALID_STATE',
    );
  });

  it('revokes every live certificate and moves to a new identity generation', async () => {
    const id = await node();
    for (const serial of ['s1', 's2'])
      await h.store.query(
        `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
         VALUES ($1, $2, 'node', 0, '\\x00', '\\x00', '2026-01-01', '2026-01-02')`,
        [serial, id],
      );
    const result = await change<RevokeIdentityResult>('revokeIdentity', id, {
      reason: 'stolen disk',
    });
    expect(result).toMatchObject({
      node: { identityGeneration: 1, version: 2 },
      revokedCertificates: 2,
    });
    expect(h.iam.calls.at(-1)!.decision!.action).toBe('compute:nodes:revoke-identity');
    const { rows } = await h.store.query<{ revocation_reason: string }>(
      'SELECT revocation_reason FROM node_certs WHERE node_id = $1 AND revoked_at IS NOT NULL',
      [id],
    );
    expect(rows).toEqual([
      { revocation_reason: 'stolen disk' },
      { revocation_reason: 'stolen disk' },
    ]);
    expect(h.ports.events.published).toEqual([
      {
        type: 'security.node.identity-revoked',
        tenantId: ACME,
        subject: `node/${id}`,
        data: { nodeId: id, identityGeneration: 1, revokedCertificates: 2, reason: 'stolen disk' },
      },
    ]);
  });
});

describe('events', () => {
  it('reads the node’s committed events in cursor order', async () => {
    const id = await node();
    await change('cordon', id);
    await change('uncordon', id);
    await change('taint', id, { add: ['x'] });
    const first = await h.call<{ items: ComputeEvent[]; cursor?: string }>('nodes/events', USER, {
      tenantId: ACME,
      nodeId: id,
      limit: 2,
    });
    expect(first.items.map((event) => event.type)).toEqual(['node.cordoned', 'node.uncordoned']);
    expect(first.items[0]).toMatchObject({
      tenantId: ACME,
      subject: `node/${id}`,
      time: '2026-01-01T00:00:00.000Z',
      sequence: expect.stringMatching(/^\d+:\d+$/),
      data: { nodeId: id },
    });
    expect(first.cursor).toBe(first.items[1]!.sequence);
    const rest = await h.call<{ items: ComputeEvent[]; cursor?: string }>('nodes/events', USER, {
      tenantId: ACME,
      nodeId: id,
      cursor: first.cursor,
    });
    expect(rest.items.map((event) => event.type)).toEqual(['node.tainted']);
    expect(rest.cursor).toBeUndefined();
    const typed = await h.call<{ items: ComputeEvent[] }>('nodes/events', USER, {
      tenantId: ACME,
      nodeId: id,
      type: 'node.un',
    });
    expect(typed.items.map((event) => event.type)).toEqual(['node.uncordoned']);
    void ROOT;
  });
});
