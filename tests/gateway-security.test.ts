import { connect, type ClientHttp2Session } from 'node:http2';
import { create } from '@bufbuild/protobuf';
import { ComputeError } from '@better-compute/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  frameMessage,
  GrpcCode,
  MessageDecoder,
  serveGateway,
  AGENT_GATEWAY_SERVICE,
  type ReportContext,
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
  AgentRole,
  decodeServerFrame,
  encodeAgentFrame,
  SignatureSchema,
  SignedTrustBundleSchema,
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
  const evidence = new Map<string, ReportContext['attested']>();
  const reports: ReportHandlers = {
    async allocationBound(tx, context, report) {
      evidence.set(report.allocationId, context.attested);
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
    evidence.clear();
    f = await gatewayFixture({ reports });
  });
  afterEach(() => f.close());

  it('hands handlers the attested envelope exactly as the node sent it, signed or not, never judged', async () => {
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    const unsigned = bound(node, 'alloc_plain');
    const signed = { ...bound(node, 'alloc_signed'), nodeSig: create(SignatureSchema, { kid: 'kid-1', sig: new Uint8Array([1, 2, 3]) }) };
    await handle.receive(
      agentFrame({
        case: 'events',
        value: {
          journalId: 'journal-1',
          events: [
            { seq: 1n, body: { case: 'attested', value: unsigned } },
            { seq: 2n, body: { case: 'attested', value: signed } },
          ],
        },
      }),
    );
    expect(evidence.get('alloc_plain')).toEqual({ body: unsigned.body, kid: '', sig: new Uint8Array(0) });
    // A signature that would never verify is still passed on as received: judging it is the worker's.
    expect(evidence.get('alloc_signed')).toEqual({ body: signed.body, kid: 'kid-1', sig: new Uint8Array([1, 2, 3]) });
    expect(seen.map((entry) => [entry.allocationId, entry.signed])).toEqual([
      ['alloc_plain', false],
      ['alloc_signed', true],
    ]);
  });

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
      // The production default: certificateAuthenticate built from the node CA roots.
      nodeRoots: [nodeCa.certificate],
      revocations,
      trustDomain: 'compute.test',
    });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await served.close(100);
    await f.close();
  });

  async function agent(nodeId: string, options: { role?: 'node' | 'site' | 'ramdisk'; trustDomain?: string } = {}) {
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

  it('never lets a ramdisk certificate open a node session (v0.2 exit), only a ramdisk one', async () => {
    const node = await f.addNode();
    const asNode = session((await agent(node, { role: 'ramdisk' })).client);
    asNode.stream.write(frameMessage(encodeAgentFrame(helloFrame(node))));
    expect(await asNode.status).toBe(GrpcCode.PERMISSION_DENIED);
    const { rows } = await f.db.query<{ session_epoch: number; role: string | null }>(
      'SELECT session_epoch, role FROM node_sessions WHERE node_id = $1',
      [node],
    );
    expect(rows).toEqual([{ session_epoch: 0, role: null }]);

    // The same certificate is fine for what it was issued for.
    const asRamdisk = session((await agent(node, { role: 'ramdisk' })).client);
    asRamdisk.stream.write(frameMessage(encodeAgentFrame(helloFrame(node, { role: AgentRole.RAMDISK }))));
    await expect.poll(() => asRamdisk.frames.map((frame) => frame.msg.case)).toEqual(['welcome']);
    expect(f.gateway.sessions()).toMatchObject([{ nodeId: node, role: 'ramdisk' }]);
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
describe('database-side revocation at Hello, and call context for the services', () => {
  let f: GatewayFixture;
  beforeEach(async () => {
    f = await gatewayFixture();
  });
  afterEach(() => f.close());

  async function record(nodeId: string, serial: string, options: { revoked?: boolean; identityGen?: number } = {}) {
    await f.db.query(
      `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after, revoked_at)
       VALUES ($1, $2, 'node', $3, '\\x00', '\\x00', compute_now() - interval '1 minute', compute_now() + interval '1 hour',
               CASE WHEN $4 THEN compute_now() END)`,
      [serial, nodeId, options.identityGen ?? 1, options.revoked ?? false],
    );
  }

  it('refuses a revoked or superseded certificate before touching the live session', async () => {
    const node = await f.addNode();
    await record(node, 'aa01');
    await record(node, 'aa02', { revoked: true });
    await record(node, 'aa03', { identityGen: 0 });
    const live = new FakeStream();
    await f.gateway.open({ nodeId: node, serial: 'aa01' }, live).receive(helloFrame(node));
    expect(live.of('welcome')).toHaveLength(1);

    for (const serial of ['aa02', 'aa03']) {
      const intruder = new FakeStream();
      await f.gateway.open({ nodeId: node, serial }, intruder).receive(helloFrame(node, { bootId: 'boot-x' }));
      expect(intruder.closed?.error).toMatchObject({ code: GrpcCode.UNAUTHENTICATED, message: 'certificate revoked' });
    }
    // The legitimate session was never superseded.
    expect(live.closed).toBeUndefined();
    expect(await f.session(node)).toMatchObject({ session_epoch: 1, boot_id: 'boot-1' });
  });

  it('passes { peerNodeId, gatewayId } to secret and renew, and { gatewayId } to join', async () => {
    const seen: { method: string; context: unknown }[] = [];
    f.services.services.secret = async (_request, context) => {
      seen.push({ method: 'secret', context });
      throw new ComputeError('NOT_FOUND', 'no such secret');
    };
    f.services.services.renew = async (_request, context) => {
      seen.push({ method: 'renew', context });
      throw new ComputeError('ACCESS_DENIED', 'no');
    };
    f.services.services.join = async (_request, context) => {
      seen.push({ method: 'join', context });
      throw new ComputeError('ACCESS_DENIED', 'no');
    };
    const node = await f.addNode();
    const { stream, handle } = await f.connect(node);
    await handle.receive(agentFrame({ case: 'secretRequest', value: { ref: 'secret://x', requestId: 'r' } }));
    await expect.poll(() => stream.of('secret').length).toBe(1);
    await expect(f.gateway.renew({} as never, { nodeId: node })).rejects.toBeDefined();
    await expect(f.gateway.join({} as never)).rejects.toBeDefined();
    expect(seen).toEqual([
      { method: 'secret', context: { peerNodeId: node, gatewayId: f.gateway.id } },
      { method: 'renew', context: { peerNodeId: node, gatewayId: f.gateway.id } },
      { method: 'join', context: { gatewayId: f.gateway.id } },
    ]);
  });
});
describe('trust bundle in Welcome', () => {
  it('relays the host-signed bundle current at each Hello, and survives a failing source', async () => {
    let version = 1;
    let fail = false;
    const f = await gatewayFixture({
      trustBundle: () => {
        if (fail) throw new Error('bundle store down');
        return create(SignedTrustBundleSchema, { body: new Uint8Array([version]) });
      },
    });
    try {
      const first = await f.connect(await f.addNode());
      expect(first.stream.of('welcome')[0]!.trust?.body).toEqual(new Uint8Array([1]));
      version = 2; // a root rotation: new sessions get it without a restart
      const second = await f.connect(await f.addNode());
      expect(second.stream.of('welcome')[0]!.trust?.body).toEqual(new Uint8Array([2]));
      fail = true;
      const third = await f.connect(await f.addNode());
      expect(third.stream.of('welcome')[0]!.trust).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});