// The client side of the gateway's gRPC transport (`@better-compute/gateway` http2.ts), over cleartext HTTP/2
// for the real-time harness (PLAN.md §15): a FakeDaemon's `AgentConn` carried on a real `Session` stream, and
// the unary `Join`. The framing is the gateway's own (`frameMessage` / `MessageDecoder`), so the two mirror each
// other by construction. Tests only: identity travels in the `x-bc-test-node` header that the harness's
// `authenticate` hook reads, never over TLS.

import {
  connect,
  constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
} from 'node:http2';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  AGENT_GATEWAY_SERVICE,
  decodeGrpcMessage,
  frameMessage,
  GrpcCode,
  MessageDecoder,
} from '@better-compute/gateway';
import {
  decodeServerFrame,
  encodeAgentFrame,
  JoinRequestSchema,
  JoinResponseSchema,
  MAX_FRAME_BYTES,
  type AgentFrame,
  type JoinRequest,
  type JoinResponse,
  type ServerFrame,
} from '@better-compute/protocol';
import type { AgentConn, CloseInfo, FrameHandler } from '../frame-conn.js';

/** The header the harness's `authenticate` hook reads over h2c. */
export const TEST_NODE_HEADER = 'x-bc-test-node';

/** A gRPC status a call or stream ended with. */
export interface GrpcStatus {
  code: number;
  message: string;
}

/**
 * A status from the response HEADERS (trailers-only: an immediate refusal) or the trailers, whichever comes
 * first; undefined until one arrives.
 */
function statusOf(headers: IncomingHttpHeaders): GrpcStatus | undefined {
  const raw = headers['grpc-status'];
  if (raw === undefined) return undefined;
  const message = headers['grpc-message'];
  return {
    code: Number(Array.isArray(raw) ? raw[0] : raw),
    message: typeof message === 'string' ? decodeGrpcMessage(message) : '',
  };
}

/** Whether a status asks the client to retry with jitter (`handshake rate exceeded`, `gateway busy`). */
export const isRetryable = (status: GrpcStatus | undefined): boolean =>
  status?.code === GrpcCode.RESOURCE_EXHAUSTED || status?.code === GrpcCode.UNAVAILABLE;

export interface H2cClientOptions {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** One HTTP/2 connection for every stream (default: a connection per `session()` call, like real daemons). */
  shared?: boolean;
}

export interface H2cClient {
  /** Opens a `Session` stream for `nodeId` as an `AgentConn`. */
  session(nodeId: string, headers?: Record<string, string>): AgentConn;
  /** The unary `Join`; rejects with `{ code, message }` on a non-OK status. */
  join(request: JoinRequest, headers?: Record<string, string>): Promise<JoinResponse>;
  /** The HTTP/2 connection (shared mode) for extra streams such as v0.3 tunnels. */
  readonly connection: ClientHttp2Session | undefined;
  close(): Promise<void>;
}

let conns = 0;

export function createH2cClient(options: H2cClientOptions): H2cClient {
  const owned = new Set<ClientHttp2Session>();
  let shared: ClientHttp2Session | undefined;
  const open = () => {
    const h2 = connect(options.url);
    h2.on('error', () => {});
    owned.add(h2);
    h2.on('close', () => owned.delete(h2));
    return h2;
  };
  const connection = () => {
    if (!options.shared) return { h2: open(), own: true };
    if (!shared || shared.destroyed || shared.closed) shared = open();
    return { h2: shared, own: false };
  };
  const request = (
    h2: ClientHttp2Session,
    method: 'Session' | 'Join',
    nodeId: string | undefined,
    headers: Record<string, string>,
  ) =>
    h2.request(
      {
        ':method': 'POST',
        ':path': `/${AGENT_GATEWAY_SERVICE}/${method}`,
        'content-type': 'application/grpc+proto',
        te: 'trailers',
        ...(nodeId ? { [TEST_NODE_HEADER]: nodeId } : {}),
        ...headers,
      },
      { endStream: false },
    );

  return {
    get connection() {
      return shared;
    },
    session(nodeId, headers = {}) {
      const { h2, own } = connection();
      return sessionConn(h2, own, request(h2, 'Session', nodeId, headers), `h2c-${++conns}`);
    },
    join(joinRequest, headers = {}) {
      const { h2, own } = connection();
      const stream = request(h2, 'Join', undefined, headers);
      return new Promise<JoinResponse>((resolve, reject) => {
        const decoder = new MessageDecoder(MAX_FRAME_BYTES);
        const messages: Uint8Array[] = [];
        let status: GrpcStatus | undefined;
        const done = () => {
          if (own) h2.close();
          if (!status || status.code !== GrpcCode.OK)
            return reject(status ?? { code: GrpcCode.UNKNOWN, message: 'no status' });
          if (messages.length !== 1)
            return reject({
              code: GrpcCode.INTERNAL,
              message: `expected one response, got ${messages.length}`,
            });
          resolve(fromBinary(JoinResponseSchema, messages[0]!));
        };
        stream.on('response', (headers) => (status ??= statusOf(headers)));
        stream.on('trailers', (headers) => (status ??= statusOf(headers)));
        stream.on('data', (chunk: Uint8Array) => {
          try {
            messages.push(...decoder.push(chunk));
          } catch (error) {
            status ??= { code: GrpcCode.INTERNAL, message: String(error) };
          }
        });
        stream.on('error', () => {});
        stream.on('close', done);
        stream.end(frameMessage(toBinary(JoinRequestSchema, joinRequest)));
      });
    },
    async close() {
      await Promise.all(
        [...owned].map(
          (h2) =>
            new Promise<void>((resolve) => {
              if (h2.destroyed) return resolve();
              h2.close(() => resolve());
              setTimeout(() => {
                h2.destroy();
                resolve();
              }, 500).unref();
            }),
        ),
      );
    },
  };
}

