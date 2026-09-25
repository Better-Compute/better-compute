import {
  constants,
  createSecureServer,
  createServer,
  type Http2SecureServer,
  type Http2Server,
  type Http2Session,
  type IncomingHttpHeaders,
  type SecureServerOptions,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { DetailedPeerCertificate, TLSSocket } from 'node:tls';
import { fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { ComputeError, isComputeError } from '@better-compute/core';
import type { RevocationSet } from '@better-compute/pki';
import {
  JoinRequestSchema,
  JoinResponseSchema,
  RenewRequestSchema,
  RenewResponseSchema,
  TunnelFrameSchema,
  decodeAgentFrame,
  encodeServerFrame,
  MAX_FRAME_BYTES,
} from '@better-compute/protocol';
import type { Gateway, PeerIdentity, SessionHandle, SessionSink } from './gateway.js';
import type { TunnelStreamHandle } from './tunnels.js';
import { certificateAuthenticate } from './identity.js';
import { swapSecureContext, type TlsMaterial } from './tls-reload.js';
import {
  frameMessage,
  grpcResponseHeaders,
  GrpcCode,
  GrpcError,
  isGrpcContentType,
  MessageDecoder,
  statusTrailers,
  toGrpcError,
} from './grpc.js';

/** The fully qualified gRPC service (`proto/bettercompute/agent/v1/session.proto`). */
export const AGENT_GATEWAY_SERVICE = 'bettercompute.agent.v1.AgentGateway';

/** What the transport knows about a caller before any frame: its TLS state and request headers. */
export interface PeerContext {
  /** Whether the client certificate chains to `tls.ca` (always false over h2c). */
  authorized: boolean;
  certificate?: DetailedPeerCertificate;
  headers: IncomingHttpHeaders;
}

/** Maps a caller to a node identity; undefined rejects the call `UNAUTHENTICATED`. */
export type Authenticate = (peer: PeerContext) => PeerIdentity | undefined;

export interface ServeGatewayOptions {
  port?: number;
  host?: string;
  /**
   * mTLS (§7.1): `key`/`cert` from the gateway serving CA, `ca` = the node client CA roots. Client
   * certificates are requested but not required at the TLS layer, because `Join` is
   * server-authenticated only; `Renew` and `Session` require an authorized certificate.
   */
  tls?: SecureServerOptions;
  /**
   * Cleartext HTTP/2 (h2c) for tests and local development only. Requires `authenticate`, since
   * there is no certificate to read.
   */
  insecure?: boolean;
  /**
   * Maps a caller to a node identity. When omitted, `nodeRoots` is required and the gateway uses
   * `certificateAuthenticate` (chain to the node CA, revocation, role, serial): there is no weaker
   * default, because the serial and role drive `allowed_kinds`, revocation and role checks.
   */
  authenticate?: Authenticate;
  /** The node CA trust anchors (DER) for the default `certificateAuthenticate`. */
  nodeRoots?: readonly Uint8Array[];
  /** Revoked serials, refused at the handshake by the default authenticator. */
  revocations?: RevocationSet;
  /** Only this SPIFFE trust domain, for the default authenticator. */
  trustDomain?: string;
  /** HTTP/2 PING period (default 20 000 ms, §7.5). */
  pingIntervalMs?: number;
  /**
   * The listen backlog (default 4096; the kernel caps it at its own limit, e.g. `somaxconn`). A
   * reconnect storm (§7.8) dials thousands of connections at once, and Node's default of 511 refuses
   * the rest, sending those daemons into back-off.
   */
  backlog?: number;
}

export interface ServedGateway {
  server: Http2Server | Http2SecureServer;
  /** The bound port (useful with `port: 0`). */
  port: number;
  /** Stops accepting, sends GOAWAY, and destroys sessions still open after `graceMs` (1 000). */
  close(graceMs?: number): Promise<void>;
  /**
   * Hot-reloads the serving certificate (§7.1; e.g. from `watchTlsFiles`): new handshakes get it,
   * open sessions keep theirs. The rest of `tls` stays. Throws on a key that does not match.
   */
  setTls(material: TlsMaterial): void;
}

const spiffeNode = /^spiffe:\/\/[^/]+\/site\/([^/]+)\/node\/([^/]+)$/;

/**
 * UNSAFE outside tests: reads only the node id and site from a TLS-authorized certificate's SPIFFE
 * URI SAN. It yields no serial, role or expiry, so `node_certs.allowed_kinds`, revocation refusal,
 * certificate-expiry close and the Hello role check are all skipped. Production uses
 * `certificateAuthenticate`.
 */
export const unsafeSanOnlyAuthenticate: Authenticate = (peer) => {
  if (!peer.authorized || !peer.certificate) return undefined;
  const names = (peer.certificate.subjectaltname ?? '').split(/,\s*/);
  for (const name of names) {
    if (!name.startsWith('URI:')) continue;
    const match = spiffeNode.exec(name.slice(4));
    if (match) return { nodeId: decodeURIComponent(match[2]!), siteId: decodeURIComponent(match[1]!) };
  }
  return undefined;
};

function respondStatus(stream: ServerHttp2Stream, error: GrpcError): void {
  if (stream.destroyed || stream.closed) return;
  if (stream.headersSent) {
    // Headers went out already: the status can only travel in trailers.
    stream.close();
    return;
  }
  // Trailers-only: one HEADERS frame with END_STREAM carrying the status.
  stream.respond(
    { ...grpcResponseHeaders, ...statusTrailers(error.code, error.message, error.retryAfterMs) },
    { endStream: true },
  );
}

/** A response stream whose status goes out in trailers once `finish` is called. */
function openResponse(stream: ServerHttp2Stream) {
  let status: GrpcError | undefined;
  let finished = false;
  stream.respond({ ...grpcResponseHeaders }, { waitForTrailers: true });
  stream.on('wantTrailers', () => {
    const code = status?.code ?? GrpcCode.OK;
    stream.sendTrailers(statusTrailers(code, status?.message, status?.retryAfterMs));
    // The response is complete. A client still sending (it was refused mid-stream) is stopped
    // with RST_STREAM(NO_ERROR), which HTTP/2 allows after a full response (RFC 9113 §8.1).
    setImmediate(() => {
      if (!stream.closed && !stream.destroyed) stream.close(constants.NGHTTP2_NO_ERROR);
    });
  });
  return {
    /** False when the stream's write buffer is full ('drain' follows). */
    write(bytes: Uint8Array): boolean {
      if (finished || stream.destroyed) return true;
      return stream.write(frameMessage(bytes));
    },
    finish(error?: GrpcError) {
      if (finished || stream.destroyed) return;
      finished = true;
      status = error;
      stream.end();
    },
    get finished() {
      return finished || stream.destroyed;
    },
  };
}

function peerContext(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): PeerContext {
  const socket = stream.session?.socket as TLSSocket | undefined;
  const tls = typeof socket?.getPeerCertificate === 'function';
  const certificate = tls ? socket!.getPeerCertificate(true) : undefined;
  return {
    authorized: tls ? Boolean(socket!.authorized) : false,
    certificate: certificate && Object.keys(certificate).length ? certificate : undefined,
    headers,
  };
}

/** Collects exactly one request message (unary calls). */
async function readUnary<Desc extends DescMessage>(
  stream: ServerHttp2Stream,
  schema: Desc,
): Promise<MessageShape<Desc>> {
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  const messages: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) messages.push(...decoder.push(chunk));
  if (decoder.pending) throw new GrpcError(GrpcCode.INVALID_ARGUMENT, 'truncated request message');
  if (messages.length !== 1)
    throw new GrpcError(GrpcCode.INVALID_ARGUMENT, `expected one request message, got ${messages.length}`);
  try {
    return fromBinary(schema, messages[0]!);
  } catch (error) {
    throw new GrpcError(GrpcCode.INVALID_ARGUMENT, `cannot decode ${schema.typeName}: ${String(error)}`);
  }
}

async function unary<Req extends DescMessage, Res extends DescMessage>(
  stream: ServerHttp2Stream,
  requestSchema: Req,
  responseSchema: Res,
  call: (request: MessageShape<Req>) => Promise<MessageShape<Res>>,
): Promise<void> {
  try {
    const request = await readUnary(stream, requestSchema);
    const response = await call(request);
    const out = openResponse(stream);
    out.write(toBinary(responseSchema, response));
    out.finish();
  } catch (error) {
    respondStatus(stream, toGrpcError(error));
  }
}

function session(stream: ServerHttp2Stream, gateway: Gateway, peer: PeerIdentity): void {
  let handle: SessionHandle | undefined;
  let out: ReturnType<typeof openResponse> | undefined;
  const sink: SessionSink = {
    send(frame) {
      out?.write(encodeServerFrame(frame));
    },
    close(error) {
      if (out) out.finish(error);
      else respondStatus(stream, error ?? new GrpcError(GrpcCode.OK, ''));
    },
  };
  try {
    handle = gateway.open(peer, sink);
  } catch (error) {
    respondStatus(stream, toGrpcError(error));
    stream.resume();
    return;
  }
  out = openResponse(stream);
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  const current = handle;
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    void current.end(reason).then(() => out?.finish());
  };
  stream.on('data', (chunk: Uint8Array) => {
    if (ended) return;
    try {
      for (const bytes of decoder.push(chunk)) void current.receive(decodeAgentFrame(bytes));
    } catch (error) {
      out?.finish(toGrpcError(error));
      end('protocol-error');
    }
  });
  stream.on('end', () => end('stream-closed'));
  stream.on('aborted', () => end('stream-aborted'));
  stream.on('close', () => end('stream-closed'));
  stream.on('error', () => end('stream-error'));
}

