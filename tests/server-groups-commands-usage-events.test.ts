import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftId, type ComputeEvent } from '@better-compute/core';
import type { CommandInfo, UsageWindow } from '@better-compute/server';
import { ACME, OTHER } from './support/server.js';
import { ADMIN, OUTSIDER, USER, serverHarness, type Harness } from './support/server-api.js';

// `commands` (§7.3-7.4: the v0.1 allowlist, queued in the caller's transaction), `usage.list`
// (§12.7, on the tenant or a project) and `events.list` (§9.3, the outbox cursor).

let h: Harness;
let nodeId: string;
beforeAll(async () => {
  h = await serverHarness();
  const site = await h.seed.site(ACME);
  nodeId = await h.seed.node(ACME, site);
  h.iam.allow({ token: USER });
  h.iam.allow({ token: ADMIN });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => h.reset());

const run = (input: object, token = USER) =>
  h.call<CommandInfo>('commands/run', token, { tenantId: ACME, nodeId, ...input });

describe('commands', () => {
  it('queues an allowlisted kind through the command queue, decided as nodes:exec on the node', async () => {
    const command = await run({
      kind: 'inventory.refresh',
      payload: { sections: ['gpus'] },
      idempotencyKey: 'refresh-1',
      notAfterSeconds: 120,
    });
    expect(command).toMatchObject({
      nodeId,
      seq: 1,
      kind: 'inventory.refresh',
      state: 'pending',
      notAfter: Date.UTC(2026, 0, 1) + 120_000,
    });
    expect(h.iam.calls.at(-1)!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:nodes:exec',
      resource: { type: 'compute-node', id: nodeId },
    });
    const key = (await draftId('cmd', ACME, 'id-user', 'refresh-1')).slice('cmd_'.length);
    // The JSON payload becomes the kind's request message, every field set, ready to encode.
    expect(h.ports.commands.enqueued).toEqual([
      {
        nodeId,
        kind: 'inventory.refresh',
        payload: {
          $typeName: 'bettercompute.agent.v1.InventoryRefreshRequest',
          sections: ['gpus'],
          rescan: false,
        },
        idempotencyKey: `api:${key}`,
        notAfter: Date.UTC(2026, 0, 1) + 120_000,
      },
    ]);
    expect(h.ports.events.published).toEqual([
      {
        type: 'node.command.queued',
        tenantId: ACME,
        subject: `node/${nodeId}`,
        data: { nodeId, commandId: command.id, kind: 'inventory.refresh' },
      },
    ]);
    // A retry returns the queued command; the same key for another kind conflicts.
    h.reset();
    expect(
      await run({
        kind: 'inventory.refresh',
        payload: { sections: ['gpus'] },
        idempotencyKey: 'refresh-1',
      }),
    ).toEqual(command);
    expect(h.ports.events.published).toEqual([]);
    expect(
      (
        await h.failure('commands/run', USER, {
          tenantId: ACME,
          nodeId,
          kind: 'node.reboot',
          idempotencyKey: 'refresh-1',
        })
      ).code,
    ).toBe('CONFLICT');
  });

  it('runs only the v0.1 allowlist, with strict payloads', async () => {
    for (const kind of ['gpu.reset', 'wipe.quick', 'driver.invoke'])
      expect(
        (
          await h.failure('commands/run', USER, {
            tenantId: ACME,
            nodeId,
            kind,
            idempotencyKey: kind,
          })
        ).code,
      ).toBe('UNSUPPORTED');
    for (const [input, message] of [
      [{ kind: 'diag.nvml', payload: { level: 3 } }, /payload.level: Unknown field level/],
      [
        { kind: 'inventory.refresh', payload: { sections: ['toaster'] } },
        /payload.sections.0: Expected one of/,
      ],
      [
        { kind: 'logs.collect', payload: { sinceSeconds: 5 } },
        /payload.sinceSeconds: Must be at least 60/,
      ],
      [{ kind: 'node.reboot', notAfterSeconds: 7200 }, /notAfterSeconds: Must be at most 3600/],
      [{ kind: 'node.reboot', payload: [] }, /payload: Expected an object/],
    ] as const) {
      const error = await h.failure('commands/run', USER, {
        tenantId: ACME,
        nodeId,
        idempotencyKey: 'bad',
        ...input,
      });
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(message);
    }
    expect(h.iam.calls).toEqual([]);
  });

  it('gets and lists commands newest first, on nodes the tenant sees', async () => {
    const reboot = await run({ kind: 'node.reboot', idempotencyKey: 'reboot' });
    const diag = await run({ kind: 'diag.nvml', idempotencyKey: 'diag' });
    expect(
      await h.call('commands/get', USER, { tenantId: ACME, nodeId, commandId: reboot.id }),
    ).toEqual(reboot);
    expect(h.iam.calls.at(-1)!.decision!.action).toBe('compute:nodes:read');
    const page = await h.call<{ items: CommandInfo[]; cursor?: string }>('commands/list', USER, {
      tenantId: ACME,
      nodeId,
      limit: 1,
    });
    expect(page.items.map((command) => command.id)).toEqual([diag.id]);
    const next = await h.call<{ items: CommandInfo[] }>('commands/list', USER, {
      tenantId: ACME,
      nodeId,
      cursor: page.cursor,
    });
    expect(next.items[0]!.id).toBe(reboot.id);
    expect(
      (await h.failure('commands/get', ADMIN, { tenantId: OTHER, nodeId, commandId: reboot.id }))
        .code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await h.failure('commands/run', OUTSIDER, {
          tenantId: ACME,
          nodeId,
          kind: 'diag.nvml',
          idempotencyKey: 'o',
        })
      ).code,
    ).toBe('ACCESS_DENIED');
  });
});

