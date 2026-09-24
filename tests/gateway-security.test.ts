import { connect, type ClientHttp2Session } from 'node:http2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  certificateAuthenticate,
  frameMessage,
  GrpcCode,
  MessageDecoder,
  serveGateway,
  AGENT_GATEWAY_SERVICE,
  type ReportHandlers,
  type ServedGateway,
} from '@better-compute/gateway';
import {
  createCsr,
  createNodeCa,
  createRevocationSet,
  createServingCa,
  generateP256KeyPair,
  nodeSpiffeId,
  privateKeyPem,
  toPem,
  type RevocationSet,
} from '@better-compute/pki';
import {
  decodeServerFrame,
  encodeAgentFrame,
  wrapAttestedReport,
  type ServerFrame,
} from '@better-compute/protocol';
import { agentFrame, FakeStream, gatewayFixture, helloFrame, SITE, type GatewayFixture } from './support/gateway.js';

// Security negatives of PLAN.md §13/§16 at the gateway: report handlers only see the session's own
// node, tenant-controlled nodes get no secrets or destructive commands, revocation closes live
// sessions at once, and a real mTLS handshake decides the node id (never a frame).

const bound = (nodeId: string, allocationId: string) =>
  wrapAttestedReport({
    $typeName: 'bettercompute.agent.v1.AttestedReportBody',
    nodeId,
    bootId: 'boot-1',
    report: {
      case: 'allocationBound',
      value: {
        $typeName: 'bettercompute.agent.v1.AllocationBound',
        allocationId,
        generation: 1n,
        deviceIds: ['GPU-a'],
        cdiDevices: ['bcd.dev/gpu=GPU-a'],
        cdiSpecPath: `/etc/cdi/bcd-${allocationId}.json`,
        envFile: '/run/bcd/env',
      },
    },
  });

describe('report handlers', () => {
  let f: GatewayFixture;
  const seen: { allocationId: string; nodeId: string; seq: number; signed: boolean }[] = [];
  const reports: ReportHandlers = {
    async allocationBound(tx, context, report) {
      if (report.allocationId === 'alloc_poison') {
        await tx.query(`UPDATE nodes SET cordoned = true WHERE id = $1`, [context.nodeId]);
        throw new Error('boom');
      }
      seen.push({ allocationId: report.allocationId, nodeId: context.nodeId, seq: context.seq, signed: context.signed });
      await context.work.enqueue(tx, 'capacity.reservations', report.allocationId);
    },
    async allocationFailed(_tx, context, report) {
      seen.push({ allocationId: `failed:${report.allocationId}`, nodeId: context.nodeId, seq: context.seq, signed: false });
    },
  };
  beforeEach(async () => {
    seen.length = 0;
    f = await gatewayFixture({ reports });
  });
  afterEach(() => f.close());

  it('applies reports in the ingest transaction, isolates a failing handler and never passes foreign reports', async () => {
    const node = await f.addNode();
    const { stream, handle } = await f.connect(node);
    await handle.receive(
      agentFrame({
        case: 'events',
        value: {
          journalId: 'journal-1',
          events: [
            { seq: 1n, body: { case: 'attested', value: bound(node, 'alloc_1') } },
            { seq: 2n, body: { case: 'attested', value: bound('node_victim', 'alloc_2') } },
            { seq: 3n, body: { case: 'attested', value: bound(node, 'alloc_poison') } },
            { seq: 4n, body: { case: 'allocationFailed', value: { allocationId: 'alloc_4', reason: 'overlap' } } },
          ],
        },
      }),
    );
    expect(seen).toEqual([
      { allocationId: 'alloc_1', nodeId: node, seq: 1, signed: false },
      { allocationId: 'failed:alloc_4', nodeId: node, seq: 4, signed: false },
    ]);
    expect(stream.of('ack').at(-1)!.eventSeq).toBe(4n);
    expect(stream.closed).toBeUndefined();
    // The poison handler's write rolled back with its savepoint; the failure is published.
    const { rows } = await f.db.query('SELECT cordoned FROM nodes WHERE id = $1', [node]);
    expect(rows).toEqual([{ cordoned: false }]);
    expect((await f.outbox('node.report-failed')).map((row) => row.payload.data)).toEqual([
      expect.objectContaining({ seq: 3, error: 'boom' }),
    ]);
    expect(await f.outbox('security.node-mismatch')).toHaveLength(1);
    const { rows: work } = await f.db.query(`SELECT key FROM work_queue WHERE kind = 'capacity.reservations'`);
    expect(work).toEqual([{ key: 'alloc_1' }]);

    // A replayed batch is deduplicated: no handler runs twice.
    await handle.receive(
      agentFrame({
        case: 'events',
        value: { journalId: 'journal-1', events: [{ seq: 1n, body: { case: 'attested', value: bound(node, 'alloc_1') } }] },
      }),
    );
    expect(seen).toHaveLength(2);
  });
});

