import { afterEach, describe, expect, it } from 'vitest';
import { createMcpGate } from '@better-iam/mcp';
import { ComputeClientError } from '@better-compute/client';
import { createComputeMcp, gateTools, type ComputeApi } from '@better-compute/mcp';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// The better-compute MCP server (PLAN.md §9.3): JSON-RPC over Streamable HTTP, the tools against
// a recording compute client, confirmations, and better-iam's gate in front with gateTools().

const POOL = 'pool_01k5w0000000000000000000bb';
const NODE = 'node_01k5w0000000000000000000aa';
const RSV = 'rsv_01k5w0000000000000000000cc';

afterEach(closeIamFixtures);

function recorder(answer: (path: string, input: unknown) => unknown = () => ({ ok: true })) {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const api: ComputeApi = {
    async $request<Output>(path: string, input?: unknown) {
      calls.push({ path, input: input as Record<string, unknown> });
      return answer(path, input) as Output;
    },
  };
  return { api, calls };
}

let keys = 0;
const mcpWith = (api: ComputeApi, extra: Partial<Parameters<typeof createComputeMcp>[0]> = {}) =>
  createComputeMcp({ client: api, tenantId: 'org_acme', newKey: () => `key-${++keys}`, ...extra });

async function rpc(
  mcp: ReturnType<typeof createComputeMcp>,
  method: string,
  params?: unknown,
  id: number | null = 1,
  headers: Record<string, string> = {},
) {
  const response = await mcp.handler(
    new Request('https://mcp.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(id !== null ? { id } : {}),
        ...(params ? { params } : {}),
      }),
    }),
  );
  return {
    status: response.status,
    body: response.status === 202 ? undefined : await response.json(),
  };
}

describe('JSON-RPC over Streamable HTTP', () => {
  it('initializes, pings, lists tools and refuses what it does not speak', async () => {
    const mcp = mcpWith(recorder().api);
    const init = await rpc(mcp, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    expect(init.body.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'better-compute' },
    });
    expect(
      (await rpc(mcp, 'initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion,
    ).toBe('2025-06-18');
    expect(await rpc(mcp, 'notifications/initialized', undefined, null)).toEqual({
      status: 202,
      body: undefined,
    });
    expect((await rpc(mcp, 'ping')).body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    const tools = (await rpc(mcp, 'tools/list')).body.result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_pools',
      'capacity_summary',
      'preview_reservation',
      'reserve_gpus',
      'release_reservation',
      'list_reservations',
      'get_reservation',
      'extend_reservation',
      'node_status',
      'run_diagnostic',
      'create_instance',
      'list_instances',
      'get_instance',
      'start_instance',
      'stop_instance',
      'delete_instance',
      'list_sandbox_templates',
      'create_sandbox',
      'list_sandboxes',
      'extend_sandbox',
      'list_sandbox_snapshots',
      'delete_sandbox_snapshot',
      'get_sandbox',
      'delete_sandbox',
    ]);
    expect(
      tools.find((tool: { name: string }) => tool.name === 'release_reservation').annotations,
    ).toMatchObject({ destructiveHint: true });
    expect((await rpc(mcp, 'resources/list')).body.error.code).toBe(-32601);
    expect((await mcp.handler(new Request('https://mcp.test/mcp'))).status).toBe(405);
    const bad = await mcp.handler(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );
    expect(bad.status).toBe(400);
    expect(mcpWith(recorder().api, { execCommand: true }).tools.map((tool) => tool.name)).toContain(
      'exec_command',
    );
  });
});

