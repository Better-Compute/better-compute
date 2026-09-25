import {
  connect,
  constants,
  createSecureServer,
  createServer,
  type ClientHttp2Session,
  type Http2SecureServer,
  type Http2Server,
  type Http2Session,
  type IncomingHttpHeaders,
  type SecureServerOptions,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { ComputeError, isComputeError, type Notifier, type SqlTx } from '@better-compute/core';
import { MAX_FRAME_BYTES, TunnelFrameSchema, type TunnelFrame } from '@better-compute/protocol';
import type { Gateway, GatewayStatus } from './gateway.js';
import { frameMessage, MessageDecoder } from './grpc.js';
import type { TunnelHandle, TunnelInfo } from './tunnels.js';

// The gateway's internal control API on `gateways.internal_url` (PLAN.md §8.1), HTTP/2 only, called
// by api and worker processes over the internal CA's mTLS. Every call but tunnels is an
// accelerator: dispatch polls every second, specs re-push on the sweep, revocations arrive through
// the RevocationFeed and cancellations from the database, so correctness never depends on it.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const invalid = (message: string) => json(400, { error: { code: 'INVALID_INPUT', message } });

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const routes = ['/v1/health', '/v1/poke', '/v1/revoke', '/v1/drain', '/v1/tunnels/close'];

/**
 * The control API as a fetch handler (everything but the tunnel stream):
 * - `GET /v1/health` → `GatewayStatus`;
 * - `POST /v1/poke {nodeIds?}` → 202 (dispatch + spec check now);
 * - `POST /v1/revoke {nodeId, reason, serials?: hex[]}` → `{ revoked }`;
 * - `POST /v1/drain {reason?}` → 202;
 * - `POST /v1/tunnels/close {tunnelId? nodeId? subject?, reason}` → `{ closed }` (e.g. `delegation:revoke`).
 */
export function internalHandler(gateway: Gateway): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    switch (`${request.method} ${path}`) {
      case 'GET /v1/health':
        return json(200, gateway.status());
      case 'POST /v1/poke': {
        const input = await body(request);
        if (!input || (input.nodeIds !== undefined && !stringArray(input.nodeIds)))
          return invalid('poke takes { nodeIds?: string[] }');
        gateway.poke(input.nodeIds as string[] | undefined);
        return json(202, { accepted: true });
      }
      case 'POST /v1/revoke': {
        const input = await body(request);
        if (
          !input ||
          typeof input.nodeId !== 'string' ||
          typeof input.reason !== 'string' ||
          (input.serials !== undefined &&
            (!stringArray(input.serials) || input.serials.some((serial) => !/^[0-9a-f]{1,40}$/i.test(serial))))
        )
          return invalid('revoke takes { nodeId, reason, serials?: hex[] }');
        const serials = (input.serials ?? []).map((serial) =>
          new Uint8Array(Buffer.from(serial.length % 2 ? `0${serial}` : serial, 'hex')),
        );
        return json(200, { revoked: await gateway.revoke(input.nodeId, { reason: input.reason, serials }) });
      }
      case 'POST /v1/drain': {
        const input = await body(request);
        if (!input || (input.reason !== undefined && typeof input.reason !== 'string'))
          return invalid('drain takes { reason?: string }');
        await gateway.drain({ reason: input.reason as string | undefined });
        return json(202, { accepted: true });
      }
      case 'POST /v1/tunnels/close': {
        const input = await body(request);
        const filter: { tunnelId?: string; nodeId?: string; subject?: string } = {};
        for (const key of ['tunnelId', 'nodeId', 'subject'] as const)
          if (typeof input?.[key] === 'string') filter[key] = input[key] as string;
        if (!input || typeof input.reason !== 'string' || !Object.keys(filter).length)
          return invalid('tunnels/close takes { tunnelId? nodeId? subject? (at least one), reason }');
        return json(200, { closed: gateway.closeTunnels(filter, input.reason) });
      }
      default:
        return routes.includes(path) || path === '/v1/tunnels'
          ? json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} ${path}` } })
          : json(404, { error: { code: 'NOT_FOUND', message: path } });
    }
  };
}

export interface ServeInternalOptions {
  port?: number;
  host?: string;
  /** Internal-CA mTLS: `key`/`cert` for this gateway, `ca` = the internal CA. */
  tls?: SecureServerOptions;
  /** Cleartext HTTP/2 on loopback, for tests only. */
  insecure?: boolean;
}

export interface ServedInternal {
  server: Http2Server | Http2SecureServer;
  port: number;
  close(): Promise<void>;
}

async function readAll(stream: ServerHttp2Stream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new ComputeError('PAYLOAD_TOO_LARGE', 'control requests are small');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The duplex behind `POST /v1/tunnels`: the api's side of one tunnel. */
function tunnelStream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, gateway: Gateway): void {
  const ticket = headers['x-bc-ticket'];
  const nodeId = headers['x-bc-node'];
  const refuse = (status: number, code: string, message: string) => {
    if (stream.destroyed || stream.headersSent) return stream.close(constants.NGHTTP2_CANCEL);
    stream.respond({ ':status': status, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ error: { code, message } }));
  };
  if (typeof ticket !== 'string' || typeof nodeId !== 'string')
    return refuse(400, 'INVALID_INPUT', 'x-bc-ticket and x-bc-node are required');

  let handle: TunnelHandle | undefined;
  const early: TunnelFrame[] = [];
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  let ended = false;
  stream.on('data', (chunk: Uint8Array) => {
    if (ended) return;
    try {
      for (const bytes of decoder.push(chunk)) {
        const frame = fromBinary(TunnelFrameSchema, bytes);
        if (handle) handle.receive(frame);
        else early.push(frame);
      }
    } catch {
      ended = true;
      handle?.end('protocol-error');
      stream.close(constants.NGHTTP2_PROTOCOL_ERROR);
    }
  });
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    handle?.end(reason);
  };
  stream.on('end', () => end('caller-closed'));
  stream.on('close', () => end('caller-closed'));
  stream.on('error', () => end('caller-error'));

  // The node's first frames can be relayed before the 200 goes out (its `opened` resolves the open,
  // and whatever came in the same chunk follows at once): hold them until the response is sent.
  const unsent: TunnelFrame[] = [];
  let closeAfterRespond = false;
  const write = (frame: TunnelFrame) => stream.write(frameMessage(toBinary(TunnelFrameSchema, frame)));

  gateway
    .openTunnel({
      ticket,
      nodeId,
      caller: {
        send: (frame) => {
          if (stream.destroyed) return true;
          if (!stream.headersSent) {
            unsent.push(frame);
            return true;
          }
          return write(frame);
        },
        onDrain: (callback) => void stream.once('drain', callback),
        pause: () => stream.pause(),
        resume: () => stream.resume(),
        close: () => {
          if (stream.destroyed) return;
          if (stream.headersSent) stream.end();
          else closeAfterRespond = true;
        },
      },
    })
    .then(
      (opened) => {
        if (stream.destroyed) {
          opened.end('caller-gone');
          return;
        }
        stream.respond({
          ':status': 200,
          'content-type': 'application/x-bc-tunnel+proto',
          'x-bc-tunnel': opened.info.id,
        });
        for (const frame of unsent.splice(0)) write(frame);
        if (closeAfterRespond) stream.end();
        handle = opened;
        for (const frame of early.splice(0)) opened.receive(frame);
        if (ended) opened.end('caller-closed');
      },
      (error: unknown) => {
        const code = isComputeError(error) ? error.code : 'INTERNAL_ERROR';
        const status = isComputeError(error) ? error.status : 500;
        refuse(status, code, isComputeError(error) ? error.message : 'internal error');
      },
    );
}

/**
 * Serves the control API over HTTP/2 with required internal-CA client certificates. Only callers
 * whose chain verifies against `tls.ca` get past the handshake.
 */
export async function serveInternal(gateway: Gateway, options: ServeInternalOptions): Promise<ServedInternal> {
  if (!options.tls && !options.insecure)
    throw new ComputeError('INVALID_CONFIG', 'serveInternal needs tls (internal CA), or insecure for tests');
  const handle = internalHandler(gateway);
  const server = options.tls
    ? createSecureServer({ ...options.tls, requestCert: true, rejectUnauthorized: true })
    : createServer();
  const sessions = new Set<Http2Session>();
  server.on('session', (session: Http2Session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    stream.on('error', () => {});
    if (options.tls && !(stream.session?.socket as TLSSocket | undefined)?.authorized) {
      stream.respond({ ':status': 401 }, { endStream: true });
      return;
    }
    const method = String(headers[':method'] ?? 'GET');
    const path = String(headers[':path'] ?? '/');
    if (method === 'POST' && path === '/v1/tunnels') return tunnelStream(stream, headers, gateway);
    void (async () => {
      try {
        const payload = method === 'GET' || method === 'HEAD' ? undefined : await readAll(stream, 64 * 1024);
        const response = await handle(
          new Request(new URL(path, 'http://gateway.internal'), {
            method,
            body: payload?.length ? payload.toString('utf8') : undefined,
          }),
        );
        stream.respond({ ':status': response.status, 'content-type': 'application/json' });
        stream.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        if (stream.headersSent || stream.destroyed) return;
        stream.respond({ ':status': isComputeError(error) ? error.status : 500, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ error: { code: isComputeError(error) ? error.code : 'INTERNAL_ERROR' } }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) session.destroy();
      }),
  };
}

export interface ControlClientOptions {
  /** The gateway's `internal_url`, e.g. `https://gw-1.internal:9443` (`http://` = h2c, tests only). */
  baseUrl: string;
  /** Client key/cert from the internal CA and the internal CA as `ca`. */
  tls?: {
    key?: string | Buffer;
    cert?: string | Buffer;
    ca?: string | Buffer | (string | Buffer)[];
    /** The name the server certificate must carry, when `baseUrl` uses an address. */
    servername?: string;
  };
  timeoutMs?: number;
}

