import { create, toBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  field,
  manifest,
  type CommandQueue,
  type EventPublisher,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type StepContext,
  type WorkQueue,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { site } from '@better-compute/protocol';
import { defineProfile, defineStep, provisionMigrations, provisionModule, stepNotReady } from '@better-compute/provision';
import {
  checkProxyTarget,
  httpViaSite,
  inCidr,
  metal,
  metalMigrations,
  metalWorkKind,
  reconcileMetalNode,
  type MetalApi,
} from '@better-compute/metal';

// PLAN.md §5.6 walkthrough 3 — Talos, with zero edits to @better-compute/*: an `agent: 'none'` pool
// (the machine never runs bcd), inventory from Redfish inspection, and a third-party control-plane
// step `wait.talosReady` that reaches the Talos API through the site agent (`site.httpProxy`, P5).
// The whole "plugin" is the step and the profile below.

// --- The third-party Talos plugin ------------------------------------------------------------------

const talosReady = defineStep({
  id: 'wait.talosReady',
  runsOn: 'control-plane',
  relays: ['site'],
  // The kinds it relays (awaitCommand refuses others; a batch's scope includes them).
  sends: ['site.httpProxy'],
  timeout: '20m',
  retrySafe: true,
  input: manifest({ port: field.int({ min: 1, max: 65535 }).default(50000) }),
  async run(input, context) {
    const rows = await context.sql.query<{ addresses: string[] }>('SELECT addresses FROM metal_nodes WHERE node_id = $1', [context.node!.id]);
    const address = rows.rows[0]?.addresses[0];
    if (!address) throw stepNotReady(10_000);
    const response = await httpViaSite(context, {
      url: `https://${address}:${input.port}/machine/version`,
      tlsSpkiSha256: 'ab'.repeat(32),
      poll: true,
    });
    if (response.status !== 200) throw stepNotReady(5_000);
    return { talos: response.json<{ version: string }>().version };
  },
});
const talosProfile = defineProfile({
  id: 'talos-1.8',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [
    { use: 'media.insert', on: 'site', with: { url: 'https://cache.site-a/talos-1.8-metal-amd64.iso' } },
    { use: 'management.setBootDevice', on: 'site', with: { device: 'cd' } },
    { use: 'power.setPower', on: 'site', with: { action: 'cycle' } },
    { use: 'wait.talosReady' },
  ],
});

// --- The platform, with simulated site agent and machine ------------------------------------------

const SITE_AGENT = 'node_talossiteagent000000000001';
const bareMetal = metal();
const provision = provisionModule({ modules: [bareMetal], steps: [talosReady], profiles: [talosProfile] });
let db: SqlExecutor;
let context: ModuleContext & MethodContext;
let api: MetalApi;
const queue = new Map<string, { kind: string; key: string }>();
const work: WorkQueue = { async enqueue(_tx, kind, key) { queue.set(`${kind}:${key}`, { kind, key }); } };
const events: string[] = [];
const eventLog: EventPublisher = { async publish(_tx, event) { events.push(event.type); } };
let seq = 0;
const commands: CommandQueue = {
  async enqueue(tx, command) {
    const existing = await tx.query<{ id: string }>('SELECT id FROM commands WHERE node_id = $1 AND idempotency_key = $2', [command.nodeId, command.idempotencyKey]);
    if (existing.rows[0]) return { id: existing.rows[0].id, seq: 0 };
    const id = `cmd_talos_${++seq}`;
    await tx.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', to_timestamp($6 / 1000.0), false, false, false, $7)`,
      [id, command.nodeId, seq, command.kind, new TextEncoder().encode(JSON.stringify(command.payload)), command.notAfter, command.idempotencyKey],
    );
    return { id, seq };
  },
  async cancel() {},
};

/** The machine: Talos answers once it booted from the ISO; until then the API is unreachable. */
const machine = { booted: false, bootedFromCd: false, bootDevice: '', mounted: '', proxy: [] as Record<string, unknown>[], answer: undefined as undefined | ((payload: any) => site.HttpProxyResponse) };