describe('tenant-controlled nodes', () => {
  let f: GatewayFixture;
  beforeEach(async () => {
    f = await gatewayFixture();
  });
  afterEach(() => f.close());

  it('get no secrets and no destructive commands, but ordinary ones', async () => {
    const node = await f.addNode();
    const reset = await f.enqueue(node, { kind: 'gpu.reset' });
    const reboot = await f.enqueue(node, { kind: 'node.reboot' });
    const diag = await f.enqueue(node);
    const stream = new FakeStream();
    const handle = f.gateway.open({ nodeId: node, role: 'node', tenantControlled: true }, stream);
    await handle.receive(helloFrame(node));
    await f.gateway.jobs.dispatch.tick();
    expect(stream.commandIds()).toEqual([diag]);
    expect(await f.command(reset)).toMatchObject({ state: 'cancelled', reason: 'tenant-controlled' });
    expect(await f.command(reboot)).toMatchObject({ state: 'cancelled', reason: 'tenant-controlled' });

    await handle.receive(agentFrame({ case: 'secretRequest', value: { ref: 'secret://bmc', requestId: 'r' } }));
    expect(stream.of('secret')).toEqual([expect.objectContaining({ error: 'access-denied' })]);
    expect(f.services.calls).toEqual([]);
  });
});

describe('revocation and expiry', () => {
  let f: GatewayFixture;
  let revocations: RevocationSet;
  beforeEach(async () => {
    revocations = createRevocationSet();
    f = await gatewayFixture({ revocations });
  });
  afterEach(() => f.close());

  it('refuses a revoked certificate and closes the live session carrying it at once', async () => {
    const node = await f.addNode();
    const stream = new FakeStream();
    await f.gateway.open({ nodeId: node, serial: 'abc123' }, stream).receive(helloFrame(node));
    expect(stream.of('welcome')).toHaveLength(1);

    revocations.add('ABC123', { reason: 'key compromise' });
    await expect.poll(() => stream.closed?.error?.code).toBe(GrpcCode.UNAUTHENTICATED);
    expect(stream.of('revoked')[0]).toMatchObject({ reason: 'key compromise' });
    expect([...stream.of('revoked')[0]!.serials[0]!]).toEqual([0xab, 0xc1, 0x23]);
    await expect.poll(async () => (await f.session(node)).gateway_id).toBeNull();

    expect(() => f.gateway.open({ nodeId: node, serial: 'abc123' }, new FakeStream())).toThrow(/revoked/);
  });

  it('closes a session when its certificate expires', async () => {
    const node = await f.addNode();
    const stream = new FakeStream();
    await f.gateway
      .open({ nodeId: node, serial: '1', notAfter: f.clock.now() + 5_000 }, stream)
      .receive(helloFrame(node));
    await f.advance(4_000);
    await f.gateway.jobs.liveness.tick();
    expect(stream.closed).toBeUndefined();
    await f.advance(2_000);
    await f.gateway.jobs.liveness.tick();
    expect(stream.closed?.error).toMatchObject({ code: GrpcCode.UNAUTHENTICATED, message: 'certificate expired; renew and reconnect' });
  });
});

