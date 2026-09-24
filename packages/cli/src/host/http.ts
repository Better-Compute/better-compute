import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { serverVersion } from '@better-compute/server';
import type { AnyCompute } from '../config.js';

// The HTTP side of `serve` (PLAN.md §8.2, §9.3): compute's API under its base path, plus what a host adds in
// front of it: `/healthz` and `/readyz`, `/.well-known/better-compute` (API location, version and the join-key
// fallback of PLAN §6 Install), the host's own fetch-style routes (the events module's `GET /watch`,
// observability's `GET /metrics`) and upgrade handlers (tunnels).

/** A fetch-style route the host mounts beside the API, e.g. `{ path: '/watch', handler: (r) => handleWatch(r, …) }`. */
export interface HostRoute {
  /** Methods it answers (default: any). Others get 405. */
  method?: string | readonly string[];
  /** An absolute path; with `prefix`, every path below it too. */
  path: string;
  prefix?: boolean;
  handler(request: Request): Promise<Response> | Response;
}

/** Handles an HTTP upgrade (e.g. a tunnel); resolves true when it took the socket. */
export type HostUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => Promise<boolean> | boolean;

export interface HostHttpOptions {
  routes?: readonly HostRoute[];
  upgrade?: readonly HostUpgradeHandler[];
  /** Extra public fields of `/.well-known/better-compute` (e.g. `joinEncryptionJwk`). */
  wellKnown?: Record<string, unknown>;
}

const reservedPaths = ['/healthz', '/readyz', '/.well-known/better-compute'];

const pathPattern = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/** Checks host routes: absolute paths, no clash with the API, the built-ins or each other. */
export function checkHostRoutes(routes: readonly HostRoute[], basePath: string): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (!route || typeof route.handler !== 'function' || typeof route.path !== 'string')
      throw new TypeError('host routes need a path and a handler');
    if (!pathPattern.test(route.path) || (route.path.length > 1 && route.path.endsWith('/')))
      throw new TypeError(`host route ${route.path}: an absolute path without a trailing slash`);
    if (reservedPaths.includes(route.path))
      throw new TypeError(`host route ${route.path} is built in`);
    if (route.path === basePath || route.path.startsWith(`${basePath}/`))
      throw new TypeError(`host route ${route.path} is inside the API base path ${basePath}`);
    if (route.prefix && basePath.startsWith(`${route.path}/`))
      throw new TypeError(`host route ${route.path}/* would shadow the API base path ${basePath}`);
    const key = `${route.prefix ? 'prefix' : 'exact'} ${route.path}`;
    if (seen.has(key)) throw new TypeError(`host route ${route.path} is listed twice`);
    seen.add(key);
  }
}

function matches(route: HostRoute, pathname: string): boolean {
  if (pathname === route.path) return true;
  return route.prefix === true && pathname.startsWith(route.path === '/' ? '/' : `${route.path}/`);
}

function allows(route: HostRoute, method: string): boolean {
  if (route.method === undefined) return true;
  const methods = typeof route.method === 'string' ? [route.method] : route.method;
  return methods.some((allowed) => allowed.toUpperCase() === method);
}

const json = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
};

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/** A WHATWG Request for a Node request (the body streams; no buffering). */
export function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(new URL(req.url ?? '/', origin), init);
}

/** Writes a WHATWG Response, streaming its body; a client that goes away cancels the stream (SSE). */
export async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  res.once('close', cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch {
    res.destroy();
  } finally {
    res.off('close', cancel);
  }
}

export interface HostListener {
  request(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * The request and upgrade listeners of a host: the built-ins, then the host's routes, then compute's
 * `nodeHandler` for everything else (it answers 404 outside its base path).
 */
export function hostListener(compute: AnyCompute, options: HostHttpOptions = {}): HostListener {
  const routes = options.routes ?? [];
  const { basePath, origin } = compute.endpoint;
  checkHostRoutes(routes, basePath);
  const wellKnown = Object.freeze({
    name: 'better-compute',
    version: serverVersion,
    api: `${origin}${basePath}`,
    ...options.wellKnown,
  });

  const failed = (res: ServerResponse) => {
    if (!res.headersSent) json(res, 500, errorBody('INTERNAL_ERROR', 'Internal error'));
    else res.destroy();
  };

  return {
    request(req, res) {
      const method = (req.method ?? 'GET').toUpperCase();
      const pathname = new URL(req.url ?? '/', 'http://host').pathname;
      if (pathname === '/healthz') return json(res, 200, { ok: true });
      if (pathname === '/readyz') {
        void compute.context.sql
          .query('SELECT 1')
          .then(() => json(res, 200, { ok: true }))
          .catch(() => json(res, 503, { ok: false }));
        return;
      }
      if (pathname === '/.well-known/better-compute') {
        if (method !== 'GET' && method !== 'HEAD')
          return json(res, 405, errorBody('METHOD_NOT_ALLOWED', 'GET only'), { allow: 'GET' });
        return json(res, 200, wellKnown, { 'cache-control': 'public, max-age=300' });
      }
      const route = routes.find((candidate) => matches(candidate, pathname));
      if (route) {
        if (!allows(route, method))
          return json(res, 405, errorBody('METHOD_NOT_ALLOWED', `${method} is not allowed here`));
        void (async () => route.handler(toRequest(req, origin)))()
          .then((response) => writeResponse(res, response))
          .catch(() => failed(res));
        return;
      }
      void compute.nodeHandler(req, res).catch(() => failed(res));
    },
    upgrade(req, socket, head) {
      void (async () => {
        for (const handler of options.upgrade ?? []) if (await handler(req, socket, head)) return;
        socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      })().catch(() => socket.destroy());
    },
  };
}