async function runAgents(): Promise<number> {
  const { rows } = await db.query<{ id: string; node_id: string; kind: string; body: Uint8Array }>(`SELECT id, node_id, kind, body FROM commands WHERE state = 'pending' ORDER BY seq`);
  for (const command of rows) {
    const payload = JSON.parse(new TextDecoder().decode(command.body)) as Record<string, any>;
    const args = typeof payload.argsJson === 'string' ? JSON.parse(payload.argsJson) : {};
    let result = new Uint8Array();
    const bmc = (value: unknown) => toBinary(site.BmcOperationResultSchema, create(site.BmcOperationResultSchema, { ok: true, resultJson: JSON.stringify(value) }));
    expect(command.node_id).toBe(SITE_AGENT); // an agentless machine only ever talks through its site agent
    switch (command.kind) {
      case 'bmc.query':
        result = bmc(payload.operation === 'inspect.inspect' ? { macs: ['52:54:00:aa:bb:01'], ipAddresses: ['10.20.0.5'] } : { power: 'off' });
        break;
      case 'bmc.boot':
        if (payload.operation === 'virtual-media.insert') machine.mounted = args.url;
        if (payload.operation === 'virtual-media.eject') machine.mounted = '';
        if (payload.operation === 'management.setBootDevice') machine.bootDevice = args.device;
        result = bmc({});
        break;
      case 'bmc.power':
        if (args.action === 'cycle') machine.bootedFromCd = machine.bootDevice === 'cd' && machine.mounted.includes('talos');
        if (args.action === 'off') machine.bootedFromCd = false;
        result = bmc({});
        break;
      case 'site.httpProxy': {
        machine.proxy.push(payload);
        const response = machine.answer
          ? machine.answer(payload)
          : machine.bootedFromCd
            ? create(site.HttpProxyResponseSchema, { status: 200, body: new TextEncoder().encode('{"version":"v1.8.3"}') })
            : create(site.HttpProxyResponseSchema, { status: 503 });
        result = toBinary(site.HttpProxyResponseSchema, response);
        break;
      }
      default:
        throw new Error(`an agentless machine got ${command.kind}`);
    }
    await db.query('UPDATE commands SET state = $2, result = $3 WHERE id = $1', [command.id, 'succeeded', result]);
  }
  return rows.length;
}

async function settle(rounds = 300) {
  const signal = new AbortController().signal;
  for (let i = 0; i < rounds; i++) {
    const answered = await runAgents();
    const due = [...queue.values()];
    queue.clear();
    for (const item of due) {
      if (item.kind === metalWorkKind) await reconcileMetalNode(context, item.key);
      else if (item.kind === 'workflow') await provision.reconcilers![0]!.run({ ...context, signal } as never, item.key);
    }
    if (answered === 0 && due.length === 0) return;
  }
}
const state = async (id: string) =>
  (await db.query<{ provision_state: string; role: string }>('SELECT provision_state, role FROM nodes WHERE id = $1', [id])).rows[0]!;
