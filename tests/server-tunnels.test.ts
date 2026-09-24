import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  manualClock,
  type Caller,
  type MethodContext,
  type ModuleContext,
  type NodeRecord,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { generateKeyPairSync } from 'node:crypto';
import {
  connectTunnel,
  decodeTunnelFrame,
  encodeTunnelFrame,
  tunnelUrl,
  type TunnelFrameBody,
} from '@better-compute/client';
import {
  createExecTicketIssuer,
  createReplayCache,
  createSshCertificateAuthority,
  formatSshPublicKey,
  parseSshCertificate,
  verifyExecTicket,
} from '@better-compute/pki';
import {
  decodeMessage,
  encodeMessage,
  TunnelFrameSchema,
  type TunnelFrame,
} from '@better-compute/protocol';
import {
  handleTunnel,
  tunnelsModule,
  type OpenedTunnel,
  type RelayedTunnel,
  type HandleTunnelOptions,
  type TunnelReauthorization,
  type TunnelRelay,
} from '../packages/server/src/tunnels/index.js';

// Tunnels, the API half (PLAN.md §7.6): tunnels.open issues a node-bound exec ticket after the
// decision; GET {basePath}/tunnels/{ticket} upgrades to a WebSocket and relays TunnelFrames to
// the node's gateway through the host's TunnelRelay (a fake echo relay here).

const T0 = Date.UTC(2026, 8, 24, 12);
const NODE = 'node_01jz00000000000000000000na';
const OFFLINE = 'node_01jz00000000000000000000nb';
const INSTANCE = 'inst_01jz00000000000000000000ia';
let db: SqlExecutor;
let events: string[] = [];
const issuer = createExecTicketIssuer({ issuer: 'https://compute.test' });
const module = tunnelsModule({ issuer });

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};

function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn) => fn(tx),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  } as SqlExecutor;
}

type Definition = {
  validate(raw: unknown): unknown;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
};
const api = module.api!({} as ModuleContext) as unknown as { tunnels: { open: Definition } };
const open = async (raw: unknown) => {
  const input = api.tunnels.open.validate(raw);
  return db.transaction(
    async (tx) =>
      (await api.tunnels.open.handler(
        {
          sql: within(tx),
          clock: manualClock(T0),
          caller: alice,
          requestId: 'r',
          events: {
            async publish(_tx: SqlTx, event: { type: string }) {
              events.push(event.type);
            },
          },
        } as unknown as MethodContext,
        input,
      )) as OpenedTunnel,
  );
};