/** The api's side of an open tunnel. */
export interface ClientTunnel {
  readonly id: string;
  /** Frames from the node, until the tunnel ends. */
  readonly frames: AsyncIterable<TunnelFrame>;
  /** False when the write buffer is full: wait for `drained()`. */
  send(frame: TunnelFrame): boolean;
  drained(): Promise<void>;
  close(): void;
}

export interface GatewayControlClient {
  health(): Promise<GatewayStatus>;
  poke(nodeIds?: string[]): Promise<void>;
  revoke(nodeId: string, notice: { reason: string; serials?: string[] }): Promise<boolean>;
  drain(reason?: string): Promise<void>;
  /** Opens a tunnel through this gateway (§7.6); rejects with the refusal the gateway sent. */
  openTunnel(request: { ticket: string; nodeId: string }): Promise<ClientTunnel>;
  closeTunnels(filter: { tunnelId?: string; nodeId?: string; subject?: string }, reason: string): Promise<number>;
  close(): void;
}

/** A client for one gateway's control API over one HTTP/2 connection. */
export function gatewayControlClient(options: ControlClientOptions): GatewayControlClient {
  const timeoutMs = options.timeoutMs ?? 2_000;
  let session: ClientHttp2Session | undefined;
  const connection = () => {
    if (session && !session.closed && !session.destroyed) return session;
    session = connect(options.baseUrl, options.baseUrl.startsWith('https:') ? { ...options.tls } : {});
    session.on('error', () => {});
    session.unref();
    return session;
  };

  const call = (method: string, path: string, payload?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      let req;
      try {
        req = connection().request({ ':method': method, ':path': path, 'content-type': 'application/json' });
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        req.close(constants.NGHTTP2_CANCEL);
        reject(new ComputeError('INTERNAL_ERROR', `gateway ${options.baseUrl} timed out`));
      }, timeoutMs);
      let status = 0;
      const chunks: Buffer[] = [];
      req.on('response', (headers) => (status = Number(headers[':status'])));
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      const noResponse = () => {
        clearTimeout(timer);
        if (!status) reject(new ComputeError('INTERNAL_ERROR', `gateway ${options.baseUrl} closed without answering`));
      };
      req.on('close', noResponse);
      req.on('end', () => {
        clearTimeout(timer);
        if (!status) return noResponse();
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = text;
        }
        resolve({ status, body: parsed });
      });
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  const ok = async (method: string, path: string, payload?: unknown) => {
    const response = await call(method, path, payload);
    if (response.status >= 400)
      throw new ComputeError('INTERNAL_ERROR', `gateway ${options.baseUrl} answered ${response.status}`, undefined, {
        body: response.body,
      });
    return response.body;
  };

  return {
    health: () => ok('GET', '/v1/health'),
    poke: async (nodeIds) => void (await ok('POST', '/v1/poke', nodeIds ? { nodeIds } : {})),
    revoke: async (nodeId, notice) => Boolean((await ok('POST', '/v1/revoke', { nodeId, ...notice })).revoked),
    drain: async (reason) => void (await ok('POST', '/v1/drain', reason ? { reason } : {})),
    closeTunnels: async (filter, reason) => Number((await ok('POST', '/v1/tunnels/close', { ...filter, reason })).closed),
    close: () => session?.close(),

    openTunnel(request) {
      return new Promise<ClientTunnel>((resolve, reject) => {
        const stream = connection().request({
          ':method': 'POST',
          ':path': '/v1/tunnels',
          'content-type': 'application/x-bc-tunnel+proto',
          'x-bc-ticket': request.ticket,
          'x-bc-node': request.nodeId,
        });
        const queue: TunnelFrame[] = [];
        const waiters: ((result: IteratorResult<TunnelFrame>) => void)[] = [];
        let done = false;
        const finish = () => {
          done = true;
          for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
        };
        const decoder = new MessageDecoder(MAX_FRAME_BYTES);
        stream.on('response', (headers) => {
          const status = Number(headers[':status']);
          if (status !== 200) {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              let detail: { error?: { code?: string; message?: string } } = {};
              try {
                detail = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                // no body
              }
              const code = detail.error?.code;
              reject(
                new ComputeError(
                  code && /^[A-Z_]+$/.test(code) ? (code as never) : 'INTERNAL_ERROR',
                  detail.error?.message ?? `tunnel refused (${status})`,
                ),
              );
            });
            return;
          }
          stream.on('data', (chunk: Uint8Array) => {
            for (const bytes of decoder.push(chunk)) {
              const frame = fromBinary(TunnelFrameSchema, bytes);
              const waiter = waiters.shift();
              if (waiter) waiter({ value: frame, done: false });
              else queue.push(frame);
            }
          });
          stream.on('end', finish);
          stream.on('close', finish);
          resolve({
            id: String(headers['x-bc-tunnel'] ?? ''),
            frames: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  queue.length
                    ? Promise.resolve({ value: queue.shift()!, done: false })
                    : done
                      ? Promise.resolve({ value: undefined, done: true })
                      : new Promise((next) => waiters.push(next)),
              }),
            },
            send: (frame) => (stream.destroyed ? false : stream.write(frameMessage(toBinary(TunnelFrameSchema, frame)))),
            drained: () => new Promise<void>((next) => stream.once('drain', () => next())),
            close: () => {
              if (!stream.destroyed) stream.end();
            },
          });
        });
        stream.on('error', (error) => {
          finish();
          reject(error);
        });
      });
    },
  };
}