/** A `Tunnel` stream from a daemon (v0.3): length-prefixed TunnelFrames both ways, relayed by the core. */
function tunnel(stream: ServerHttp2Stream, gateway: Gateway, peer: PeerIdentity): void {
  const out = openResponse(stream);
  let handle: TunnelStreamHandle;
  try {
    handle = gateway.acceptTunnel(peer, {
      send: (frame) => out.write(toBinary(TunnelFrameSchema, frame)),
      onDrain: (callback) => void stream.once('drain', callback),
      pause: () => stream.pause(),
      resume: () => stream.resume(),
      close: (error) => out.finish(error),
    });
  } catch (error) {
    out.finish(toGrpcError(error));
    stream.resume();
    return;
  }
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    handle.end(reason);
    out.finish();
  };
  stream.on('data', (chunk: Uint8Array) => {
    if (ended) return;
    try {
      for (const bytes of decoder.push(chunk)) handle.receive(fromBinary(TunnelFrameSchema, bytes));
    } catch (error) {
      out.finish(toGrpcError(error));
      end('protocol-error');
    }
  });
  stream.on('end', () => end('node-closed'));
  stream.on('close', () => end('node-closed'));
  stream.on('error', () => end('node-error'));
}

/**
 * Serves `gateway` as the gRPC `AgentGateway` service on HTTP/2 (§7.1). `Join` needs no client
 * certificate; `Renew`, `Session` and `Tunnel` (v0.3, the daemon's side of an interactive tunnel)
 * need one that `authenticate` accepts. Unknown methods answer `UNIMPLEMENTED`.
 */
