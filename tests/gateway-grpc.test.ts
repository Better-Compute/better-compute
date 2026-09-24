import { connect, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from 'node:http2';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import {
  AGENT_GATEWAY_SERVICE,
  decodeGrpcMessage,
  encodeGrpcMessage,
  frameMessage,
  GrpcCode,
  GrpcError,
  isGrpcContentType,
  MessageDecoder,
  serveGateway,
  spiffeAuthenticate,
  toGrpcError,
  type ServedGateway,
} from '@better-compute/gateway';
import {
  decodeServerFrame,
  encodeAgentFrame,
  JoinRequestSchema,
  JoinResponseSchema,
  ProtocolError,
  unwrapCommand,
  type ServerFrame,
} from '@better-compute/protocol';
import { agentFrame, gatewayFixture, helloFrame, type GatewayFixture } from './support/gateway.js';

// The gRPC/HTTP/2 transport (PLAN.md §7.1): framing, status trailers and the interop details
// grpc-go and connect-go check, driven by a real node:http2 client over h2c.

describe('framing', () => {
  it('splits a byte stream into length-prefixed messages across arbitrary chunk boundaries', () => {
    const messages = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array(300).fill(9)];
    const wire = Buffer.concat(messages.map(frameMessage));
    for (const size of [1, 2, 5, 7, 64, wire.length]) {
      const decoder = new MessageDecoder();
      const out: Uint8Array[] = [];
      for (let i = 0; i < wire.length; i += size) out.push(...decoder.push(wire.subarray(i, i + size)));
      expect(out.map((m) => [...m])).toEqual(messages.map((m) => [...m]));
      expect(decoder.pending).toBe(false);
    }
  });

  it('rejects compressed and oversized messages before buffering the body', () => {
    const compressed = frameMessage(new Uint8Array([1]));
    compressed[0] = 1;
    expect(() => new MessageDecoder().push(compressed)).toThrow(expect.objectContaining({ code: GrpcCode.INTERNAL }));
    const header = frameMessage(new Uint8Array(0));
    new DataView(header.buffer).setUint32(1, 1025);
    expect(() => new MessageDecoder(1024).push(header)).toThrow(
      expect.objectContaining({ code: GrpcCode.RESOURCE_EXHAUSTED }),
    );
  });

  it('percent-encodes grpc-message as the spec requires, and decodes it back', () => {
    const message = '50% done: ünïcode\nline';
    const encoded = encodeGrpcMessage(message);
    expect(encoded).toBe('50%25 done: %C3%BCn%C3%AFcode%0Aline');
    expect(decodeGrpcMessage(encoded)).toBe(message);
    expect(decodeGrpcMessage('bad %zz escape')).toBe('bad %zz escape');
  });

  it('recognises gRPC content types', () => {
    expect(isGrpcContentType('application/grpc')).toBe(true);
    expect(isGrpcContentType('application/grpc+proto; charset=utf-8')).toBe(true);
    expect(isGrpcContentType('application/grpc+json')).toBe(false);
    expect(isGrpcContentType('application/json')).toBe(false);
    expect(isGrpcContentType(undefined)).toBe(false);
  });

  it('maps errors to statuses without leaking internals', () => {
    expect(toGrpcError(new ComputeError('ACCESS_DENIED', 'no'))).toMatchObject({ code: GrpcCode.PERMISSION_DENIED });
    expect(toGrpcError(new ComputeError('NOT_IMPLEMENTED', 'later'))).toMatchObject({ code: GrpcCode.UNIMPLEMENTED });
    expect(toGrpcError(new ProtocolError('FRAME_TOO_LARGE', 'big'))).toMatchObject({ code: GrpcCode.RESOURCE_EXHAUSTED });
    expect(toGrpcError(new ProtocolError('INVALID_FRAME', 'bad'))).toMatchObject({ code: GrpcCode.INVALID_ARGUMENT });
    expect(toGrpcError(new Error('password=hunter2'))).toMatchObject({ code: GrpcCode.INTERNAL, message: 'internal error' });
  });
});