describe('usage.list', () => {
  beforeAll(async () => {
    const site = await h.seed.site(ACME);
    const pool = await h.seed.pool(ACME, site);
    const node = await h.seed.node(ACME, site, { poolId: pool });
    await h.store.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
       VALUES ('alloc_1', $1, $2, $3, 'reservation', 'rsv_1', '[2026-01-01, 2026-01-02)', 1)`,
      [ACME, pool, node],
    );
    for (const [hour, project] of [
      [0, 'prj_a'],
      [1, 'prj_b'],
      [2, 'prj_a'],
    ] as const) {
      const start = Date.UTC(2026, 0, 1, hour);
      await h.store.query(
        `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
           window_start, window_end, tags)
         VALUES ($1, 'alloc_1', $2, 'id-user', 'gpu.h100.hours', 4, $3, $4, $5::jsonb)`,
        [
          `cmp:alloc_1:${start}`,
          ACME,
          new Date(start),
          new Date(start + 3_600_000),
          JSON.stringify({ project }),
        ],
      );
    }
  });

  it('lists a tenant’s windows in time order, with a cursor, decided on the tenant', async () => {
    const first = await h.call<{ items: UsageWindow[]; cursor?: string }>('usage/list', USER, {
      tenantId: ACME,
      limit: 2,
    });
    expect(first.items.map((window) => window.windowStart)).toEqual([
      Date.UTC(2026, 0, 1, 0),
      Date.UTC(2026, 0, 1, 1),
    ]);
    expect(first.items[0]).toEqual({
      idempotencyKey: `cmp:alloc_1:${Date.UTC(2026, 0, 1)}`,
      allocationId: 'alloc_1',
      tenantId: ACME,
      identityId: 'id-user',
      meter: 'gpu.h100.hours',
      quantity: 4,
      windowStart: Date.UTC(2026, 0, 1),
      windowEnd: Date.UTC(2026, 0, 1, 1),
      tags: { project: 'prj_a' },
    });
    expect(h.iam.calls.at(-1)!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:usage:read',
      resource: { type: 'compute-tenant', id: ACME },
    });
    const rest = await h.call<{ items: UsageWindow[]; cursor?: string }>('usage/list', USER, {
      tenantId: ACME,
      cursor: first.cursor,
    });
    expect(rest.items.map((window) => window.windowStart)).toEqual([Date.UTC(2026, 0, 1, 2)]);
    expect((await h.failure('usage/list', USER, { tenantId: ACME, cursor: 'garbage' })).code).toBe(
      'INVALID_INPUT',
    );
  });

  it('decides on the project when the call names one, and filters by it', async () => {
    const projectId = 'prj_00000000000000000000000000';
    await h.store.query(
      "UPDATE usage_windows SET tags = jsonb_build_object('project', $1::text) WHERE window_start = $2",
      [projectId, new Date(Date.UTC(2026, 0, 1, 1))],
    );
    const page = await h.call<{ items: UsageWindow[] }>('usage/list', USER, {
      tenantId: ACME,
      projectId,
    });
    expect(page.items.map((window) => window.tags.project)).toEqual([projectId]);
    expect(h.iam.calls.at(-1)!.decision!.resource).toEqual({
      type: 'compute-project',
      id: projectId,
    });
    const windowed = await h.call<{ items: UsageWindow[] }>('usage/list', USER, {
      tenantId: ACME,
      from: Date.UTC(2026, 0, 1, 1, 30),
      to: Date.UTC(2026, 0, 1, 2, 30),
    });
    expect(windowed.items.map((window) => window.windowStart)).toEqual([
      Date.UTC(2026, 0, 1, 1),
      Date.UTC(2026, 0, 1, 2),
    ]);
  });
});

describe('events.list', () => {
  it('lists the tenant’s committed events only, by type prefix, after a cursor', async () => {
    await run({ kind: 'diag.nvml', idempotencyKey: 'ev-1' });
    await h.call('projects/create', USER, { tenantId: ACME, name: 'events', idempotencyKey: 'ev' });
    await h.call('projects/create', ADMIN, {
      tenantId: OTHER,
      name: 'theirs',
      idempotencyKey: 'ev',
    });
    const all = await h.call<{ items: ComputeEvent[] }>('events/list', USER, { tenantId: ACME });
    expect(all.items.every((event) => event.tenantId === ACME)).toBe(true);
    expect(all.items.map((event) => event.type)).toEqual(
      expect.arrayContaining(['node.command.queued', 'project.created']),
    );
    expect(h.iam.calls.at(-1)!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:events:read',
      resource: { type: 'compute-tenant', id: ACME },
    });
    const projects = await h.call<{ items: ComputeEvent[] }>('events/list', USER, {
      tenantId: ACME,
      type: 'project.',
    });
    expect(projects.items.map((event) => event.type)).toEqual(['project.created']);
    const last = all.items.at(-1)!;
    const after = await h.call<{ items: ComputeEvent[] }>('events/list', USER, {
      tenantId: ACME,
      cursor: last.sequence,
    });
    expect(after.items).toEqual([]);
  });
});
