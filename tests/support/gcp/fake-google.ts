import type { TokenSource } from '@better-compute/gcp-common';

// An in-memory stand-in for any Google Cloud REST endpoint, plugged in through the `fetch` option.
// It knows nothing about a particular service: tests register routes. A request without the accepted
// bearer gets a google.rpc.Status 401, and a request no route answers gets a 404 NOT_FOUND.

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** The parsed JSON body; the raw text when it is not JSON; undefined when there is none. */
  body: unknown;
}

export type FakeReply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** A body sent as is (not JSON-encoded), for non-JSON and empty replies. */
  raw?: string;
};

type Handler = (
  request: FakeRequest,
  params: Record<string, string>,
) => FakeReply | Promise<FakeReply>;

interface Route {
  method: string;
  pattern: RegExp;
  reply: Handler;
}

interface Failure {
  reply: FakeReply;
  method?: string;
  path?: RegExp;
}

const bodyless = new Set([101, 204, 205, 304]);

/** `{name}` matches one path segment, `{name=**}` the rest of the path. */
function compile(template: string): RegExp {
  let source = '';
  let rest = template;
  for (;;) {
    const open = rest.indexOf('{');
    if (open < 0) break;
    const close = rest.indexOf('}', open);
    source += escape(rest.slice(0, open));
    const [name, glob] = rest.slice(open + 1, close).split('=');
    source += glob === '**' ? `(?<${name}>.+)` : `(?<${name}>[^/]+)`;
    rest = rest.slice(close + 1);
  }
  return new RegExp(`^${source}${escape(rest)}$`);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class FakeGoogle {
  readonly requests: FakeRequest[] = [];
  readonly fetch: typeof fetch;
  private readonly routes: Route[] = [];
  private readonly failures: Failure[] = [];
  private readonly accepted: string;

  constructor(options: { token?: string } = {}) {
    this.accepted = options.token ?? 'fake-token';
    this.fetch = (input, init) => this.handle(input, init);
  }

  route(method: string, path: string | RegExp, reply: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern: typeof path === 'string' ? compile(path) : path,
      reply,
    });
    return this;
  }

  /** Answers the next matching request with `reply` once, before routes run. */
  failNext(reply: FakeReply, match: { method?: string; path?: RegExp } = {}): this {
    this.failures.push({
      reply,
      ...(match.method ? { method: match.method.toUpperCase() } : {}),
      ...(match.path ? { path: match.path } : {}),
    });
    return this;
  }

  /** A google.rpc.Status error reply (`{ error: { code, status, message, details } }`). */
  static rpcError(code: number, status: string, message: string, details?: unknown[]): FakeReply {
    return {
      status: code,
      body: { error: { code, message, status, ...(details ? { details } : {}) } },
    };
  }

  /** A token source that returns the accepted bearer. */
  tokens(): TokenSource {
    return { token: async () => this.accepted };
  }

  private async handle(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const request: FakeRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: new Headers(init?.headers),
      body: parseBody(init?.body),
    };
    this.requests.push(request);
    if (request.headers.get('authorization') !== `Bearer ${this.accepted}`)
      return respond(
        FakeGoogle.rpcError(401, 'UNAUTHENTICATED', 'Request had invalid credentials.'),
      );
    const failure = this.failures.findIndex(
      (f) => (!f.method || f.method === request.method) && (!f.path || f.path.test(url.pathname)),
    );
    if (failure >= 0) return respond(this.failures.splice(failure, 1)[0]!.reply);
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
      );
      return respond(await route.reply(request, params));
    }
    return respond(
      FakeGoogle.rpcError(404, 'NOT_FOUND', `No route for ${request.method} ${url.pathname}`),
    );
  }
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return undefined;
  const text = String(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function respond(reply: FakeReply): Response {
  const status = reply.status ?? 200;
  const headers = new Headers(reply.headers);
  const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
  if (reply.raw === undefined && reply.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  return new Response(bodyless.has(status) ? null : text, { status, headers });
}
