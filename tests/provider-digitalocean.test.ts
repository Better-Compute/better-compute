import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isComputeError, manualClock, type ComputeError } from '@better-compute/core';
import {
  budgetFor,
  doClient,
  doConfig,
  mapDoError,
  RateBudget,
  unprocessablePatterns,
  type DoClient,
} from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import { secrets } from './support/do-harness.js';

// provider-digitalocean against an in-memory emulator of the DigitalOcean endpoints it uses,
// plugged in through the `fetch` option.

const endpoint = 'https://api.digitalocean.com/v2';
const signal = new AbortController().signal;

interface FixtureError {
  name: string;
  status: number;
  code: string;
  body: { id: string; message: string; request_id?: string };
}
const errorFixtures: FixtureError[] = JSON.parse(
  readFileSync(new URL('./fixtures/digitalocean/errors.json', import.meta.url), 'utf8'),
).errors;

/** A client over the emulator, with a captured log and a `/test` route for the tests to hit. */
function setup(options: { perMinute?: number; perHour?: number; fetch?: typeof fetch } = {}) {
  const emu = new DoEmulator();
  emu.route('GET', /^\/test$/, () => ({ status: 200, body: { ok: true } }));
  emu.route('POST', /^\/test$/, (context) => ({ status: 202, body: { echo: context.body } }));
  const clock = manualClock(1_000_000);
  const lines: string[] = [];
  const capture = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    void lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  const log = {
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
  };
  const budget = new RateBudget({
    perMinute: options.perMinute ?? 250,
    perHour: options.perHour ?? 5000,
    clock,
  });
  let tokenCalls = 0;
  const client: DoClient = doClient({
    fetch: options.fetch ?? emu.fetch,
    endpoint,
    token: async () => {
      tokenCalls += 1;
      return secrets.resolve('secret://do/t');
    },
    budget,
    clock,
    log,
  });
  return { emu, client, budget, clock, lines, tokenCalls: () => tokenCalls };
}

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('config', () => {
  it('validates an account and fills the defaults', async () => {
    const parsed = await doConfig['~standard'].validate({
      token: 'secret://do/t',
      regions: ['nyc3'],
    });
    if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
    expect((parsed as { value: Record<string, unknown> }).value).toMatchObject({
      token: 'secret://do/t',
      regions: ['nyc3'],
      monitoring: true,
      ipv6: false,
      allowSpot: false,
      previews: false,
    });
  });

  it('refuses an account without regions', async () => {
    const parsed = await doConfig['~standard'].validate({ token: 'secret://do/t', regions: [] });
    expect('issues' in parsed && parsed.issues).toBeTruthy();
  });
});