describe('sandbox tools (v0.5, §3.7)', () => {
  it('create waits and carries its key; list, extend, get and delete stay in the caller’s tenant', async () => {
    const { api, calls } = recorder(() => ({ id: 'sbx_1' }));
    const mcp = mcpWith(api);
    const TEMPLATE = 'sbxt_01k5w0000000000000000000dd';
    const SANDBOX = 'sbx_01k5w0000000000000000000dd';
    const created = await rpc(mcp, 'tools/call', {
      name: 'create_sandbox',
      arguments: { templateId: TEMPLATE, ttlSeconds: 900, waitSeconds: 5 },
    });
    expect(created.body.result.isError).toBeUndefined();
    await rpc(mcp, 'tools/call', { name: 'list_sandbox_templates', arguments: {} });
    await rpc(mcp, 'tools/call', { name: 'list_sandboxes', arguments: { templateId: TEMPLATE } });
    await rpc(mcp, 'tools/call', {
      name: 'extend_sandbox',
      arguments: { sandboxId: SANDBOX, by: '30m' },
    });
    for (const verb of ['get', 'delete'])
      await rpc(mcp, 'tools/call', { name: `${verb}_sandbox`, arguments: { sandboxId: SANDBOX } });
    const SNAPSHOT = 'snap_01k5w0000000000000000000dd';
    await rpc(mcp, 'tools/call', {
      name: 'list_sandbox_snapshots',
      arguments: { sandboxId: SANDBOX },
    });
    await rpc(mcp, 'tools/call', {
      name: 'delete_sandbox_snapshot',
      arguments: { snapshotId: SNAPSHOT },
    });
    expect(calls).toEqual([
      {
        path: 'sandboxes/create',
        input: {
          tenantId: 'org_acme',
          templateId: TEMPLATE,
          ttlSeconds: 900,
          idempotencyKey: expect.any(String),
          wait: { timeoutMs: 5000 },
        },
      },
      { path: 'sandboxTemplates/list', input: { tenantId: 'org_acme' } },
      { path: 'sandboxes/list', input: { tenantId: 'org_acme', templateId: TEMPLATE } },
      { path: 'sandboxes/extend', input: { tenantId: 'org_acme', sandboxId: SANDBOX, by: '30m' } },
      { path: 'sandboxes/get', input: { tenantId: 'org_acme', sandboxId: SANDBOX } },
      { path: 'sandboxes/delete', input: { tenantId: 'org_acme', sandboxId: SANDBOX } },
      { path: 'sandboxSnapshots/list', input: { tenantId: 'org_acme', sandboxId: SANDBOX } },
      {
        path: 'sandboxSnapshots/delete',
        input: { tenantId: 'org_acme', snapshotId: 'snap_01k5w0000000000000000000dd' },
      },
    ]);
  });
});

describe('create_instance', () => {
  it('sends the vps instances.create shape (flavor name, imageId, sshKeys)', async () => {
    const { api, calls } = recorder(() => ({ id: 'inst_1' }));
    const mcp = mcpWith(api);
    const result = await rpc(mcp, 'tools/call', {
      name: 'create_instance',
      arguments: {
        poolId: POOL,
        flavor: 'g1.small',
        imageId: 'ubuntu-24.04',
        sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3 alice@laptop'],
      },
    });
    expect(result.body.result.isError).toBeUndefined();
    expect(calls[0]).toEqual({
      path: 'instances/create',
      input: {
        tenantId: 'org_acme',
        poolId: POOL,
        flavor: 'g1.small',
        imageId: 'ubuntu-24.04',
        sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3 alice@laptop'],
        idempotencyKey: expect.any(String),
        wait: { timeoutMs: 20_000 },
      },
    });
  });

  it('lists, reads, starts, stops and deletes instances in the caller’s tenant', async () => {
    const { api, calls } = recorder(() => ({ ok: true }));
    const mcp = mcpWith(api);
    const INSTANCE = 'inst_01k5w0000000000000000000dd';
    await rpc(mcp, 'tools/call', { name: 'list_instances', arguments: { scope: 'all' } });
    for (const verb of ['get', 'start', 'stop', 'delete'])
      await rpc(mcp, 'tools/call', {
        name: `${verb}_instance`,
        arguments: { instanceId: INSTANCE },
      });
    expect(calls).toEqual([
      { path: 'instances/list', input: { tenantId: 'org_acme', scope: 'all' } },
      ...['get', 'start', 'stop', 'delete'].map((verb) => ({
        path: `instances/${verb}`,
        input: { tenantId: 'org_acme', instanceId: INSTANCE },
      })),
    ]);
    const tools = mcp.listTools();
    expect(tools.find((tool) => tool.name === 'delete_instance')!.annotations).toMatchObject({
      destructiveHint: true,
    });
    expect(tools.find((tool) => tool.name === 'start_instance')!.annotations).toMatchObject({
      destructiveHint: false,
    });
    // A malformed id never reaches compute.
    const refused = await rpc(mcp, 'tools/call', {
      name: 'delete_instance',
      arguments: { instanceId: 'pool_x' },
    });
    expect(refused.body.result.isError).toBe(true);
    expect(calls).toHaveLength(5);
  });
});