describe('spiffeAuthenticate', () => {
  const peer = (subjectaltname: string, authorized = true) =>
    ({ authorized, certificate: { subjectaltname } as never, headers: {} });
  it('reads the node and site from an authorized SPIFFE URI SAN', () => {
    expect(spiffeAuthenticate(peer('DNS:x, URI:spiffe://compute.test/site/site_1/node/node_2'))).toEqual({
      nodeId: 'node_2',
      siteId: 'site_1',
    });
  });
  it('rejects unauthorized chains and foreign SANs', () => {
    expect(spiffeAuthenticate(peer('URI:spiffe://compute.test/site/s/node/n', false))).toBeUndefined();
    expect(spiffeAuthenticate(peer('URI:spiffe://compute.test/workload/w'))).toBeUndefined();
    expect(spiffeAuthenticate({ authorized: true, headers: {} })).toBeUndefined();
  });
});

interface Call {
  stream: ClientHttp2Stream;
  headers: Promise<IncomingHttpHeaders>;
  /** Resolves with the status, from trailers or trailers-only headers. */
  status: Promise<{ code: number; message: string }>;
  messages: Uint8Array[];
  next(): Promise<Uint8Array>;
}

function call(client: ClientHttp2Session, method: string, headers: Record<string, string> = {}): Call {
  const stream = client.request({
    ':method': 'POST',
    ':path': `/${AGENT_GATEWAY_SERVICE}/${method}`,
    'content-type': 'application/grpc',
    te: 'trailers',
    ...headers,
  });
  const decoder = new MessageDecoder();
  const messages: Uint8Array[] = [];
  const waiters: ((message: Uint8Array) => void)[] = [];
  let read = 0;
  stream.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      messages.push(message);
      waiters.shift()?.(message);
    }
  });
  const responseHeaders = new Promise<IncomingHttpHeaders>((resolve) => stream.once('response', resolve));
  const status = new Promise<{ code: number; message: string }>((resolve) => {
    const settle = (h: IncomingHttpHeaders) => {
      if (h['grpc-status'] !== undefined)
        resolve({ code: Number(h['grpc-status']), message: decodeGrpcMessage(String(h['grpc-message'] ?? '')) });
    };
    stream.once('response', settle);
    stream.once('trailers', settle);
  });
  return {
    stream,
    headers: responseHeaders,
    status,
    messages,
    next() {
      if (read < messages.length) return Promise.resolve(messages[read++]!);
      return new Promise((resolve) => {
        waiters.push((message) => {
          read++;
          resolve(message);
        });
      });
    },
  };
}

const serverFrame = async (c: Call): Promise<ServerFrame> => decodeServerFrame(await c.next());

