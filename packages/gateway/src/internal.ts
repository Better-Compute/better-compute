import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, type ServerOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { ComputeError, type Notifier, type SqlTx } from '@better-compute/core';
import type { Gateway, GatewayStatus } from './gateway.js';

// The gateway's internal control API on `gateways.internal_url` (PLAN.md §8.1), called by api and
// worker processes over the internal CA's mTLS. Every call is an accelerator: dispatch polls every
// second, specs re-push on the sweep, revocations arrive through the RevocationFeed and
// cancellations from the database, so correctness never depends on this API being reachable.

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

/**
 * The control API as a fetch handler:
 * - `GET /v1/health` → `GatewayStatus`;
 * - `POST /v1/poke {nodeIds?}` → 202 (dispatch + spec push now);
 * - `POST /v1/revoke {nodeId, reason, serials?: hex[]}` → `{ revoked }`;
 * - `POST /v1/drain {reason?}` → 202.
 */
export function internalHandler(gateway: Gateway): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const route = `${request.method} ${path}`;
    switch (route) {
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
      default:
        return ['/v1/health', '/v1/poke', '/v1/revoke', '/v1/drain'].includes(path)
          ? json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} ${path}` } })
          : json(404, { error: { code: 'NOT_FOUND', message: path } });
    }
  };
}

export interface ServeInternalOptions {
  port?: number;
  host?: string;
  /** Internal-CA mTLS: `key`/`cert` for this gateway, `ca` = the internal CA. */
  tls?: ServerOptions;
  /** Plain HTTP on loopback, for tests only. */
  insecure?: boolean;
}

export interface ServedInternal {
  server: Server;
  port: number;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ComputeError('PAYLOAD_TOO_LARGE', 'control requests are small');
    chunks.push(chunk);
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') },
    body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
}

/**
 * Serves `internalHandler` over HTTPS with required client certificates (the internal CA). Only
 * callers whose chain verifies against `tls.ca` get past the handshake.
 */
export async function serveInternal(gateway: Gateway, options: ServeInternalOptions): Promise<ServedInternal> {
  if (!options.tls && !options.insecure)
    throw new ComputeError('INVALID_CONFIG', 'serveInternal needs tls (internal CA), or insecure for tests');
  const handle = internalHandler(gateway);
  const listener = async (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    if (options.tls && !(req.socket as TLSSocket).authorized) {
      res.writeHead(401).end();
      return;
    }
    try {
      const response = await handle(await toRequest(req, 'http://gateway.internal'));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const status = error instanceof ComputeError ? error.status : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: error instanceof ComputeError ? error.code : 'INTERNAL_ERROR' } }));
    }
  };
  const server: Server = options.tls
    ? createHttpsServer({ ...options.tls, requestCert: true, rejectUnauthorized: true }, listener)
    : createHttpServer(listener);
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
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface ControlClientOptions {
  /** The gateway's `internal_url`, e.g. `https://gw-1.internal:9443`. */
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

export interface GatewayControlClient {
  health(): Promise<GatewayStatus>;
  poke(nodeIds?: string[]): Promise<void>;
  revoke(nodeId: string, notice: { reason: string; serials?: string[] }): Promise<boolean>;
  drain(reason?: string): Promise<void>;
}

/** A client for one gateway's control API (node:http/https: no fetch dispatcher needed for mTLS). */
export function gatewayControlClient(options: ControlClientOptions): GatewayControlClient {
  const base = new URL(options.baseUrl);
  const call = (method: string, path: string, payload?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
      const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
      const req = send(
        new URL(path, base),
        {
          method,
          headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
          timeout: options.timeoutMs ?? 2_000,
          ...(base.protocol === 'https:' ? options.tls : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              parsed = text;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('timeout', () => req.destroy(new ComputeError('INTERNAL_ERROR', `gateway ${base.host} timed out`)));
      req.on('error', reject);
      req.end(data);
    });
  const ok = async (method: string, path: string, payload?: unknown) => {
    const response = await call(method, path, payload);
    if (response.status >= 400)
      throw new ComputeError('INTERNAL_ERROR', `gateway ${base.host} answered ${response.status}`, undefined, {
        body: response.body,
      });
    return response.body;
  };
  return {
    health: () => ok('GET', '/v1/health'),
    poke: async (nodeIds) => void (await ok('POST', '/v1/poke', nodeIds ? { nodeIds } : {})),
    revoke: async (nodeId, notice) => Boolean((await ok('POST', '/v1/revoke', { nodeId, ...notice })).revoked),
    drain: async (reason) => void (await ok('POST', '/v1/drain', reason ? { reason } : {})),
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
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? Date.now;
  const clients = new Map<string, { client: GatewayControlClient; until: number }>();
  const listeners = new Map<string, Set<(message: string) => void>>();

  async function clientFor(gatewayId: string): Promise<GatewayControlClient | undefined> {
    const cached = clients.get(gatewayId);
    if (cached && cached.until > now()) return cached.client;
    const { rows } = await options.sql.query<{ internal_url: string }>(
      'SELECT internal_url FROM gateways WHERE id = $1',
      [gatewayId],
    );
    const url = rows[0]?.internal_url;
    if (!url) {
      clients.delete(gatewayId);
      return undefined;
    }
    const client = gatewayControlClient({ baseUrl: url, tls: options.tls, timeoutMs: 1_000 });
    clients.set(gatewayId, { client, until: now() + cacheMs });
    return client;
  }

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
        clients.delete(gatewayId);
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
      clients.clear();
    },
  };
}