describe('fleet tools (opt-in, read-only)', () => {
  it('exports and plans, hides the call list, and never applies', async () => {
    const { api, calls } = recorder((path) =>
      path === 'fleet/plan'
        ? { changes: [], summary: {}, calls: [{ path: 'sites/create' }], planHash: 'h' }
        : { config: { version: 1 } },
    );
    expect(mcpWith(api).tools.map((tool) => tool.name)).not.toContain('fleet_plan');
    const mcp = mcpWith(api, { fleet: true });
    const names = mcp.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['fleet_export', 'fleet_plan']));
    expect(names.some((name) => name.includes('apply'))).toBe(false);
    expect(
      mcp.tools
        .filter((tool) => tool.name.startsWith('fleet_'))
        .map((tool) => tool.annotations.readOnlyHint),
    ).toEqual([true, true]);

    await rpc(mcp, 'tools/call', { name: 'fleet_export', arguments: {} });
    const planned = await rpc(mcp, 'tools/call', {
      name: 'fleet_plan',
      arguments: { config: { version: 1 }, prune: true },
    });
    expect(calls).toEqual([
      { path: 'fleet/export', input: { tenantId: 'org_acme' } },
      { path: 'fleet/plan', input: { tenantId: 'org_acme', config: { version: 1 }, prune: true } },
    ]);
    expect(planned.body.result.structuredContent).toEqual({
      changes: [],
      summary: {},
      planHash: 'h',
      callCount: 1,
    });
    const missing = await rpc(mcp, 'tools/call', { name: 'fleet_plan', arguments: {} });
    expect(missing.body.result.isError).toBe(true);

    const rules = gateTools({ fleet: true });
    expect(rules.fleet_plan).toMatchObject({ action: 'compute:fleet:admin' });
    expect((rules.fleet_plan as { resource(args: object): unknown }).resource({})).toEqual({
      type: 'compute-fleet',
      id: 'global',
    });
    expect(gateTools().fleet_plan).toBeUndefined();
  });

  it('has a rule for every tool, so a gate with unlisted: deny hides none of them', () => {
    const { api } = recorder();
    const everyTool = mcpWith(api, { execCommand: true, fleet: true }).tools.map(
      (tool) => tool.name,
    );
    const rules = gateTools({ execCommand: true, fleet: true });
    expect(everyTool.filter((name) => !(name in rules))).toEqual([]);
    const template = 'sbxt_01k5w0000000000000000000dd';
    expect(
      (rules.create_sandbox as { action: string; resource(args: object): unknown }).resource({
        templateId: template,
      }),
    ).toEqual({ type: 'compute-sandbox-template', id: template });
  });
});