beforeAll(async () => {
  db = pglite();
  await db.migrate([]);
  // The vps module's instances table, reduced to what tunnels.open reads.
  await db.query(`CREATE TABLE instances (id text PRIMARY KEY, tenant_id text NOT NULL, node_id text,
                    state text NOT NULL, draft bool NOT NULL DEFAULT false)`);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu', 1)`,
  );
  for (const [id, connectivity] of [
    [NODE, 'connected'],
    [OFFLINE, 'lost'],
  ])
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                          trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000aa', 'root', 'host', 'adopted', false, false, $2, 'platform',
               1, 1, 1, 1, 0, 1)`,
      [id, connectivity],
    );
  await db.query(
    `INSERT INTO node_sessions (node_id, session_epoch, gateway_id) VALUES ($1, 1, 'gw-a')`,
    [NODE],
  );
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  events = [];
  await db.query('DELETE FROM instances');
  await db.query(
    `INSERT INTO instances (id, tenant_id, node_id, state) VALUES ($1, 'acme', $2, 'running')`,
    [INSTANCE, NODE],
  );
});

describe('tunnels.open', () => {
  it('issues a single-use ticket bound to the instance’s node, the caller and the tunnel', async () => {
    const opened = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
    expect(opened).toMatchObject({ nodeId: NODE, instanceId: INSTANCE, op: 'exec' });
    expect(opened.path).toBe(`tunnels/${opened.ticket}`);
    expect(events).toEqual(['tunnel.issued']);
    const claims = verifyExecTicket(opened.ticket, {
      jwks: issuer.jwksJson(),
      nodeId: NODE,
      now: Date.now(),
      jtiCache: createReplayCache(),
    });
    expect(claims).toMatchObject({
      sub: 'usr_alice',
      sid: opened.tunnelId,
      tnt: 'acme',
      inst: INSTANCE,
      op: 'exec',
    });
    const tcp = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'tcp', port: 5432 });
    expect(tcp.op).toBe('tcp');
  });

  it('refuses what cannot be tunneled', async () => {
    const refused = (raw: Record<string, unknown>) =>
      open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec', ...raw });
    await expect(refused({ op: 'console' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(refused({ op: 'tcp' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(refused({ port: 22 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(open({ tenantId: 'acme', nodeId: NODE, op: 'console' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(refused({ instanceId: 'inst_01jz00000000000000000000zz' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      open({ tenantId: 'other', instanceId: INSTANCE, op: 'exec' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db.query(`UPDATE instances SET state = 'stopped'`);
    await expect(refused({})).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await db.query(`UPDATE instances SET state = 'running', node_id = $1`, [OFFLINE]);
    await expect(refused({})).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('puts the issuer’s JWKS into every node’s access section', async () => {
    const spec = await module.nodeSpec!({} as ModuleContext, {} as NodeRecord);
    expect(spec.access?.execTicketJwks).toEqual(JSON.parse(issuer.jwksJson()));
  });
});

describe('nodes.issueSshCert', () => {
  const ca = createSshCertificateAuthority();
  const withSsh = tunnelsModule({ issuer, ssh: ca });
  const sshApi = withSsh.api!({} as ModuleContext) as unknown as {
    nodes: { issueSshCert: Definition };
  };
  const userKey = formatSshPublicKey(generateKeyPairSync('ed25519').publicKey, 'alice@laptop');
  const issue = async (raw: Record<string, unknown>, caller: Caller = { ...alice, mfa: true }) => {
    const definition = sshApi.nodes.issueSshCert;
    const input = definition.validate({
      tenantId: 'acme',
      nodeId: NODE,
      publicKey: userKey,
      ...raw,
    });
    return db.transaction(
      async (tx) =>
        (await definition.handler(
          {
            sql: within(tx),
            clock: { now: () => Date.now() },
            caller,
            requestId: 'r',
            events: {
              async publish(_tx: SqlTx, event: { type: string }) {
                events.push(event.type);
              },
            },
          } as unknown as MethodContext,
          input,
        )) as { certificate: string; principals: string[]; keyId: string; validBefore: number },
    );
  };

  beforeAll(async () => {
    await db.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, 'acme', '{}')
       ON CONFLICT DO NOTHING`,
      [NODE],
    );
  });

  it('issues a short, recorded user certificate for an MFA session', async () => {
    const issued = await issue({ principal: 'ubuntu', ttlSeconds: 600 });
    const parsed = parseSshCertificate(issued.certificate);
    expect(parsed).toMatchObject({
      certType: 'user',
      principals: ['ubuntu'],
      keyId: issued.keyId,
      signatureValid: true,
    });
    expect(issued.keyId).toMatch(new RegExp(`^bc:usr_alice:${NODE}:ssh_`));
    expect(parsed.validBefore - Date.now()).toBeLessThanOrEqual(600_000);
    expect(formatSshPublicKey(parsed.signatureKey)).toBe(
      ca.publicKey.split(' ').slice(0, 2).join(' '),
    );
    expect(events).toContain('node.ssh-cert.issued');
    expect((await issue({})).principals).toEqual(['root']);
  });

  it('refuses without MFA, for unknown nodes, bad keys and long lifetimes; pins the CA', async () => {
    await expect(issue({}, { ...alice, mfa: false })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await expect(issue({ nodeId: OFFLINE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(issue({ publicKey: 'ssh-rsa AAAA nope' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(issue({ ttlSeconds: 7200 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(issue({ principal: 'Root!' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const spec = await withSsh.nodeSpec!({} as ModuleContext, {} as NodeRecord);
    expect(spec.access?.sshCaPublicKeys).toEqual([ca.publicKey]);
    // Without a CA the method is unavailable.
    const plain = module.api!({} as ModuleContext) as unknown as {
      nodes: { issueSshCert: Definition };
    };
    const input = plain.nodes.issueSshCert.validate({
      tenantId: 'acme',
      nodeId: NODE,
      publicKey: userKey,
    });
    await expect(
      plain.nodes.issueSshCert.handler(
        { caller: { ...alice, mfa: true } } as unknown as MethodContext,
        input,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

// --- The relay endpoint ----------------------------------------------------------------------------

interface Recorded {
  opened: { nodeId: string; tunnelId: string; gatewayId: string }[];
  received: TunnelFrame[];
  closed: number;
}

/** A relay whose "node" echoes data frames back and ends when the caller sends `closed`. */
function echoRelay(recorded: Recorded, openDelayMs = 0): TunnelRelay {
  return {
    async open(input) {
      if (openDelayMs) await new Promise((resolve) => setTimeout(resolve, openDelayMs));
      recorded.opened.push({
        nodeId: input.nodeId,
        tunnelId: input.tunnelId,
        gatewayId: input.gatewayId,
      });
      const queue: TunnelFrame[] = [];
      const waiters: ((result: IteratorResult<TunnelFrame>) => void)[] = [];
      let done = false;
      const push = (frame: TunnelFrame | undefined) => {
        const waiter = waiters.shift();
        if (frame === undefined) {
          done = true;
          waiter?.({ value: undefined, done: true });
          return;
        }
        if (waiter) waiter({ value: frame, done: false });
        else queue.push(frame);
      };
      push(
        create(TunnelFrameSchema, {
          tunnelId: input.tunnelId,
          body: { case: 'opened', value: {} },
        }),
      );
      const tunnel: RelayedTunnel = {
        frames: {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              queue.length
                ? Promise.resolve({ value: queue.shift()!, done: false })
                : done
                  ? Promise.resolve({ value: undefined, done: true })
                  : new Promise((resolve) => waiters.push(resolve)),
          }),
        },
        send(frame) {
          recorded.received.push(frame);
          if (frame.body.case === 'data')
            push(
              create(TunnelFrameSchema, {
                tunnelId: frame.tunnelId,
                body: {
                  case: 'data',
                  value: Buffer.concat([Buffer.from('echo:'), Buffer.from(frame.body.value)]),
                },
              }),
            );
          if (frame.body.case === 'closed') {
            push(
              create(TunnelFrameSchema, {
                tunnelId: frame.tunnelId,
                body: { case: 'closed', value: { exitCode: 0, reason: 'bye' } },
              }),
            );
            push(undefined);
          }
          return true;
        },
        drained: async () => {},
        close() {
          recorded.closed++;
          push(undefined);
        },
      };
      return tunnel;
    },
  };
}

async function listen(
  options: { relay: TunnelRelay } & Partial<HandleTunnelOptions>,
): Promise<{ server: Server; base: string; port: number; outcomes: unknown[] }> {
  const outcomes: unknown[] = [];
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    // The documented mount: handleTunnel must never reject.
    void handleTunnel(req, socket, head, {
      sql: db,
      issuer,
      authorize: async () => true,
      reauthorizeMs: 50,
      ...options,
    }).then(
      (handled) => {
        outcomes.push(handled);
        if (!handled) socket.destroy();
      },
      (error) => outcomes.push({ rejected: error }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `ws://127.0.0.1:${port}/api/compute`, port, outcomes };
}

/** A raw WebSocket client over TCP, for what browsers never send. */
function rawClient(port: number, path: string, extraHeaders = '') {
  const socket = netConnect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  socket.on('error', () => undefined);
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
      `sec-websocket-key: ${key}\r\n${extraHeaders || 'sec-websocket-version: 13\r\n'}\r\n`,
  );
  const masked = (opcode: number, payload: Buffer) => {
    const mask = randomBytes(4);
    const body = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
    return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, body]);
  };
  return {
    socket,
    closed,
    text: () => Buffer.concat(chunks).toString('latin1'),
    bytes: () => Buffer.concat(chunks),
    sendFrame: (opcode: number, payload = Buffer.alloc(0)) => socket.write(masked(opcode, payload)),
  };
}

function connect(url: string) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const frames: TunnelFrame[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
  );
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
  });
  ws.addEventListener('message', (event) =>
    frames.push(decodeMessage(TunnelFrameSchema, new Uint8Array(event.data as ArrayBuffer))),
  );
  const send = (frame: TunnelFrame) => ws.send(encodeMessage(TunnelFrameSchema, frame));
  return { ws, frames, closed, opened, send };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('client tunnel frames', () => {
  it('are wire compatible with the protobuf schema both ways', () => {
    const cases: TunnelFrameBody[] = [
      { case: 'opened' },
      { case: 'data', data: Buffer.from('hello'), channel: 0 },
      { case: 'data', data: Buffer.from('oops'), channel: 1 },
      { case: 'resize', rows: 40, cols: 120 },
      { case: 'closed', exitCode: -1, reason: 'killed' },
      { case: 'closed', exitCode: 0, reason: '' },
    ];
    for (const body of cases) {
      const decoded = decodeMessage(TunnelFrameSchema, encodeTunnelFrame(body));
      expect(decoded.body.case).toBe(body.case);
      const again = decodeTunnelFrame(encodeMessage(TunnelFrameSchema, decoded));
      expect(again).toEqual(
        body.case === 'data' ? { ...body, data: new Uint8Array(body.data) } : body,
      );
    }
    expect(tunnelUrl('https://compute.test', '/api/compute/', 'tunnels/abc')).toBe(
      'wss://compute.test/api/compute/tunnels/abc',
    );
  });
});

describe('GET /tunnels/{ticket}', () => {
  it('works with the client’s connectTunnel', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const { server, base } = await listen({ relay: echoRelay(recorded) });
    try {
      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const tunnel = connectTunnel({ url: `${base}/${ticket.path}` });
      const output: string[] = [];
      tunnel.onData((data) => output.push(Buffer.from(data).toString()));
      tunnel.write('uptime');
      await tunnel.ready;
      await until(() => output.length > 0);
      expect(output).toEqual(['echo:uptime']);
      tunnel.close();
      expect(await tunnel.exited).toEqual({ exitCode: 0, reason: 'bye' });
    } finally {
      server.close();
    }
  });

  it('relays frames both ways through the node’s gateway, once per ticket', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const { server, base } = await listen({ relay: echoRelay(recorded) });
    try {
      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const client = connect(`${base}/${ticket.path}`);
      expect(await client.opened).toBe(true);
      expect(recorded.opened).toEqual([
        { nodeId: NODE, tunnelId: ticket.tunnelId, gatewayId: 'gw-a' },
      ]);
      // The caller's frames are stamped with the ticket's tunnel id, whatever it sent.
      client.send(
        create(TunnelFrameSchema, {
          tunnelId: 'spoofed',
          body: { case: 'data', value: Buffer.from('ls') },
        }),
      );
      await until(() => client.frames.length >= 2);
      expect(client.frames[0]!.body.case).toBe('opened');
      expect(Buffer.from(client.frames[1]!.body.value as Uint8Array).toString()).toBe('echo:ls');
      expect(recorded.received[0]!.tunnelId).toBe(ticket.tunnelId);
      client.send(
        create(TunnelFrameSchema, {
          tunnelId: '',
          body: { case: 'closed', value: { exitCode: 0, reason: '' } },
        }),
      );
      expect((await client.closed).code).toBe(1000);
      expect(client.frames.at(-1)!.body.case).toBe('closed');

      // A ticket opens one tunnel, ever.
      const again = connect(`${base}/${ticket.path}`);
      expect(await again.opened).toBe(false);
      expect(recorded.opened).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('refuses forged tickets and nodes without a session; ends revoked callers', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    let allowed = true;
    const { server, base } = await listen({
      relay: echoRelay(recorded),
      authorize: async () => allowed,
    });
    try {
      const other = createExecTicketIssuer({ issuer: 'https://compute.test' });
      const forged = other.issue({
        nodeId: NODE,
        sid: 'tun_x',
        op: 'exec',
        subject: 'usr_mallory',
      });
      expect(await connect(`${base}/tunnels/${forged.token}`).opened).toBe(false);
      const offline = issuer.issue({
        nodeId: OFFLINE,
        sid: 'tun_y',
        op: 'exec',
        subject: 'usr_alice',
      });
      expect(await connect(`${base}/tunnels/${offline.token}`).opened).toBe(false);
      expect(recorded.opened).toEqual([]);

      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const client = connect(`${base}/${ticket.path}`);
      expect(await client.opened).toBe(true);
      allowed = false;
      const closed = await client.closed;
      expect(closed).toMatchObject({ code: 1008, reason: 'revoked' });
      await until(() => recorded.closed > 0);
      expect(recorded.closed).toBe(1);
    } finally {
      server.close();
    }
  });
});

// Regressions from the security review of 680c66f: handleTunnel never rejects, survives peers that
// vanish at any point, re-authorizes by identity, and enforces the IAM outage rule.
describe('tunnel endpoint hardening', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it('answers a malformed ticket and a failing store instead of rejecting (HIGH 1)', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const good = await listen({ relay: echoRelay(recorded) });
    const broken = await listen({
      relay: echoRelay(recorded),
      sql: { ...db, query: () => Promise.reject(new Error('database down')) } as SqlExecutor,
    });
    try {
      const bad = rawClient(good.port, '/api/compute/tunnels/%zz');
      await bad.closed;
      expect(bad.text()).toMatch(/^HTTP\/1\.1 400/);
      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const down = rawClient(broken.port, `/api/compute/${ticket.path}`);
      await down.closed;
      expect(down.text()).toMatch(/^HTTP\/1\.1 500/);
      expect([...good.outcomes, ...broken.outcomes]).toEqual([true, true]);
    } finally {
      good.server.close();
      broken.server.close();
    }
  });

  it('survives a caller that resets while the gateway opens, and closes the relay (HIGH 2)', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const { server, port, outcomes } = await listen({ relay: echoRelay(recorded, 150) });
    try {
      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const client = rawClient(port, `/api/compute/${ticket.path}`);
      await until(() => recorded.opened.length > 0 || outcomes.length > 0);
      client.socket.resetAndDestroy();
      await until(() => recorded.closed > 0);
      expect(recorded.closed).toBe(1);
      await until(() => outcomes.length > 0);
      expect(outcomes).toEqual([true]);
    } finally {
      server.close();
    }
  });

  it('ends the tunnel when the caller half-closes without a Close frame (MEDIUM 3)', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const { server, port } = await listen({ relay: echoRelay(recorded) });
    try {
      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const client = rawClient(port, `/api/compute/${ticket.path}`);
      await until(() => client.text().startsWith('HTTP/1.1 101'));
      client.socket.end();
      await until(() => recorded.closed > 0);
      expect(recorded.closed).toBe(1);
    } finally {
      server.close();
    }
  });

  it('closes on the IAM outage rule even when authorize hangs (MEDIUM 4)', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const { server, base } = await listen({
      relay: echoRelay(recorded),
      authorize: () => new Promise<boolean>(() => undefined),
      reauthorizeMs: 20,
      authorizeTimeoutMs: 30,
      iamOutageMs: 120,
    });
    try {
      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const client = connect(`${base}/${ticket.path}`);
      expect(await client.opened).toBe(true);
      expect(await client.closed).toMatchObject({ code: 1011, reason: 'iam-unreachable' });
    } finally {
      server.close();
    }
  });

  it('re-authorizes by identity and session when the client sends no headers (MEDIUM 5)', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const seen: TunnelReauthorization[] = [];
    const { server, base } = await listen({
      relay: echoRelay(recorded),
      authorize: async (input) => {
        seen.push(input);
        return true;
      },
      reauthorizeMs: 20,
    });
    try {
      const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
      const tunnel = connectTunnel({ url: `${base}/${ticket.path}` });
      await tunnel.ready;
      await until(() => seen.length >= 3);
      expect(seen[0]!.credential).toBeUndefined();
      expect(seen[0]!.claims).toMatchObject({
        sub: 'usr_alice',
        ses: 's',
        tnt: 'acme',
        inst: INSTANCE,
        sid: ticket.tunnelId,
      });
      tunnel.close();
      await tunnel.exited;
    } finally {
      server.close();
    }
  });

  it('refuses other WebSocket versions and protocol violations (LOW)', async () => {
    const recorded: Recorded = { opened: [], received: [], closed: 0 };
    const { server, port } = await listen({ relay: echoRelay(recorded) });
    try {
      const old = rawClient(port, '/api/compute/tunnels/x', 'sec-websocket-version: 8\r\n');
      await old.closed;
      expect(old.text()).toMatch(/^HTTP\/1\.1 426[\s\S]*sec-websocket-version: 13/);

      for (const [opcode, payload] of [
        [0xb, Buffer.alloc(0)], // reserved control opcode
        [0x8, Buffer.from([0x03, 0xed])], // close code 1005 may not be sent
        [0x8, Buffer.from([0x03])], // a one-byte close payload
      ] as const) {
        const ticket = await open({ tenantId: 'acme', instanceId: INSTANCE, op: 'exec' });
        const client = rawClient(port, `/api/compute/${ticket.path}`);
        await until(() => client.text().startsWith('HTTP/1.1 101'));
        client.sendFrame(opcode, payload);
        await client.closed;
        // The server's close frame carries 1002 (protocol error).
        const bytes = client.bytes();
        const close = bytes.lastIndexOf(0x88);
        expect(close).toBeGreaterThan(0);
        expect(bytes.readUInt16BE(close + 2)).toBe(1002);
      }
      await settle();
      expect(recorded.closed).toBe(recorded.opened.length);
    } finally {
      server.close();
    }
  });
});