async function call<M extends keyof MetalApi['metal']>(method: M, input: unknown) {
  const definition = api.metal[method] as unknown as { validate(i: unknown): unknown; handler(c: MethodContext, i: unknown): Promise<any> };
  return definition.handler(context, definition.validate(input));
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...provisionMigrations, ...metalMigrations]);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'root', 'shared', 'eu', 1)`);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_talos', 'root', 'site_a', 'metal-host', 'exclusive', 'none',
             '{"allowUnverifiedRelease": true, "provisioningCidrs": ["10.30.0.0/16"]}', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
       generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', 'root', 'site', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [SITE_AGENT],
  );
  await db.query(`INSERT INTO node_sessions (node_id, session_epoch, boot_id, role, connected_at) VALUES ($1, 1, 'b', 'site', compute_now())`, [SITE_AGENT]);
  const base = { sql: db, work, events: eventLog, commands, requestId: 'req_talos', iam: { rootTenantId: 'root' } };
  context = { ...base, workflows: provision.workflowEngine(base as never) } as unknown as ModuleContext & MethodContext;
  api = bareMetal.api!(context);
});
afterAll(() => db.close());
beforeEach(() => {
  Object.assign(machine, { booted: false, bootedFromCd: false, bootDevice: '', mounted: '', proxy: [], answer: undefined });
  events.length = 0;
});

let enrolled = '';

describe('walkthrough 3: Talos on an agentless pool', () => {
  it('enrolls and commissions out of band, deploys Talos, and reaches the Talos API only through the site agent', async () => {
    const node = await call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_talos',
      bmc: { address: 'https://10.10.0.5', driver: 'redfish', credentials: 'secret://root/bmc-1' },
    });
    enrolled = node.nodeId;
    await settle();
    expect(await state(enrolled)).toMatchObject({ provision_state: 'ready' });
    const addresses = await db.query<{ addresses: string[] }>('SELECT addresses FROM metal_nodes WHERE node_id = $1', [enrolled]);
    expect(addresses.rows[0]!.addresses).toEqual(['10.20.0.5']); // inventory came from Redfish

    await call('deploy', { tenantId: 'root', nodeId: enrolled, profileId: 'talos-1.8', profileVersion: 1 });
    await settle();
    expect(await state(enrolled)).toMatchObject({ provision_state: 'deployed', role: 'host' });
    // The API was polled until Talos answered, always to the machine's own address, pinned.
    expect(machine.proxy.length).toBeGreaterThanOrEqual(1);
    for (const request of machine.proxy)
      expect(request).toMatchObject({
        targetNodeId: enrolled,
        url: 'https://10.20.0.5:50000/machine/version',
        method: 'GET',
        tlsSpkiSha256: Buffer.from('ab'.repeat(32), 'hex').toString('base64'),
      });
    const result = await db.query<{ result: { talos: string } }>(
      `SELECT s.result FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
        WHERE w.node_id = $1 AND s.action = 'wait.talosReady' AND s.state = 'succeeded'`,
      [enrolled],
    );
    expect(result.rows[0]!.result.talos).toBe('v1.8.3');
    // Never connected: an agentless node is never schedulable for holds.
    const conn = await db.query<{ connectivity: string }>('SELECT connectivity FROM nodes WHERE id = $1', [enrolled]);
    expect(conn.rows[0]!.connectivity).toBe('disconnected');
  });

  it('releases without an attested wipe only because the pool opted in, and says so', async () => {
    await call('undeploy', { tenantId: 'root', nodeId: enrolled });
    await settle();
    expect((await state(enrolled)).provision_state).toBe('ready');
    expect(events).toContain('node.release.unverified');
    expect(machine.mounted).toBe('');
  });

  it('refuses rescue, which needs an agent', async () => {
    await call('deploy', { tenantId: 'root', nodeId: enrolled, profileId: 'talos-1.8', profileVersion: 1 });
    await settle();
    await call('rescue', { tenantId: 'root', nodeId: enrolled });
    await settle();
    expect((await state(enrolled)).provision_state).toBe('failed');
    const error = await db.query<{ last_error: { code: string } }>('SELECT last_error FROM metal_nodes WHERE node_id = $1', [enrolled]);
    expect(error.rows[0]!.last_error.code).toBe('UNSUPPORTED');
  });
});

describe('site.httpProxy is SSRF-bounded', () => {
  const target = { addresses: ['10.20.0.5', '10.30.1.7'], provisioningCidrs: ['10.30.0.0/16'] };

  it('refuses other hosts, names, credentials, plain http off the provisioning network and forbidden headers', () => {
    expect(checkProxyTarget({ url: 'https://10.20.0.5:50000/x' }, target).host).toBe('10.20.0.5:50000');
    expect(() => checkProxyTarget({ url: 'https://10.20.0.6/x' }, target)).toThrow(/not an address of the target/);
    expect(() => checkProxyTarget({ url: 'https://169.254.169.254/latest' }, target)).toThrow(/not an address/);
    expect(() => checkProxyTarget({ url: 'https://talos.internal/x' }, target)).toThrow(/not a name/);
    expect(() => checkProxyTarget({ url: 'https://u:p@10.20.0.5/x' }, target)).toThrow(/credentials/);
    expect(() => checkProxyTarget({ url: 'http://10.20.0.5/x' }, target)).toThrow(/provisioning network/);
    expect(checkProxyTarget({ url: 'http://10.30.1.7/x' }, target).protocol).toBe('http:');
    expect(() => checkProxyTarget({ url: 'ftp://10.20.0.5/x' }, target)).toThrow(/http and https/);
    expect(() => checkProxyTarget({ url: 'https://10.20.0.5/x', headers: { Host: 'evil' } }, target)).toThrow(/set by the agent/);
    expect(() => checkProxyTarget({ url: 'https://10.20.0.5/x', headers: { 'X-A': 'a\r\nX-B: b' } }, target)).toThrow(/line break/);
    expect(() => checkProxyTarget({ url: 'https://10.20.0.5/x', secretHeaders: { Authorization: 'hunter2' as never } }, target)).toThrow(/secret reference/);
    expect(inCidr('10.30.255.1', '10.30.0.0/16')).toBe(true);
    expect(inCidr('10.31.0.1', '10.30.0.0/16')).toBe(false);
  });

  const stepContext = (key: string) =>
    ({ ...context, node: { id: enrolled, siteId: 'site_a' }, workflowId: 'wf_proxy', stepId: 's', attempt: 0, idempotencyKey: `wf:proxy:${key}` }) as unknown as StepContext;
  async function once(key: string, answer: (payload: any) => site.HttpProxyResponse, request: Parameters<typeof httpViaSite>[1]) {
    machine.answer = answer;
    const ctx = stepContext(key);
    await expect(httpViaSite(ctx, request)).rejects.toThrow(/not ready/);
    await runAgents();
    return httpViaSite(ctx, request);
  }

  it("never sends a request for another node's IP", async () => {
    const before = await db.query('SELECT count(*)::int AS n FROM commands');
    await expect(httpViaSite(stepContext('other'), { url: 'https://10.20.0.99/x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const after = await db.query('SELECT count(*)::int AS n FROM commands');
    expect(after.rows).toEqual(before.rows);
  });

  it('fails on a redirect instead of following it', async () => {
    await expect(
      once('redirect', () => create(site.HttpProxyResponseSchema, { status: 302, headers: [{ name: 'Location', value: 'https://evil/' }] }), {
        url: 'https://10.20.0.5:50000/x',
      }),
    ).rejects.toMatchObject({ code: 'DRIVER_ERROR', message: expect.stringMatching(/redirect/) });
  });

  it('fails on a truncated (oversize) response', async () => {
    await expect(
      once('big', () => create(site.HttpProxyResponseSchema, { status: 200, body: new Uint8Array(16), truncated: true }), {
        url: 'https://10.20.0.5:50000/x',
      }),
    ).rejects.toMatchObject({ code: 'DRIVER_ERROR', message: expect.stringMatching(/exceeds/) });
  });

  it('passes secret headers by reference only', async () => {
    const response = await once('secret', () => create(site.HttpProxyResponseSchema, { status: 200, body: new TextEncoder().encode('{}') }), {
      url: 'https://10.20.0.5:50000/x',
      secretHeaders: { Authorization: 'secret://root/talos-token' },
    });
    expect(response.status).toBe(200);
    expect(machine.proxy.at(-1)).toMatchObject({ secretHeaders: [{ name: 'Authorization', value: 'secret://root/talos-token' }] });
  });
});