describe('mutual TLS', () => {
  let f: GatewayFixture;
  let served: ServedGateway;
  let revocations: RevocationSet;
  const nodeCa = createNodeCa();
  const servingCa = createServingCa();
  const clients: ClientHttp2Session[] = [];

  beforeEach(async () => {
    revocations = createRevocationSet();
    f = await gatewayFixture({ revocations });
    const gatewayKey = generateP256KeyPair();
    const serving = await servingCa.issue(gatewayKey.publicKey, {
      usage: 'server',
      dnsSans: ['gw.compute.test'],
      ttlSeconds: 86_400,
    });
    served = await serveGateway(f.gateway, {
      tls: {
        key: privateKeyPem(gatewayKey.privateKey),
        cert: [serving.certificate, ...serving.chain].map((der) => toPem(der)).join(''),
        ca: toPem(nodeCa.certificate),
        minVersion: 'TLSv1.3',
      },
      authenticate: certificateAuthenticate({
        roots: [nodeCa.certificate],
        revocations,
        trustDomain: 'compute.test',
      }),
    });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await served.close(100);
    await f.close();
  });

  async function agent(nodeId: string, options: { role?: 'node' | 'site'; trustDomain?: string } = {}) {
    const key = generateP256KeyPair();
    const issued = await nodeCa.sign(createCsr(key.privateKey), {
      usage: 'client',
      role: options.role ?? 'node',
      ttlSeconds: 3_600,
      uriSans: [nodeSpiffeId({ trustDomain: options.trustDomain ?? 'compute.test', siteId: SITE, nodeId })],
    });
    const client = connect(`https://127.0.0.1:${served.port}`, {
      ca: toPem(servingCa.certificate),
      key: privateKeyPem(key.privateKey),
      cert: [issued.certificate, ...issued.chain].map((der) => toPem(der)).join(''),
      servername: 'gw.compute.test',
      checkServerIdentity: () => undefined,
    });
    client.on('error', () => {});
    clients.push(client);
    return { client, serial: issued.serial };
  }

  function session(client: ClientHttp2Session) {
    const stream = client.request({
      ':method': 'POST',
      ':path': `/${AGENT_GATEWAY_SERVICE}/Session`,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    const decoder = new MessageDecoder();
    const frames: ServerFrame[] = [];
    stream.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) frames.push(decodeServerFrame(message));
    });
    const status = new Promise<number>((resolve) => {
      const settle = (headers: Record<string, unknown>) => {
        if (headers['grpc-status'] !== undefined) resolve(Number(headers['grpc-status']));
      };
      stream.once('response', settle);
      stream.once('trailers', settle);
    });
    stream.on('error', () => {});
    return { stream, frames, status };
  }

  it('takes the node id from the verified certificate, and pushes a revocation to the live stream', async () => {
    const node = await f.addNode();
    const { client, serial } = await agent(node);
    const s = session(client);
    s.stream.write(frameMessage(encodeAgentFrame(helloFrame(node))));
    await expect.poll(() => s.frames.map((frame) => frame.msg.case)).toEqual(['welcome']);
    expect(f.gateway.sessions()).toMatchObject([{ nodeId: node }]);

    const started = Date.now();
    revocations.add(serial, { reason: 'decommissioned' });
    expect(await s.status).toBe(GrpcCode.UNAUTHENTICATED);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(s.frames.map((frame) => frame.msg.case)).toEqual(['welcome', 'revoked']);
  });

  it("refuses a Hello for another node than the certificate's", async () => {
    const node = await f.addNode();
    const victim = await f.addNode();
    const { client } = await agent(node);
    const s = session(client);
    s.stream.write(frameMessage(encodeAgentFrame(helloFrame(victim))));
    expect(await s.status).toBe(GrpcCode.PERMISSION_DENIED);
    expect((await f.session(victim)).session_epoch).toBe(0);
  });

  it('refuses certificates from a foreign trust domain or with the wrong role for Hello', async () => {
    const node = await f.addNode();
    const foreign = session((await agent(node, { trustDomain: 'evil.test' })).client);
    foreign.stream.end();
    expect(await foreign.status).toBe(GrpcCode.UNAUTHENTICATED);

    const site = session((await agent(node, { role: 'site' })).client);
    site.stream.write(frameMessage(encodeAgentFrame(helloFrame(node))));
    expect(await site.status).toBe(GrpcCode.PERMISSION_DENIED);
  });

  it('refuses a client without a certificate for Session but lets it Join', async () => {
    const client = connect(`https://127.0.0.1:${served.port}`, {
      ca: toPem(servingCa.certificate),
      servername: 'gw.compute.test',
      checkServerIdentity: () => undefined,
    });
    client.on('error', () => {});
    clients.push(client);
    const s = session(client);
    s.stream.end();
    expect(await s.status).toBe(GrpcCode.UNAUTHENTICATED);

    const join = client.request({
      ':method': 'POST',
      ':path': `/${AGENT_GATEWAY_SERVICE}/Join`,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    join.end(frameMessage(new Uint8Array(0)));
    const status = await new Promise<number>((resolve) => {
      join.once('response', (headers) => {
        if (headers['grpc-status'] !== undefined) resolve(Number(headers['grpc-status']));
      });
      join.once('trailers', (headers) => resolve(Number(headers['grpc-status'])));
    });
    join.resume();
    // Forwarded: the fake JoinService answers NOT_IMPLEMENTED.
    expect(status).toBe(GrpcCode.UNIMPLEMENTED);
    expect(f.services.calls.map((call) => call.method)).toEqual(['join']);
  });
});

describe('restricted certificates (node_certs.allowed_kinds)', () => {
  let f: GatewayFixture;
  beforeEach(async () => {
    f = await gatewayFixture();
  });
  afterEach(() => f.close());

  async function cert(nodeId: string, serial: string, allowed: string[] | null) {
    await f.db.query(
      `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after, allowed_kinds)
       VALUES ($1, $2, 'ramdisk', 1, '\\x00', '\\x00', compute_now() - interval '1 minute', compute_now() + interval '1 hour', $3)`,
      [serial, nodeId, allowed],
    );
  }

  it('dispatches only allowed kinds; the rest are cancelled kind-not-allowed', async () => {
    const node = await f.addNode();
    await cert(node, 'a1', ['inventory.*', 'diag.*']);
    const diag = await f.enqueue(node);
    const refresh = await f.enqueue(node, { kind: 'inventory.refresh' });
    const reset = await f.enqueue(node, { kind: 'gpu.reset' });
    const reboot = await f.enqueue(node, { kind: 'node.reboot' });
    const stream = new FakeStream();
    await f.gateway.open({ nodeId: node, serial: 'a1' }, stream).receive(helloFrame(node));
    await f.gateway.jobs.dispatch.tick();
    expect(stream.commandIds().sort()).toEqual([diag, refresh].sort());
    for (const id of [reset, reboot])
      expect(await f.command(id)).toMatchObject({ state: 'cancelled', reason: 'kind-not-allowed' });
  });

  it('cancels in-flight commands of a disallowed kind instead of replaying them after a restricted re-join', async () => {
    const node = await f.addNode();
    await cert(node, 'b2', ['diag.*']);
    const reset = await f.enqueue(node, { kind: 'gpu.reset' });
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    expect(first.stream.commandIds()).toEqual([reset]);
    await first.handle.end();

    const stream = new FakeStream();
    await f.gateway.open({ nodeId: node, serial: 'b2' }, stream).receive(helloFrame(node));
    expect(stream.commandIds()).toEqual([]);
    expect(await f.command(reset)).toMatchObject({ state: 'cancelled', reason: 'kind-not-allowed' });
  });

  it('treats NULL allowed_kinds and unknown serials as unrestricted', async () => {
    const node = await f.addNode();
    await cert(node, 'c3', null);
    const reset = await f.enqueue(node, { kind: 'gpu.reset' });
    const stream = new FakeStream();
    await f.gateway.open({ nodeId: node, serial: 'c3' }, stream).receive(helloFrame(node));
    await f.gateway.jobs.dispatch.tick();
    expect(stream.commandIds()).toEqual([reset]);
  });
});