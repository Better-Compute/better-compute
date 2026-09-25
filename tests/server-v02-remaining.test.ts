import { afterEach, describe, expect, it } from 'vitest';
import { shardOf } from '@better-compute/core';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';

// The last §9.2 v0.2 rows of module `server`: projects.archive, commands.cancel and usage.export.

afterEach(closeFixtures);

const NODE = 'node_01k5w00000000000000000v2r1';

async function setup() {
  const fixture = await computeFixture({ clock: 'sim' });
  const root = fixture.tenants.root;
  const acme = fixture.tenants.acme;
  fixture.iam.allow({ token: root.token });
  fixture.iam.allow({ token: acme.token });
  await fixture.database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_v2r', $1, 'shared', 'eu-1', 1)`,
    [root.id],
  );
  await fixture.database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_v2r', $1, 'site_v2r', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [root.id],
  );
  await fixture.database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
       next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_v2r', 'pool_v2r', $2, 'host', 'adopted', false, false, 'connected',
       'platform', '{}', 1, 1, 1, 1, $3, 1)`,
    [NODE, root.id, shardOf(NODE)],
  );
  await fixture.database.query(
    'INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)',
    [NODE],
  );
  await fixture.database.query(
    "INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, $2, '{}')",
    [NODE, root.id],
  );
  return fixture;
}

describe('projects.archive', () => {
  it('archives once, publishes project.archived, and returns an archived project unchanged', async () => {
    const fixture = await setup();
    const acme = { token: fixture.tenants.acme.token };
    const tenantId = fixture.tenants.acme.id;
    const api = fixture.compute.api as any;
    const project = await api.projects.create(acme, { tenantId, name: 'ml', idempotencyKey: 'p1' });
    const archived = await api.projects.archive(acme, { tenantId, projectId: project.id });
    expect(archived).toMatchObject({
      id: project.id,
      state: 'archived',
      version: project.version + 1,
    });
    expect(await api.projects.archive(acme, { tenantId, projectId: project.id })).toEqual(archived);
    const { rows } = await fixture.database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE payload->>'type' = 'project.archived'",
    );
    expect(rows[0]!.n).toBe(1);
    await expect(
      api.projects.archive(acme, { tenantId, projectId: 'prj_01k5w0000000000000000000zz' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('commands.cancel', () => {
  it('cancels a pending command, asks an in-flight one to stop, and leaves a finished one', async () => {
    const fixture = await setup();
    const root = { token: fixture.tenants.root.token };
    const tenantId = fixture.tenants.root.id;
    const api = fixture.compute.api as any;
    const run = (key: string) =>
      api.commands.run(root, {
        tenantId,
        nodeId: NODE,
        kind: 'inventory.refresh',
        idempotencyKey: key,
      });
    const pending = await run('c1');
    const cancelled = await api.commands.cancel(root, {
      tenantId,
      nodeId: NODE,
      commandId: pending.id,
    });
    expect(cancelled.state).toBe('cancelled');

    const inflight = await run('c2');
    await fixture.database.query(
      "UPDATE commands SET state = 'dispatched', session_epoch = 1 WHERE id = $1",
      [inflight.id],
    );
    const asked = await api.commands.cancel(root, {
      tenantId,
      nodeId: NODE,
      commandId: inflight.id,
    });
    expect(asked.state).toBe('dispatched');
    const { rows } = await fixture.database.query<{ requested: boolean }>(
      'SELECT cancel_requested_at IS NOT NULL AS requested FROM commands WHERE id = $1',
      [inflight.id],
    );
    expect(rows[0]!.requested).toBe(true);

    const done = await run('c3');
    await fixture.database.query("UPDATE commands SET state = 'succeeded' WHERE id = $1", [
      done.id,
    ]);
    expect(
      await api.commands.cancel(root, { tenantId, nodeId: NODE, commandId: done.id }),
    ).toMatchObject({
      state: 'succeeded',
    });
    await expect(
      api.commands.cancel(root, {
        tenantId,
        nodeId: NODE,
        commandId: 'cmd_01k5w0000000000000000000zz',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('usage.export', () => {
  it('exports the range as CSV or JSON lines with totals per meter', async () => {
    const fixture = await setup();
    const acme = { token: fixture.tenants.acme.token };
    const tenantId = fixture.tenants.acme.id;
    const api = fixture.compute.api as any;
    await fixture.database.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
       VALUES ('alloc_u1', $1, 'pool_v2r', $2, 'reservation', 'rsv_x', tstzrange('2026-01-01', '2026-01-01 03:00'), 1)`,
      [tenantId, NODE],
    );
    for (const [hour, meter, quantity] of [
      [0, 'gpu.h100.hours', 2],
      [1, 'gpu.h100.hours', 2],
      [2, 'node.metal.hours', 1],
    ] as const)
      await fixture.database.query(
        `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
           window_start, window_end, tags)
         VALUES ($1, 'alloc_u1', $2, 'usr_a', $3, $4, $5, $6, $7)`,
        [
          `cmp:alloc_u1:${hour}`,
          tenantId,
          meter,
          quantity,
          new Date(Date.UTC(2026, 0, 1, hour)),
          new Date(Date.UTC(2026, 0, 1, hour + 1)),
          JSON.stringify({ pool: 'pool_v2r', note: 'a,"b"' }),
        ],
      );
    const range = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 2) };
    const csv = await api.usage.export(acme, { tenantId, ...range });
    expect(csv).toMatchObject({
      format: 'csv',
      count: 3,
      truncated: false,
      totals: { 'gpu.h100.hours': 4, 'node.metal.hours': 1 },
    });
    const lines = csv.data.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'idempotencyKey,allocationId,tenantId,identityId,meter,quantity,windowStart,windowEnd,tags,recordedAt,outcome',
    );
    // RFC 4180: the tags JSON (jsonb key order) is quoted, its quotes doubled.
    const tags = JSON.stringify({ note: 'a,"b"', pool: 'pool_v2r' });
    expect(lines[1]).toContain(`,"${tags.replace(/"/g, '""')}",`);
    expect(lines[1]!.startsWith('cmp:alloc_u1:0,alloc_u1,')).toBe(true);
    const jsonl = await api.usage.export(acme, {
      tenantId,
      ...range,
      meter: 'gpu.h100.hours',
      format: 'jsonl',
    });
    expect(jsonl.count).toBe(2);
    expect(
      jsonl.data
        .trimEnd()
        .split('\n')
        .map((line: string) => JSON.parse(line).meter),
    ).toEqual(['gpu.h100.hours', 'gpu.h100.hours']);
    await expect(
      api.usage.export(acme, { tenantId, from: range.from, to: range.from + 94 * 86_400_000 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