export interface GatewayNotifierOptions {
  /** Where `gateways.internal_url` is read (the compute store). */
  sql: Pick<SqlTx, 'query'>;
  tls?: ControlClientOptions['tls'];
  /** How long a gateway's URL is cached (default 30 s). */
  cacheMs?: number;
  /** Called when a best-effort poke fails; never thrown. */
  onError?: (channel: string, error: unknown) => void;
  now?: () => number;
}

/**
 * The core `Notifier` over gateway control APIs: `publish('gw:<gatewayId>', message?)` POSTs
 * `/v1/poke` to that gateway (the message, when JSON `{nodeIds}`, is passed along). Other channels
 * and `subscribe` are delivered in-process only. Publishing never throws: pokes are accelerators.
 */
export function gatewayNotifier(options: GatewayNotifierOptions): Notifier {
  const clients = controlClients({ ...options, timeoutMs: 1_000 });
  const listeners = new Map<string, Set<(message: string) => void>>();
  const clientFor = clients.get;

  return {
    async publish(channel, message) {
      for (const listener of listeners.get(channel) ?? []) {
        try {
          listener(message ?? '');
        } catch {
          // A local listener's failure is its own.
        }
      }
      if (!channel.startsWith('gw:')) return;
      const gatewayId = channel.slice(3);
      try {
        const client = await clientFor(gatewayId);
        if (!client) return;
        let nodeIds: string[] | undefined;
        if (message) {
          try {
            const parsed = JSON.parse(message) as { nodeIds?: unknown };
            if (stringArray(parsed.nodeIds)) nodeIds = parsed.nodeIds;
          } catch {
            // A plain-text message is just a wake-up.
          }
        }
        await client.poke(nodeIds);
      } catch (error) {
        clients.evict(gatewayId);
        options.onError?.(channel, error);
      }
    },
    async subscribe(channel, onMessage) {
      const set = listeners.get(channel) ?? new Set();
      set.add(onMessage);
      listeners.set(channel, set);
      return async () => {
        set.delete(onMessage);
      };
    },
    async close() {
      listeners.clear();
      clients.close();
    },
  };
}