describe('client', () => {
  it('sends the bearer token and json, and never logs it', async () => {
    const { emu, client, lines } = setup();
    const reply = await client.request<{ echo: unknown }>('POST', '/test', {
      body: { name: 'bc-1' },
      signal,
      budget: 'mutate',
    });
    expect(reply.echo).toEqual({ name: 'bc-1' });
    const sent = emu.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url.toString()).toBe(`${endpoint}/test`);
    expect(sent.headers.authorization).toBe('Bearer do-token');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.accept).toBe('application/json');

    // A token the API refuses: the error and the log still never carry it.
    emu.validTokens.clear();
    const refused = await failure(client.request('GET', '/test', { signal, budget: 'observe' }));
    expect(refused.code).toBe('INVALID_CONFIG');
    expect(`${refused.message} ${JSON.stringify(refused.details)}`).not.toContain('do-token');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('do-token');
  });

  it('resolves the token once, behind one shared promise', async () => {
    const { client, tokenCalls } = setup();
    await Promise.all([
      client.request('GET', '/test', { signal, budget: 'observe' }),
      client.request('GET', '/test', { signal, budget: 'observe' }),
      client.request('GET', '/test', { signal, budget: 'observe' }),
    ]);
    await client.request('GET', '/test', { signal, budget: 'observe' });
    expect(tokenCalls()).toBe(1);
  });

  it('maps DO errors to ComputeError codes', async () => {
    const { emu, client } = setup();
    for (const entry of errorFixtures) {
      emu.failNext({ path: /^\/test$/ }, entry.status, entry.body);
      const error = await failure(client.request('GET', '/test', { signal, budget: 'observe' }));
      expect(error.code, entry.name).toBe(entry.code);
      expect(error.details?.provider, entry.name).toBe('digitalocean');
      expect(error.details?.status, entry.name).toBe(entry.status);
      expect(error.details?.requestId, entry.name).toBe(entry.body.request_id);
      expect(error.details?.id, entry.name).toBe(entry.body.id);
    }
  });

  it('names the reason of the errors a caller branches on', () => {
    const headers = new Headers();
    const body = (id: string, message = id) => ({ id, message, request_id: 'req-1' });
    const reason = (status: number, id: string, message?: string) =>
      mapDoError(status, body(id, message), headers, 0).details?.reason;
    expect(reason(401, 'unauthorized')).toBe('token');
    expect(reason(403, 'forbidden')).toBe('scope');
    expect(reason(422, 'unprocessable_entity', 'Size is not available in this region.')).toBe(
      'sizeUnavailable',
    );
    expect(reason(422, 'unprocessable_entity', 'name is already in use')).toBe('nameInUse');
    // Every pattern has its own reason and a fixture that triggers it.
    for (const { pattern, code } of unprocessablePatterns) {
      const hits = errorFixtures.filter((e) => e.status === 422 && pattern.test(e.body.message));
      expect(hits.length, String(pattern)).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.code).toBe(code);
    }
  });

  it('treats an unmatched 422 as invalid input, and a 400 and a 409 by status', () => {
    const headers = new Headers();
    const unknown = { id: 'unprocessable_entity', message: 'something new' };
    expect(mapDoError(422, unknown, headers, 0).code).toBe('INVALID_INPUT');
    expect(mapDoError(400, unknown, headers, 0).code).toBe('INVALID_INPUT');
    expect(mapDoError(409, { id: 'conflict', message: 'busy' }, headers, 0).code).toBe('CONFLICT');
    expect(mapDoError(503, undefined, headers, 0).code).toBe('UNAVAILABLE');
    expect(mapDoError(418, 'teapot', headers, 0).code).toBe('PROVIDER_ERROR');
  });

  it('takes the request id from the x-request-id header when the body has none', () => {
    const error = mapDoError(
      500,
      { id: 'server_error', message: 'Unexpected server-side error' },
      new Headers({ 'x-request-id': 'hdr-1' }),
      0,
    );
    expect(error.details?.requestId).toBe('hdr-1');
  });

  it('answers a 429 with the wait until ratelimit-reset', async () => {
    const { emu, client, clock } = setup();
    const resetAt = Math.floor(clock.now() / 1000) + 30;
    emu.failNext(
      { path: /^\/test$/ },
      429,
      { id: 'too_many_requests', message: 'API rate limit exceeded.' },
      { 'ratelimit-reset': String(resetAt), 'ratelimit-remaining': '0' },
    );
    const error = await failure(client.request('GET', '/test', { signal, budget: 'mutate' }));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(30_000);

    // Without the header it waits a minute; a reset in the past waits nothing.
    const body = { id: 'too_many_requests', message: 'API rate limit exceeded.' };
    expect(mapDoError(429, body, new Headers(), 0).retryAfterMs).toBe(60_000);
    expect(
      mapDoError(429, body, new Headers({ 'ratelimit-reset': '5' }), 10_000).retryAfterMs,
    ).toBe(0);
  });

  it('maps a network failure to UNAVAILABLE', async () => {
    const { client } = setup({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await failure(client.request('GET', '/test', { signal, budget: 'observe' }));
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'network' });
  });

  it('pages follow links.pages.next until absent, with per_page=200', async () => {
    const { emu, client } = setup();
    emu.maxPerPage = 2;
    const slugs: string[] = [];
    for await (const region of client.pages<{ slug: string }>('/regions', 'regions', {
      signal,
      budget: 'sweep',
    }))
      slugs.push(region.slug);
    expect(slugs).toEqual(emu.state.regions.map((r) => r.slug));
    expect(slugs.length).toBeGreaterThan(2);
    expect(emu.requests).toHaveLength(Math.ceil(slugs.length / 2));
    expect(emu.requests[0]!.url.searchParams.get('per_page')).toBe('200');
    for (const request of emu.requests) expect(request.url.pathname).toBe('/v2/regions');
  });

  it('refuses a next link on another origin', async () => {
    const { emu, client } = setup();
    emu.maxPerPage = 1;
    emu.linkOrigin = 'https://evil.example';
    const error = await failure(
      (async () => {
        for await (const _ of client.pages('/regions', 'regions', { signal, budget: 'sweep' })) {
          // drain
        }
      })(),
    );
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'foreignLink' });
    expect(emu.requests).toHaveLength(1);
    expect(emu.requests.every((r) => r.url.origin === 'https://api.digitalocean.com')).toBe(true);
  });

  it('reads an action', async () => {
    const { emu, client } = setup();
    emu.route('GET', /^\/actions\/(\d+)$/, (context) => ({
      status: 200,
      body: {
        action: {
          id: Number(context.match[1]),
          status: 'completed',
          type: 'create',
          started_at: '2026-10-18T10:00:00Z',
          completed_at: '2026-10-18T10:00:30Z',
          resource_id: 3164444,
          resource_type: 'droplet',
          region_slug: 'nyc3',
        },
      },
    }));
    const action = await client.action(77, signal);
    expect(action).toMatchObject({ id: 77, status: 'completed', type: 'create' });
    expect(emu.requests[0]!.url.pathname).toBe('/v2/actions/77');
  });

  it('spends the budget before each request, and not at all when it refuses', async () => {
    const { emu, client } = setup({ perMinute: 2 });
    await client.request('GET', '/test', { signal, budget: 'mutate' });
    await client.request('GET', '/test', { signal, budget: 'mutate' });
    const error = await failure(client.request('GET', '/test', { signal, budget: 'mutate' }));
    expect(error.code).toBe('RATE_LIMITED');
    expect(emu.requests).toHaveLength(2);
  });
});

