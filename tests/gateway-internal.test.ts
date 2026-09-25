import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '@better-compute/core';
import {
  gatewayControlClient,
  gatewayNotifier,
  internalHandler,
  serveInternal,
  type ServedInternal,
} from '@better-compute/gateway';
import { createInternalCa, generateP256KeyPair, privateKeyPem, toPem } from '@better-compute/pki';
import { FakeStream, gatewayFixture, helloFrame, type GatewayFixture } from './support/gateway.js';

// The gateway control API on internal_url (PLAN.md §8.1): poke, revoke, drain, health, and the
// core Notifier over it. Every call is an accelerator; the last suite proves convergence without it.

let f: GatewayFixture;
const served: ServedInternal[] = [];
beforeEach(async () => {
  f = await gatewayFixture();
});
afterEach(async () => {
  for (const server of served.splice(0)) await server.close();
  await f.close();
});

const call = (method: string, path: string, body?: unknown) =>
  internalHandler(f.gateway)(
    new Request(`http://gateway.internal${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe('internalHandler', () => {
  it('reports health', async () => {
    const response = await call('GET', '/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: f.gateway.id,
      region: 'eu-1',
      started: true,
      draining: false,
      sessions: 0,
      maxStreams: 5_000,
      leaseEpoch: 1,
      loops: { lease: { consecutiveFailures: 0, failures: 0, lastOkMs: expect.any(Number) } },
    });
  });

  it('counts consecutive loop failures until a clean run', async () => {
    const node = await f.addNode();
    await f.connect(node);
    const store = f.gateway.store as { dispatch: (...args: never[]) => Promise<unknown> };
    const real = store.dispatch;
    store.dispatch = async () => {
      throw new Error('database gone');
    };
    await expect(f.gateway.jobs.dispatch.tick()).rejects.toThrow('database gone');
    await expect(f.gateway.jobs.dispatch.tick()).rejects.toThrow('database gone');
    expect(f.gateway.status().loops.dispatch).toEqual({
      consecutiveFailures: 2,
      failures: 2,
      lastOkMs: null,
      lastError: 'Error: database gone',
    });
    store.dispatch = real;
    await f.gateway.jobs.dispatch.tick();
    expect((await (await call('GET', '/v1/health')).json()).loops.dispatch).toMatchObject({
      consecutiveFailures: 0,
      failures: 2,
      lastOkMs: expect.any(Number),
    });
  });

  it('revokes a live session and drains', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    const revoke = await call('POST', '/v1/revoke', { nodeId: node, reason: 'decommissioned', serials: ['abc'] });
    expect(await revoke.json()).toEqual({ revoked: true });
    expect([...stream.of('revoked')[0]!.serials[0]!]).toEqual([0x0a, 0xbc]);
    expect(stream.closed?.error?.message).toBe('certificate revoked');

    expect((await call('POST', '/v1/drain', { reason: 'deploy' })).status).toBe(202);
    expect(f.gateway.status().draining).toBe(true);
  });

  it('validates input and routes', async () => {
    expect((await call('POST', '/v1/poke', { nodeIds: 'x' })).status).toBe(400);
    expect((await call('POST', '/v1/poke', { nodeIds: ['a'] })).status).toBe(202);
    expect((await call('POST', '/v1/revoke', { nodeId: 'n', reason: 'r', serials: ['zz'] })).status).toBe(400);
    expect((await call('POST', '/v1/revoke', '[1]')).status).toBe(400);
    expect((await call('GET', '/v1/poke')).status).toBe(405);
    expect((await call('GET', '/v1/nope')).status).toBe(404);
  });
});

describe('serveInternal + gatewayControlClient', () => {
  it('serves the API over HTTP for tests', async () => {
    const server = await serveInternal(f.gateway, { insecure: true });
    served.push(server);
    const client = gatewayControlClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    expect(await client.health()).toMatchObject({ id: f.gateway.id, sessions: 0 });
    await client.poke(['node_1']);
    const node = await f.addNode();
    await f.connect(node);
    expect(await client.revoke(node, { reason: 'x' })).toBe(true);
    expect(await client.revoke(node, { reason: 'x' })).toBe(false);
    await expect(
      gatewayControlClient({ baseUrl: `http://127.0.0.1:${server.port}/` }).revoke('n', { reason: 'r', serials: ['q'] }),
    ).rejects.toThrow(/answered 400/);
  });

  it('requires an internal-CA client certificate over TLS', async () => {
    const ca = createInternalCa();
    const issue = async (usage: 'client' | 'server') => {
      const key = generateP256KeyPair();
      const cert = await ca.issue(key.publicKey, {
        usage,
        dnsSans: [usage === 'server' ? 'gw.internal.test' : 'api.internal.test'],
        role: 'internal',
        ttlSeconds: 3_600,
      });
      return { key: privateKeyPem(key.privateKey), cert: toPem(cert.certificate) };
    };
    const server = await serveInternal(f.gateway, { tls: { ...(await issue('server')), ca: toPem(ca.certificate) } });
    served.push(server);
    const base = { baseUrl: `https://127.0.0.1:${server.port}`, timeoutMs: 5_000 };
    const servername = 'gw.internal.test';
    const client = gatewayControlClient({
      ...base,
      tls: { ...(await issue('client')), ca: toPem(ca.certificate), servername },
    });
    expect((await client.health()).id).toBe(f.gateway.id);

    // Same server trust, but no client certificate: refused at the handshake.
    const anonymous = gatewayControlClient({ ...base, tls: { ca: toPem(ca.certificate), servername } });
    await expect(anonymous.health()).rejects.toThrow();
    // A client certificate from another CA: refused too.
    const other = createInternalCa();
    const key = generateP256KeyPair();
    const foreign = await other.issue(key.publicKey, {
      usage: 'client',
      dnsSans: ['evil.internal.test'],
      role: 'internal',
      ttlSeconds: 3_600,
    });
    const impostor = gatewayControlClient({
      ...base,
      tls: { key: privateKeyPem(key.privateKey), cert: toPem(foreign.certificate), ca: toPem(ca.certificate), servername },
    });
    await expect(impostor.health()).rejects.toThrow();
  });
});

