import { registerCatalog } from './catalog.js';
import { DoState, errorFixtures, type Json } from './state.js';

export { DoState, fixture, errorFixtures, type Json } from './state.js';

// An in-memory emulator of the DigitalOcean API v2 endpoints provider-digitalocean uses. Plug
// `emulator.fetch` into `digitaloceanProvider({ fetch })`. This file is the core: authentication,
// rate-limit headers, failure injection, paging and routing. Each service (regions, droplets,
// networks, ...) registers its routes with `route()`; paths are matched relative to `/v2`.

export interface RecordedRequest {
  method: string;
  url: URL;
  /** Every request header, lowercased. */
  headers: Record<string, string>;
  body?: unknown;
}

export interface RouteContext {
  method: string;
  url: URL;
  /** The path relative to `/v2`, e.g. `/droplets/123`. */
  path: string;
  /** The route's match against `path`; capture groups are the path parameters. */
  match: RegExpExecArray;
  headers: Headers;
  body: Json | undefined;
  state: DoState;
  emulator: DoEmulator;
}

export interface RouteResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (context: RouteContext) => RouteResult;

interface Failure {
  method?: string;
  path: RegExp;
  status: number;
  body: object;
  headers?: Record<string, string>;
}

const apiPrefix = '/v2';

export class DoEmulator {
  readonly state = new DoState();
  /** The bearer tokens it accepts. */
  validTokens = new Set<string>(['do-token']);
  requests: RecordedRequest[] = [];
  /**
   * Emitted as `ratelimit-*` headers (as they stand after the request is counted). `remaining`
   * drops by one per request, at 0 the next request gets the 429 fixture, and `resetAt` is epoch
   * seconds.
   */
  rate: { limit: number; remaining: number; resetAt: number };
  /** Upper bound of a page; a request's `per_page` can only lower it. */
  maxPerPage = 200;
  /** Rewrites the origin of `links.pages.*` (a hostile or misconfigured server). */
  linkOrigin?: string;

  readonly #routes: { method: string; pattern: RegExp; handler: RouteHandler }[] = [];
  readonly #failures: Failure[] = [];
  readonly #errors = errorFixtures();

  constructor(options: { now?: () => number } = {}) {
    const now = options.now ?? Date.now;
    this.rate = { limit: 5000, remaining: 5000, resetAt: Math.floor(now() / 1000) + 3600 };
    this.#registerCore();
  }

  /** Registers a handler for requests whose `/v2`-relative path matches `pattern`. */
  route(method: string, pattern: RegExp, handler: RouteHandler): void {
    this.#routes.push({ method: method.toUpperCase(), pattern, handler });
  }

  /**
   * The next request that matches fails with this status and body, and changes nothing. `path` is
   * matched against the `/v2`-relative path.
   */
  failNext(
    match: { method?: string; path: RegExp },
    status: number,
    body: object,
    headers?: Record<string, string>,
  ): void {
    this.#failures.push({
      ...(match.method !== undefined ? { method: match.method.toUpperCase() } : {}),
      path: match.path,
      status,
      body,
      ...(headers ? { headers } : {}),
    });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: Json | undefined;
    if (typeof init?.body === 'string' && headers.get('content-type')?.includes('json'))
      body = JSON.parse(init.body) as Json;
    this.requests.push({
      method,
      url,
      headers: Object.fromEntries(headers.entries()),
      ...(body !== undefined ? { body } : {}),
    });

    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    if (!bearer || !this.validTokens.has(bearer)) return this.#fixtureResponse('unauthorized');

    const path = url.pathname.startsWith(apiPrefix)
      ? url.pathname.slice(apiPrefix.length)
      : url.pathname;
    if (this.rate.remaining <= 0) return this.#fixtureResponse('rate-limited');
    this.rate.remaining -= 1;

    const failure = this.#failures.findIndex(
      (f) => (f.method === undefined || f.method === method) && f.path.test(path),
    );
    if (failure >= 0) {
      const [f] = this.#failures.splice(failure, 1);
      return this.respond(f!.status, f!.body, f!.headers);
    }
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      const result = route.handler({
        method,
        url,
        path,
        match,
        headers,
        body,
        state: this.state,
        emulator: this,
      });
      return this.respond(result.status, result.body, result.headers);
    }
    return this.#fixtureResponse('not-found');
  };

  /** A response with the rate-limit headers DO puts on every authenticated answer. */
  respond(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
    return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
      status,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'ratelimit-limit': String(this.rate.limit),
        'ratelimit-remaining': String(Math.max(0, this.rate.remaining)),
        'ratelimit-reset': String(this.rate.resetAt),
        ...headers,
      },
    });
  }

  /**
   * One page of a list: `per_page` and `page` are honoured up to `maxPerPage`, and `links.pages`
   * carries absolute URLs, as DO's do.
   */
  paged(context: RouteContext, field: string, items: readonly unknown[]): RouteResult {
    const perPage = Math.min(
      Math.max(1, Number(context.url.searchParams.get('per_page')) || 20),
      this.maxPerPage,
    );
    const page = Math.max(1, Number(context.url.searchParams.get('page')) || 1);
    const last = Math.max(1, Math.ceil(items.length / perPage));
    const link = (n: number): string => {
      const next = new URL(context.url);
      next.searchParams.set('page', String(n));
      next.searchParams.set('per_page', String(perPage));
      if (this.linkOrigin) return `${this.linkOrigin}${next.pathname}${next.search}`;
      return next.toString();
    };
    const pages: Record<string, string> = {};
    if (page > 1) {
      pages.first = link(1);
      pages.prev = link(page - 1);
    }
    if (page < last) {
      pages.next = link(page + 1);
      pages.last = link(last);
    }
    return {
      status: 200,
      body: {
        [field]: items.slice((page - 1) * perPage, page * perPage),
        links: Object.keys(pages).length ? { pages } : {},
        meta: { total: items.length },
      },
    };
  }

  #fixtureResponse(name: string): Response {
    const entry = this.#errors.get(name);
    if (!entry) throw new Error(`no error fixture named ${name}`);
    return this.respond(entry.status, entry.body);
  }

  #registerCore(): void {
    registerCatalog(this);
  }
}