describe('client: rate budget', () => {
  it('sweep calls defer before mutate calls are refused', () => {
    const budget = new RateBudget({ perMinute: 10, perHour: 1000, clock: manualClock(1_000_000) });
    budget.take('sweep');
    budget.take('sweep');
    let deferred: ComputeError | undefined;
    try {
      budget.take('sweep');
    } catch (error) {
      deferred = error as ComputeError;
    }
    expect(deferred?.code).toBe('RATE_LIMITED');
    expect(deferred?.retryAfterMs).toBeGreaterThan(0);
    expect(deferred?.details).toMatchObject({ provider: 'digitalocean', reason: 'budget' });
    // Mutations 3..10 still pass; the 11th is refused.
    for (let n = 0; n < 8; n++) budget.take('mutate');
    expect(() => budget.take('mutate')).toThrow(/rate|budget/i);
  });

  it('lets observe use 30% and keeps half of each window for mutate', () => {
    const budget = new RateBudget({ perMinute: 10, perHour: 1000, clock: manualClock(1_000_000) });
    for (let n = 0; n < 3; n++) budget.take('observe');
    expect(() => budget.take('observe')).toThrow();
    budget.take('sweep');
    budget.take('sweep');
    // 5 of 10 used by observe and sweep; the other 5 are mutate's.
    for (let n = 0; n < 5; n++) budget.take('mutate');
    expect(() => budget.take('mutate')).toThrow();
  });

  it('frees the window as time passes', () => {
    const clock = manualClock(1_000_000);
    const budget = new RateBudget({ perMinute: 2, perHour: 1000, clock });
    budget.take('mutate');
    clock.advance(10_000);
    budget.take('mutate');
    const refused = (() => {
      try {
        budget.take('mutate');
      } catch (error) {
        return error as ComputeError;
      }
      return undefined;
    })();
    // The oldest take leaves the minute window 50 s from now.
    expect(refused?.retryAfterMs).toBe(50_000);
    clock.advance(50_000);
    budget.take('mutate');
  });

  it('enforces the hourly window too', () => {
    const clock = manualClock(1_000_000);
    const budget = new RateBudget({ perMinute: 100, perHour: 3, clock });
    for (let n = 0; n < 3; n++) {
      budget.take('mutate');
      clock.advance(61_000);
    }
    const refused = (() => {
      try {
        budget.take('mutate');
      } catch (error) {
        return error as ComputeError;
      }
      return undefined;
    })();
    expect(refused?.code).toBe('RATE_LIMITED');
    expect(refused?.retryAfterMs).toBeGreaterThan(3_000_000);
  });

  it('re-seeds the budget from ratelimit headers', async () => {
    const { emu, client, budget, clock } = setup();
    emu.rate.resetAt = Math.floor(clock.now() / 1000) + 30;
    emu.rate.remaining = 1;
    await client.request('GET', '/test', { signal, budget: 'observe' });
    // The API counted that request: nothing is left this hour.
    let refused: ComputeError | undefined;
    try {
      budget.take('sweep');
    } catch (error) {
      refused = error as ComputeError;
    }
    expect(refused?.code).toBe('RATE_LIMITED');
    expect(refused?.retryAfterMs).toBe(30_000);
    clock.advance(31_000);
    budget.take('sweep');
  });

  it('only ever lowers the hourly remainder from a header', () => {
    const budget = new RateBudget({ perMinute: 10, perHour: 100, clock: manualClock(1_000_000) });
    budget.observe(new Headers({ 'ratelimit-limit': '5000', 'ratelimit-remaining': '4999' }));
    for (let n = 0; n < 10; n++) budget.take('mutate');
    expect(() => budget.take('mutate')).toThrow();
  });

  it('shares one budget per token', () => {
    const options = { perMinute: 10, perHour: 100, clock: manualClock(1_000_000) };
    expect(budgetFor('aaaa', options)).toBe(budgetFor('aaaa', options));
    expect(budgetFor('aaaa', options)).not.toBe(budgetFor('bbbb', options));
  });
});