/** An `AgentConn` over one `Session` stream. */
function sessionConn(
  h2: ClientHttp2Session,
  ownsConnection: boolean,
  stream: ClientHttp2Stream,
  id: string,
): AgentConn {
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  const inbox: ServerFrame[] = [];
  const closeHandlers: ((info: CloseInfo) => void | Promise<void>)[] = [];
  let handler: FrameHandler<ServerFrame> | undefined;
  let delivering = false;
  let status: GrpcStatus | undefined;
  let closeInfo: CloseInfo | undefined;
  let localReason: string | undefined;

  const deliver = async () => {
    if (delivering || !handler) return;
    delivering = true;
    try {
      while (inbox.length && handler) await handler(inbox.shift()!);
    } finally {
      delivering = false;
    }
  };
  const finish = (info: CloseInfo) => {
    if (closeInfo) return;
    closeInfo = info;
    if (ownsConnection && !h2.destroyed) h2.close();
    for (const onClose of closeHandlers) void Promise.resolve(onClose(info)).catch(() => {});
  };

  stream.on('response', (headers) => (status ??= statusOf(headers)));
  stream.on('trailers', (headers) => (status ??= statusOf(headers)));
  stream.on('data', (chunk: Uint8Array) => {
    try {
      for (const bytes of decoder.push(chunk)) inbox.push(decodeServerFrame(bytes));
      void deliver();
    } catch (error) {
      localReason = `protocol-error: ${String(error)}`;
      stream.close(constants.NGHTTP2_PROTOCOL_ERROR);
    }
  });
  stream.on('error', () => {});
  // A close after the status (including the server's RST_STREAM(NO_ERROR) once it has answered) is normal.
  stream.on('close', () => {
    if (localReason !== undefined) return finish({ reason: localReason, by: 'local' });
    const reason = status
      ? status.code === GrpcCode.OK
        ? 'closed'
        : `grpc-${status.code}: ${status.message}`
      : 'stream-reset';
    finish({ reason, by: 'remote' });
  });

  return {
    id,
    get closed() {
      return closeInfo !== undefined || stream.closed || stream.destroyed;
    },
    get closeInfo() {
      return closeInfo;
    },
    send(frame: AgentFrame) {
      if (closeInfo || stream.closed || stream.destroyed || localReason !== undefined) return false;
      stream.write(frameMessage(encodeAgentFrame(frame)));
      return true;
    },
    onFrame(next) {
      handler = next;
      void deliver();
    },
    onClose(next) {
      closeHandlers.push(next);
      if (closeInfo) void Promise.resolve(next(closeInfo)).catch(() => {});
    },
    close(reason = 'closed') {
      if (localReason !== undefined || closeInfo) return;
      localReason = reason;
      stream.end();
    },
    abort(reason = 'aborted') {
      if (closeInfo) return;
      localReason = reason;
      stream.close(constants.NGHTTP2_CANCEL);
      if (ownsConnection) h2.destroy();
    },
    ping(timeoutMs, onResult) {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        onResult(false);
      }, timeoutMs);
      timer.unref();
      const ok = h2.ping((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onResult(!error);
      });
      if (!ok && !settled) {
        settled = true;
        clearTimeout(timer);
        onResult(false);
      }
    },
  };
}