describe('tools', () => {
  it('call the compute routes as the caller, in the caller’s tenant', async () => {
    const { api, calls } = recorder();
    const mcp = mcpWith(api);
    await rpc(mcp, 'tools/call', { name: 'list_pools', arguments: {} });
    await rpc(mcp, 'tools/call', { name: 'capacity_summary', arguments: { poolId: POOL } });
    const reserved = await rpc(mcp, 'tools/call', {
      name: 'reserve_gpus',
      arguments: {
        poolId: POOL,
        gpus: 4,
        duration: '8h',
        gpuModel: 'H100',
        nvlink: true,
        selector: [{ key: 'vramGiB', op: 'Gte', values: [80] }],
      },
    });
    await rpc(mcp, 'tools/call', {
      name: 'release_reservation',
      arguments: { reservationId: RSV },
    });
    await rpc(mcp, 'tools/call', { name: 'run_diagnostic', arguments: { nodeId: NODE } });
    expect(calls.map((call) => call.path)).toEqual([
      'pools/list',
      'capacity/byPool',
      'reservations/create',
      'reservations/release',
      'commands/run',
    ]);
    expect(calls[2]!.input).toMatchObject({
      tenantId: 'org_acme',
      poolId: POOL,
      duration: '8h',
      binding: 'hold',
      wait: { timeoutMs: 20_000 },
      devices: [
        {
          class: 'gpu',
          count: 4,
          topology: 'nvlink-all',
          selector: {
            matchExpressions: [
              { key: 'vramGiB', op: 'Gte', values: [80] },
              { key: 'gpuModel', op: 'In', values: ['H100'] },
            ],
          },
        },
      ],
    });
    const result = reserved.body.result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.idempotencyKey).toBe(calls[2]!.input.idempotencyKey);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(calls[4]!.input).toMatchObject({ kind: 'diag.nvml', nodeId: NODE });
  });

  it('refuses bad arguments before calling compute, and reports compute errors as tool errors', async () => {
    const { api, calls } = recorder((path) => {
      if (path === 'reservations/release')
        throw Object.assign(new ComputeClientError('ACCESS_DENIED', 'Access denied', 403), {});
      throw new Error('socket hang up at 10.0.0.1');
    });
    const mcp = mcpWith(api);
    for (const args of [
      { poolId: 'nope', gpus: 1, duration: '1h' },
      { poolId: POOL, gpus: 0, duration: '1h' },
      { poolId: POOL, gpus: 1, duration: 'forever' },
      { poolId: POOL, gpus: 1, duration: '1h', extra: true },
    ]) {
      const result = (await rpc(mcp, 'tools/call', { name: 'reserve_gpus', arguments: args })).body
        .result;
      expect(result, JSON.stringify(args)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INVALID_INPUT' } },
      });
    }
    expect(calls).toEqual([]);
    const denied = (
      await rpc(mcp, 'tools/call', {
        name: 'release_reservation',
        arguments: { reservationId: RSV },
      })
    ).body.result;
    expect(denied).toMatchObject({
      isError: true,
      content: [{ text: 'ACCESS_DENIED: Access denied' }],
    });
    const internal = (await rpc(mcp, 'tools/call', { name: 'list_pools', arguments: {} })).body
      .result;
    expect(internal.content[0].text).toBe('INTERNAL_ERROR: The tool failed; try again later');
    expect(JSON.stringify(internal)).not.toContain('10.0.0.1');
    expect(
      (await rpc(mcp, 'tools/call', { name: 'rm_rf', arguments: {} })).body.result,
    ).toMatchObject({ isError: true });
    await expect(
      createComputeMcp({ client: api }).callTool('list_pools', {}, new Request('https://x')),
    ).resolves.toMatchObject({
      structuredContent: { error: { code: 'ACCESS_DENIED' } },
    });
  });

  it('turns CONFIRMATION_REQUIRED into a retry with the same idempotency key', async () => {
    let held = true;
    const { api, calls } = recorder((path) => {
      if (path === 'reservations/create' && held) {
        const error = new ComputeClientError('CONFIRMATION_REQUIRED', 'A person must confirm', 403);
        error.details = { confirmationId: 'cnf_1' };
        throw error;
      }
      return { id: RSV, state: 'placed' };
    });
    const args = { poolId: POOL, gpus: 2, duration: '1h' };
    const first = (await rpc(mcpWith(api), 'tools/call', { name: 'reserve_gpus', arguments: args }))
      .body.result;
    expect(first.structuredContent.reservation).toMatchObject({
      status: 'confirmation-required',
      confirmationId: 'cnf_1',
    });
    const key = first.structuredContent.idempotencyKey;
    // The model retries with the key after the person approved.
    held = false;
    const retried = (
      await rpc(mcpWith(api), 'tools/call', {
        name: 'reserve_gpus',
        arguments: { ...args, idempotencyKey: key },
      })
    ).body.result;
    expect(retried.structuredContent).toEqual({
      idempotencyKey: key,
      reservation: { id: RSV, state: 'placed' },
    });
    expect(calls.map((call) => call.input.idempotencyKey)).toEqual([key, key]);

    // With polling, the tool waits for the approval itself and retries once.
    held = true;
    const states = ['pending', 'approved'] as const;
    let polls = 0;
    const polling = mcpWith(api, {
      confirmations: {
        status: async () => {
          const state = states[Math.min(polls++, 1)]!;
          if (state === 'approved') held = false;
          return state;
        },
        intervalMs: 1,
      },
    });
    const waited = (await rpc(polling, 'tools/call', { name: 'reserve_gpus', arguments: args }))
      .body.result;
    expect(waited.structuredContent.reservation).toEqual({ id: RSV, state: 'placed' });
    expect(polls).toBe(2);
  });
});

describe('better-iam’s gate in front', () => {
  it('shows and refuses tools by visibility, with compute deciding the actual call', async () => {
    const f = await iamFixture();
    const alice = await f.member('alice');
    await f.member('bob');
    await f.grant(alice.id, {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:pools:read'], resources: ['compute-pool/*'] },
      ],
    });
    f.project('compute-pool', POOL, { region: 'eu-central-1', gpuModel: 'H100' });
    const { api, calls } = recorder();
    const mcp = createComputeMcp({ client: api, newKey: () => 'k' });
    const gate = createMcpGate({
      iam: f.iam as never,
      tenantId: f.tenantId,
      tools: gateTools(),
      unlisted: 'deny',
    });
    const call = async (token: string, method: string, params?: unknown) => {
      const response = await gate(
        new Request('https://mcp.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
        }),
        (forwarded, caller) => mcp.handler(forwarded, caller as never),
      );
      return response.json();
    };
    const aliceToken = (await f.signIn('alice')).token;
    const bobToken = (await f.signIn('bob')).token;
    const reserve = { name: 'reserve_gpus', arguments: { poolId: POOL, gpus: 1, duration: '1h' } };
    const allowed = await call(aliceToken, 'tools/call', reserve);
    expect(allowed.result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.tenantId).toBe(f.tenantId);
    const refused = await call(bobToken, 'tools/call', reserve);
    expect(refused.result?.isError ?? refused.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    // Tools without a resource argument pass the gate; compute decides them.
    expect(
      (await call(bobToken, 'tools/call', { name: 'list_pools', arguments: {} })).result.isError,
    ).toBeUndefined();
    const unauthenticated = await gate(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      () => new Response('never'),
    );
    expect(unauthenticated.status).toBe(401);
  });
});