export async function serveGateway(
  gateway: Gateway,
  options: ServeGatewayOptions = {},
): Promise<ServedGateway> {
  if (!options.tls && !options.insecure)
    throw new ComputeError('INVALID_CONFIG', 'serveGateway needs tls, or insecure for tests');
  if (options.insecure && !options.authenticate)
    throw new ComputeError('INVALID_CONFIG', 'insecure (h2c) serving needs an authenticate hook');
  if (!options.authenticate && !options.nodeRoots?.length)
    throw new ComputeError(
      'INVALID_CONFIG',
      'serveGateway needs nodeRoots (the node CA) for certificateAuthenticate, or an explicit authenticate hook',
    );
  const authenticate =
    options.authenticate ??
    certificateAuthenticate({
      roots: options.nodeRoots!,
      ...(options.revocations ? { revocations: options.revocations } : {}),
      ...(options.trustDomain ? { trustDomain: options.trustDomain } : {}),
    });
  const server = options.tls
    ? createSecureServer({ ...options.tls, requestCert: true, rejectUnauthorized: false, allowHTTP1: false })
    : createServer();

  const pingIntervalMs = options.pingIntervalMs ?? 20_000;
  const liveSessions = new Set<Http2Session>();
  server.on('session', (h2: Http2Session) => {
    liveSessions.add(h2);
    const timer = setInterval(() => {
      if (!h2.destroyed) h2.ping(() => {});
    }, pingIntervalMs);
    timer.unref();
    h2.on('close', () => {
      clearInterval(timer);
      liveSessions.delete(h2);
    });
  });

  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    stream.on('error', () => {});
    if (headers[':method'] !== 'POST') {
      stream.respond({ ':status': 405 }, { endStream: true });
      return;
    }
    if (!isGrpcContentType(headers['content-type'])) {
      stream.respond({ ':status': 415 }, { endStream: true });
      return;
    }
    // `grpc-timeout` is tolerated and not enforced: sessions are long-lived by design.
    const path = String(headers[':path'] ?? '');
    const method = path.startsWith(`/${AGENT_GATEWAY_SERVICE}/`)
      ? path.slice(AGENT_GATEWAY_SERVICE.length + 2)
      : undefined;
    const identify = () => {
      try {
        return authenticate(peerContext(stream, headers));
      } catch (error) {
        if (isComputeError(error)) return undefined;
        throw error;
      }
    };
    switch (method) {
      case 'Join':
        void unary(stream, JoinRequestSchema, JoinResponseSchema, (request) => gateway.join(request));
        return;
      case 'Renew': {
        const peer = identify();
        if (!peer) {
          respondStatus(stream, new GrpcError(GrpcCode.UNAUTHENTICATED, 'a valid node certificate is required'));
          stream.resume();
          return;
        }
        void unary(stream, RenewRequestSchema, RenewResponseSchema, (request) => gateway.renew(request, peer));
        return;
      }
      case 'Session': {
        const peer = identify();
        if (!peer) {
          respondStatus(stream, new GrpcError(GrpcCode.UNAUTHENTICATED, 'a valid node certificate is required'));
          stream.resume();
          return;
        }
        session(stream, gateway, peer);
        return;
      }
      case 'Tunnel': {
        const peer = identify();
        if (!peer) {
          respondStatus(stream, new GrpcError(GrpcCode.UNAUTHENTICATED, 'a valid node certificate is required'));
          stream.resume();
          return;
        }
        tunnel(stream, gateway, peer);
        return;
      }
      default:
        respondStatus(stream, new GrpcError(GrpcCode.UNIMPLEMENTED, `unknown method ${path}`));
        stream.resume();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', options.backlog ?? 4096, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    setTls: (material) => swapSecureContext(server as Http2SecureServer, options.tls, material),
    close: (graceMs = 1_000) =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // GOAWAY first; sessions are long-lived by design, so whatever is left after the grace
        // period is destroyed (daemons redial another gateway).
        for (const h2 of liveSessions) h2.close();
        const timer = setTimeout(() => {
          for (const h2 of liveSessions) h2.destroy();
        }, graceMs);
        timer.unref();
      }),
  };
}