/**
 * Control clients per gateway id, found through `gateways.internal_url` and cached for `cacheMs`.
 * An expired client is closed gracefully: HTTP/2 lets its open streams (tunnels) finish.
 */
function controlClients(options: {
  sql: Pick<SqlTx, 'query'>;
  tls?: ControlClientOptions['tls'];
  cacheMs?: number;
  timeoutMs?: number;
  now?: () => number;
}) {
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? Date.now;
  const clients = new Map<string, { client: GatewayControlClient; until: number }>();
  return {
    async get(gatewayId: string): Promise<GatewayControlClient | undefined> {
      const cached = clients.get(gatewayId);
      if (cached && cached.until > now()) return cached.client;
      cached?.client.close();
      const { rows } = await options.sql.query<{ internal_url: string }>(
        'SELECT internal_url FROM gateways WHERE id = $1',
        [gatewayId],
      );
      const url = rows[0]?.internal_url;
      if (!url) {
        clients.delete(gatewayId);
        return undefined;
      }
      const client = gatewayControlClient({ baseUrl: url, tls: options.tls, timeoutMs: options.timeoutMs });
      clients.set(gatewayId, { client, until: now() + cacheMs });
      return client;
    },
    evict(gatewayId: string) {
      clients.get(gatewayId)?.client.close();
      clients.delete(gatewayId);
    },
    close() {
      for (const { client } of clients.values()) client.close();
      clients.clear();
    },
  };
}