describe('gatewayNotifier', () => {
  it('pokes the gateway named by the channel, found through gateways.internal_url', async () => {
    // A gateway with timers but a dispatch loop too slow to matter: only the poke can deliver.
    const live = await f.another({ manual: false, clock: systemClock, dispatchIntervalMs: 600_000, specSweepMs: 600_000 });
    const server = await serveInternal(live, { insecure: true });
    served.push(server);
    await f.db.query('UPDATE gateways SET internal_url = $2 WHERE id = $1', [live.id, `http://127.0.0.1:${server.port}`]);
    const node = await f.addNode();
    const { stream } = await f.connect(node, {}, live);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the Hello-triggered poke settle
    const id = await f.enqueue(node);
    const local: string[] = [];
    const notifier = gatewayNotifier({ sql: f.db });
    await notifier.subscribe(`gw:${live.id}`, (message) => local.push(message));
    await notifier.publish(`gw:${live.id}`, JSON.stringify({ nodeIds: [node] }));
    await expect.poll(() => stream.commandIds(), { timeout: 5_000 }).toEqual([id]);
    expect(local).toEqual([JSON.stringify({ nodeIds: [node] })]);
    await notifier.close?.();
  });

  it('never throws: an unknown or unreachable gateway is reported to onError only', async () => {
    const errors: string[] = [];
    await f.db.query(`UPDATE gateways SET internal_url = 'http://127.0.0.1:1' WHERE id = $1`, [f.gateway.id]);
    const notifier = gatewayNotifier({ sql: f.db, onError: (channel) => errors.push(channel) });
    await expect(notifier.publish(`gw:${f.gateway.id}`)).resolves.toBeUndefined();
    await expect(notifier.publish('gw:gw_unknown')).resolves.toBeUndefined();
    await expect(notifier.publish('reservations')).resolves.toBeUndefined();
    expect(errors).toEqual([`gw:${f.gateway.id}`]);
  });
});

describe('with the control API down', () => {
  it('still dispatches and pushes specs through the database and the loops', async () => {
    const live = await f.another({ manual: false, clock: systemClock, dispatchIntervalMs: 100, specSweepMs: 100 });
    await f.db.query(`UPDATE gateways SET internal_url = 'http://127.0.0.1:1' WHERE id = $1`, [live.id]);
    const node = await f.addNode();
    const stream = new FakeStream();
    const handle = live.open({ nodeId: node, role: 'node' }, stream);
    await handle.receive(helloFrame(node));
    const notifier = gatewayNotifier({ sql: f.db });

    const id = await f.enqueue(node);
    await notifier.publish(`gw:${live.id}`); // lost: the API is unreachable
    await expect.poll(() => stream.commandIds(), { timeout: 5_000 }).toEqual([id]);

    await f.db.query(`UPDATE nodes SET spec = '{}'::jsonb, generation = 3 WHERE id = $1`, [node]);
    await expect.poll(() => stream.of('desired').length, { timeout: 5_000 }).toBe(1);
  });
});