describe('serveGateway over h2c', () => {
  let f: GatewayFixture;
  let served: ServedGateway;
  let client: ClientHttp2Session;

  beforeEach(async () => {
    f = await gatewayFixture();
    served = await serveGateway(f.gateway, {
      insecure: true,
      authenticate: (peer) => {
        const nodeId = peer.headers['x-test-node'];
        return typeof nodeId === 'string' ? { nodeId, role: 'node' } : undefined;
      },
    });
    client = connect(`http://127.0.0.1:${served.port}`);
  });
  afterEach(async () => {
    client.close();
    await served.close();
    await f.close();
  });

  it('runs a Session: Hello → Welcome, dispatch, results and a clean OK end', async () => {
    const node = await f.addNode();
    const session = call(client, 'Session', { 'x-test-node': node, 'grpc-timeout': '5S' });
    session.stream.write(frameMessage(encodeAgentFrame(helloFrame(node))));
    const headers = await session.headers;
    expect(headers[':status']).toBe(200);
    expect(headers['content-type']).toBe('application/grpc+proto');
    const welcome = await serverFrame(session);
    expect(welcome.msg.case).toBe('welcome');

    const id = await f.enqueue(node);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(1);
    const command = await serverFrame(session);
    expect(command.msg.case === 'command' && unwrapCommand(command.msg.value).id).toBe(id);

    session.stream.write(
      frameMessage(encodeAgentFrame(agentFrame({ case: 'update', value: { commandId: id, state: 5 } }))),
    );
    const ack = await serverFrame(session);
    expect(ack.msg.case === 'ack' && ack.msg.value.commandIds).toEqual([id]);
    expect((await f.command(id)).state).toBe('succeeded');

    session.stream.end();
    expect(await session.status).toEqual({ code: GrpcCode.OK, message: '' });
    await expect.poll(async () => (await f.session(node)).gateway_id).toBeNull();
  });

  it('answers a Session without an identity with trailers-only UNAUTHENTICATED', async () => {
    const session = call(client, 'Session');
    session.stream.end();
    const headers = await session.headers;
    expect(headers['grpc-status']).toBe(String(GrpcCode.UNAUTHENTICATED));
    expect(await session.status).toMatchObject({ code: GrpcCode.UNAUTHENTICATED });
  });

  it('ends a session whose Hello is refused with the refusal status in trailers', async () => {
    const node = await f.addNode();
    const session = call(client, 'Session', { 'x-test-node': node });
    session.stream.write(frameMessage(encodeAgentFrame(helloFrame('node_someone_else'))));
    expect(await session.status).toEqual({
      code: GrpcCode.PERMISSION_DENIED,
      message: 'Hello.node_id does not match the certificate',
    });
  });

  it('drops a stream carrying an undecodable frame', async () => {
    const node = await f.addNode();
    const session = call(client, 'Session', { 'x-test-node': node });
    session.stream.write(frameMessage(new Uint8Array([0xff, 0xff, 0xff])));
    expect((await session.status).code).toBe(GrpcCode.INVALID_ARGUMENT);
  });

  it('marks the node disconnected when the client resets the stream', async () => {
    const node = await f.addNode();
    const session = call(client, 'Session', { 'x-test-node': node });
    session.stream.write(frameMessage(encodeAgentFrame(helloFrame(node))));
    await serverFrame(session);
    session.stream.close();
    await expect.poll(async () => (await f.session(node)).gateway_id).toBeNull();
    expect(f.gateway.sessions()).toEqual([]);
  });

  it('forwards Join as a unary call', async () => {
    const response = create(JoinResponseSchema, { body: new Uint8Array([4, 2]) });
    let seen: unknown;
    f.services.services.join = async (request) => {
      seen = request;
      return response;
    };
    const join = call(client, 'Join');
    join.stream.end(frameMessage(toBinary(JoinRequestSchema, create(JoinRequestSchema, { csr: new Uint8Array([1]) }))));
    const reply = fromBinary(JoinResponseSchema, await join.next());
    expect([...reply.body]).toEqual([4, 2]);
    expect(await join.status).toEqual({ code: GrpcCode.OK, message: '' });
    expect([...(seen as { csr: Uint8Array }).csr]).toEqual([1]);
  });

  it('maps a JoinService refusal to a trailers-only status with a percent-encoded message', async () => {
    f.services.services.join = async () => {
      throw new ComputeError('ACCESS_DENIED', 'token expired: 100% sure');
    };
    const join = call(client, 'Join');
    join.stream.end(frameMessage(toBinary(JoinRequestSchema, create(JoinRequestSchema, {}))));
    const headers = await join.headers;
    expect(headers['grpc-message']).toBe('token expired: 100%25 sure');
    expect(await join.status).toEqual({ code: GrpcCode.PERMISSION_DENIED, message: 'token expired: 100% sure' });
  });

  it('rejects unary calls without exactly one message', async () => {
    const join = call(client, 'Join');
    join.stream.end();
    expect((await join.status).code).toBe(GrpcCode.INVALID_ARGUMENT);
  });

  it('requires an identity for Renew', async () => {
    const renew = call(client, 'Renew');
    renew.stream.end();
    expect((await renew.status).code).toBe(GrpcCode.UNAUTHENTICATED);
  });

  it('requires an identity for Tunnel, and answers UNIMPLEMENTED for unknown methods', async () => {
    const anonymous = call(client, 'Tunnel');
    anonymous.stream.end();
    expect((await anonymous.status).code).toBe(GrpcCode.UNAUTHENTICATED);
    const unknown = call(client, 'Nope');
    unknown.stream.end();
    expect(await unknown.status).toMatchObject({ code: GrpcCode.UNIMPLEMENTED });
  });

  it('refuses non-POST requests and non-gRPC content types at the HTTP layer', async () => {
    const statusOf = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const stream = client.request(headers);
        stream.once('response', (h) => resolve(Number(h[':status'])));
        stream.end();
        stream.resume();
      });
    expect(await statusOf({ ':method': 'GET', ':path': `/${AGENT_GATEWAY_SERVICE}/Join` })).toBe(405);
    expect(
      await statusOf({ ':method': 'POST', ':path': `/${AGENT_GATEWAY_SERVICE}/Join`, 'content-type': 'application/json' }),
    ).toBe(415);
  });

  it('refuses to serve without TLS unless insecure is explicit', async () => {
    await expect(serveGateway(f.gateway)).rejects.toBeInstanceOf(GrpcError);
    await expect(serveGateway(f.gateway, { insecure: true })).rejects.toThrow(/authenticate/);
  });
});