/** The api's side of a relayed tunnel; `ClientTunnel` satisfies it (server's `RelayedTunnel`). */
export interface RelayedTunnel {
  readonly frames: AsyncIterable<TunnelFrame>;
  send(frame: TunnelFrame): boolean;
  drained(): Promise<void>;
  close(): void;
}

/** Structurally the server's `TunnelRelay` (tunnels/handler.ts), so neither package imports the other. */
export interface GatewayTunnelRelay {
  open(input: { ticket: string; nodeId: string; tunnelId: string; gatewayId: string }): Promise<RelayedTunnel>;
  close(): void;
}

export interface GatewayTunnelRelayOptions {
  /** Where `gateways.internal_url` is read (the compute store). */
  sql: Pick<SqlTx, 'query'>;
  tls?: ControlClientOptions['tls'];
  /** How long a gateway's URL is cached (default 30 s). */
  cacheMs?: number;
  /** How long the gateway may take to open the tunnel (default 10 s: it asks the node first). */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The `TunnelRelay` for `handleTunnel` (§7.6): opens the tunnel through the gateway holding the
 * node's session, over that gateway's control API. An unregistered gateway is `UNAVAILABLE`; a
 * refusal carries the gateway's code; a transport failure evicts the cached client.
 */
export function gatewayTunnelRelay(options: GatewayTunnelRelayOptions): GatewayTunnelRelay {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const clients = controlClients(options);
  return {
    async open({ ticket, nodeId, gatewayId }) {
      const client = await clients.get(gatewayId);
      if (!client) throw new ComputeError('UNAVAILABLE', `gateway ${gatewayId} is not registered`);
      const opening = client.openTunnel({ ticket, nodeId });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // A tunnel that opens after we gave up has nobody to relay to.
          void opening.then((late) => late.close(), () => {});
          clients.evict(gatewayId);
          reject(new ComputeError('UNAVAILABLE', `gateway ${gatewayId} did not open the tunnel in time`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([opening, timedOut]);
      } catch (error) {
        if (!isComputeError(error)) clients.evict(gatewayId);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => clients.close(),
  };
}

export type { TunnelInfo };
