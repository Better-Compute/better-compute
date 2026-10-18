import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, manualClock, type ComputeError } from '@better-compute/core';
import {
  budgetFor,
  doClient,
  deploymentTag,
  doConfig,
  dropletName,
  ensureSshKeys,
  gpuModelOf,
  isManagedTag,
  keyTag,
  labels,
  labelsFromTags,
  listOffers,
  machineId,
  md5Fingerprint,
  mapDoError,
  networkMemberTag,
  offerId,
  parseMachineId,
  parseOfferId,
  RateBudget,
  tagFor,
  unprocessablePatterns,
  type DoClient,
  type DoSize,
} from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import { seedSshKey } from './support/do-emulator/keys.js';
import { freshBudgets, noopLog, secrets } from './support/do-harness.js';

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
    expect(mapDoError(429, body, new Headers({ 'ratelimit-reset': '' }), 10_000).retryAfterMs).toBe(
      60_000,
    );
  });

  it('refuses a 2xx body that is not JSON, and takes an empty one as nothing', async () => {
    const html = setup({
      fetch: async () => new Response('<html>maintenance, token do-token</html>', { status: 200 }),
    });
    const error = await failure(
      html.client.request('GET', '/droplets', { signal, budget: 'sweep' }),
    );
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details).toMatchObject({
      provider: 'digitalocean',
      reason: 'badBody',
      status: 200,
    });
    expect(error.message + JSON.stringify(error.details)).not.toMatch(/maintenance|do-token/);
    // The same page while listing must not read as an empty list either.
    const listing = failure(
      (async () => {
        for await (const _ of html.client.pages('/droplets', 'droplets', {
          signal,
          budget: 'sweep',
        })) {
          // drain
        }
      })(),
    );
    expect((await listing).details?.reason).toBe('badBody');

    const empty = setup({ fetch: async () => new Response(null, { status: 204 }) });
    await expect(
      empty.client.request('DELETE', '/droplets/1', { signal, budget: 'mutate' }),
    ).resolves.toEqual({});
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
  beforeEach(freshBudgets);

  it('keeps the mutate reserve when the API reports a low positive remainder', () => {
    const clock = manualClock(1_000_000);
    const budget = new RateBudget({ perMinute: 250, perHour: 5000, clock });
    // Another process sharing the token has used 4990 of 5000; the window frees in a minute.
    budget.observe(
      new Headers({
        'ratelimit-limit': '5000',
        'ratelimit-remaining': '10',
        'ratelimit-reset': String(Math.floor(clock.now() / 1000) + 60),
      }),
    );
    for (const cls of ['sweep', 'observe'] as const) {
      let refused: ComputeError | undefined;
      try {
        budget.take(cls);
      } catch (error) {
        refused = error as ComputeError;
      }
      expect(refused?.code, cls).toBe('RATE_LIMITED');
      expect(refused?.retryAfterMs, cls).toBe(60_000);
    }
    budget.take('mutate');
    // Once the reported window is over, sweeps run again.
    clock.advance(61_000);
    budget.take('sweep');
  });

  it('uses the limit the API reports, not the configured one', () => {
    const clock = manualClock(1_000_000);
    // A token with a limit of 1000 an hour and 400 left is below half: sweeps wait, mutate runs.
    const low = new RateBudget({ perMinute: 250, perHour: 5000, clock });
    low.observe(new Headers({ 'ratelimit-limit': '1000', 'ratelimit-remaining': '400' }));
    expect(() => low.take('sweep')).toThrow();
    low.take('mutate');
    // 600 left of 1000 is above the reserve: sweeps pass.
    const high = new RateBudget({ perMinute: 250, perHour: 5000, clock });
    high.observe(new Headers({ 'ratelimit-limit': '1000', 'ratelimit-remaining': '600' }));
    high.take('sweep');
  });
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
    const shared = budgetFor('aaaa', options);
    expect(budgetFor('aaaa', options)).toBe(shared);
    expect(budgetFor('bbbb', options)).not.toBe(shared);
    // resetBudgets (via the harness) gives the next test a clean one.
    freshBudgets();
    expect(budgetFor('aaaa', options)).not.toBe(shared);
  });
});

describe('ids', () => {
  const invalid = expect.objectContaining({ code: 'INVALID_INPUT' });

  it('ids round-trip and refuse malformed input', () => {
    expect(machineId(123)).toBe('123');
    expect(parseMachineId('123')).toBe(123);
    expect(parseMachineId(machineId(417_395_208))).toBe(417_395_208);
    for (const bad of ['0', '-1', 'abc', '1e3', '', '01', '1.5', ' 1', '9'.repeat(19)])
      expect(() => parseMachineId(bad)).toThrowError(invalid);

    expect(offerId('nyc3', 's-2vcpu-4gb')).toBe('nyc3/s-2vcpu-4gb');
    expect(offerId('nyc3', 's-2vcpu-4gb', true)).toBe('nyc3/s-2vcpu-4gb@spot');
    expect(parseOfferId(offerId('nyc3', 'gpu-h100x1-80gb', true))).toEqual({
      region: 'nyc3',
      size: 'gpu-h100x1-80gb',
      spot: true,
    });
    expect(parseOfferId('nyc3/s-2vcpu-4gb')).toEqual({
      region: 'nyc3',
      size: 's-2vcpu-4gb',
      spot: false,
    });
    for (const bad of [
      's-2vcpu-4gb',
      'nyc3/',
      '/s-2vcpu-4gb',
      'NYC3/s-1vcpu-1gb',
      'a/b/c',
      'nyc3/x@',
      'nyc3/x@od',
      '',
    ])
      expect(() => parseOfferId(bad)).toThrowError(invalid);
    expect(() => parseMachineId('abc')).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ provider: 'digitalocean' }) }),
    );
  });

  it('droplet names are bc- + a hostname-safe id', () => {
    expect(dropletName('inst_AB/cd')).toBe('bc-inst-ab-cd');
    expect(dropletName('x'.repeat(200))).toHaveLength(63);
    expect(dropletName('a'.repeat(59) + '-b-c')).toMatch(/^bc-[a-z0-9-]*[a-z0-9]$/);
    expect(dropletName('Ünï__code')).toMatch(/^bc-[a-z0-9-]+$/);
  });

  it('tags encode labels and decode back', () => {
    expect(Object.values(labels).slice(0, 5)).toEqual([
      'better-compute-managed',
      'better-compute-instance',
      'better-compute-tenant',
      'better-compute-pool',
      'better-compute-owner',
    ]);
    expect(
      labelsFromTags([tagFor(labels.tenant, 'acme'), tagFor(labels.pool, 'pool_1'), 'web']),
    ).toEqual({ 'better-compute-tenant': 'acme', 'better-compute-pool': 'pool_1' });
    expect(tagFor(labels.owner, 'Ann@Example.com')).toMatch(/^better-compute-owner:x[a-z2-7]{26}$/);
    // The same value always hashes to the same tag; different values to different ones.
    expect(tagFor(labels.owner, 'Ann@Example.com')).toBe(tagFor(labels.owner, 'Ann@Example.com'));
    expect(tagFor(labels.owner, 'ann@example.com')).not.toBe(
      tagFor(labels.owner, 'Ann@Example.com'),
    );
    // A long value or one with a colon is hashed; a colon would make the tag ambiguous to decode.
    expect(tagFor(labels.pool, 'a'.repeat(201))).toMatch(/^better-compute-pool:x[a-z2-7]{26}$/);
    expect(tagFor(labels.pool, 'a'.repeat(200))).toBe(`better-compute-pool:${'a'.repeat(200)}`);
    expect(tagFor(labels.pool, 'a:b')).toMatch(/^better-compute-pool:x[a-z2-7]{26}$/);
    expect(tagFor(labels.pool, '')).toMatch(/^better-compute-pool:x[a-z2-7]{26}$/);
    expect(tagFor(labels.managed, 'true')).toBe('better-compute-managed:true');
    const produced = [
      tagFor(labels.tenant, 'Acme Corp'),
      tagFor(labels.pool, 'p'.repeat(500)),
      tagFor(labels.owner, 'a:b@c'),
      deploymentTag('prod-eu'),
      keyTag('idem-key-1'),
      networkMemberTag('Default Network'),
    ];
    for (const tag of produced) expect(tag).toMatch(/^[a-z0-9:_-]{1,255}$/);
    expect(deploymentTag('prod-eu')).toMatch(/^better-compute-deployment:[0-9a-f]{12}$/);
    expect(keyTag('idem-key-1')).toMatch(/^better-compute-key:[0-9a-f]{24}$/);
    expect(networkMemberTag('n')).toMatch(/^bc-net-[0-9a-f]{16}$/);
    expect(deploymentTag('a')).not.toBe(deploymentTag('b'));
    // Only better-compute-* keys decode; the last of a duplicated key wins.
    expect(
      labelsFromTags([
        'bc-net-0123456789abcdef',
        'env:prod',
        'better-compute-pool:a',
        'better-compute-pool:b',
        'nocolon',
      ]),
    ).toEqual({ 'better-compute-pool': 'b' });
    // The value is whatever follows the first colon.
    expect(labelsFromTags(['better-compute-pool:a:b'])).toEqual({ 'better-compute-pool': 'a:b' });
    expect(isManagedTag('better-compute-tenant:acme')).toBe(true);
    expect(isManagedTag('bc-net-0123456789abcdef')).toBe(true);
    expect(isManagedTag('web')).toBe(false);
  });

  it('decoding is case-insensitive, as DO tag matching is', () => {
    expect(labelsFromTags(['Better-Compute-Tenant:ACME'])).toEqual({
      'better-compute-tenant': 'acme',
    });
    expect(labelsFromTags(['better-compute-pool:A', 'BETTER-COMPUTE-POOL:b'])).toEqual({
      'better-compute-pool': 'b',
    });
  });
});

describe('offers', () => {
  const config = { token: 'secret://do/t', regions: ['tor1'] };

  it('lists one offer per size and configured region with price and GPUs', async () => {
    const { client } = setup();
    const offers = await listOffers(client, config, {}, signal);
    // tor1 has eight of the nine fixture sizes (gpu-mi300x1-192gb is atl1 only).
    expect(offers).toHaveLength(8);
    expect(offers.every((o) => o.region === 'tor1' && o.kind === 'vps')).toBe(true);
    const fixtureSize = JSON.parse(
      readFileSync(new URL('./fixtures/digitalocean/sizes.json', import.meta.url), 'utf8'),
    ).sizes.find((s: { slug: string }) => s.slug === 'gpu-h100x1-80gb');
    expect(offers.find((o) => o.id === 'tor1/gpu-h100x1-80gb')).toEqual({
      id: 'tor1/gpu-h100x1-80gb',
      kind: 'vps',
      region: 'tor1',
      vcpu: 20,
      memoryGiB: 240,
      diskGiB: 720,
      gpus: { model: 'H100', count: 1 },
      pricePerHour: fixtureSize.price_hourly,
      currency: 'USD',
      available: true,
    });
    const plain = offers.find((o) => o.id === 'tor1/s-2vcpu-4gb')!;
    expect(plain.gpus).toBeUndefined();
    expect(plain.memoryGiB).toBe(4);
    expect(offers.map((o) => o.id)).not.toContain('tor1/gpu-mi300x1-192gb');
  });

  it('names GPU models after the inventory, or in an upper-case hyphenated form', () => {
    const named = (model: string) => gpuModelOf({ gpu_info: { count: 1, model } } as DoSize);
    expect(named('nvidia_h100')).toBe('H100');
    expect(named('nvidia_h200')).toBe('H200');
    expect(named('nvidia_l40s')).toBe('L40S');
    expect(named('nvidia_rtx_6000_ada')).toBe('RTX-6000-ADA');
    expect(named('nvidia_rtx_4000_ada')).toBe('RTX-4000-ADA');
    expect(named('nvidia_b300')).toBe('B300');
    expect(named('amd_mi300x')).toBe('MI300X');
    expect(gpuModelOf({ slug: 's-1vcpu-1gb' } as DoSize)).toBeUndefined();
  });

  it('filters by the query and by configured regions', async () => {
    const { client, emu } = setup();
    const wide = { token: 'secret://do/t', regions: ['tor1', 'atl1'] };
    const eight = await listOffers(client, wide, { gpuModel: 'h100', minGpus: 8 }, signal);
    expect(eight.map((o) => o.id)).toEqual(['tor1/gpu-h100x8-640gb']);

    const all = await listOffers(client, wide, {}, signal);
    expect(all.some((o) => o.region === 'atl1')).toBe(true);
    expect(all.some((o) => o.region === 'nyc3' || o.region === 'sfo3')).toBe(false);
    expect((await listOffers(client, config, {}, signal)).some((o) => o.region === 'atl1')).toBe(
      false,
    );

    expect(
      (await listOffers(client, wide, { region: 'atl1', gpuModel: 'MI300X' }, signal)).length,
    ).toBe(1);
    expect(await listOffers(client, wide, { region: 'nyc3' }, signal)).toEqual([]);
    expect(await listOffers(client, wide, { kind: 'metal' }, signal)).toEqual([]);
    const big = await listOffers(client, wide, { minVcpu: 100, minMemoryGiB: 1000 }, signal);
    expect(big.map((o) => o.id)).toEqual(['tor1/gpu-h100x8-640gb']);
    expect(emu.requests).toHaveLength(2); // the catalog was cached across all of these
  });

  it('an unavailable size in a region is offered with available:false', async () => {
    const { client, emu } = setup();
    // Not listed by the region, flagged off by the size, and a region that is itself unavailable.
    const tor1 = emu.state.regions.find((r) => r.slug === 'tor1')!;
    tor1.sizes = tor1.sizes.filter((s: string) => s !== 'gpu-l40sx1-48gb');
    emu.state.sizes.find((s) => s.slug === 'gpu-6000adax1-48gb')!.available = false;
    emu.state.regions.find((r) => r.slug === 'atl1')!.available = false;
    const wide = { token: 'secret://do/t', regions: ['tor1', 'atl1'] };
    const offers = await listOffers(client, wide, {}, signal);
    const byId = new Map(offers.map((o) => [o.id, o]));
    expect(byId.get('tor1/gpu-l40sx1-48gb')?.available).toBe(false);
    expect(byId.get('tor1/gpu-6000adax1-48gb')?.available).toBe(false);
    expect(byId.get('atl1/gpu-l40sx1-48gb')?.available).toBe(false);
    expect(byId.get('tor1/gpu-h100x1-80gb')?.available).toBe(true);
  });

  it('caches the catalog for ten minutes', async () => {
    const { client, emu, clock } = setup();
    await listOffers(client, config, {}, signal);
    await listOffers(client, config, { minGpus: 1 }, signal);
    expect(emu.requests.map((r) => r.url.pathname)).toEqual(['/v2/sizes', '/v2/regions']);
    clock.advance(10 * 60_000 - 1);
    await listOffers(client, config, {}, signal);
    expect(emu.requests).toHaveLength(2);
    clock.advance(1);
    await listOffers(client, config, {}, signal);
    expect(emu.requests).toHaveLength(4);
    // Another client has its own cache: it asks for the catalog again.
    const other = doClient({
      fetch: emu.fetch,
      endpoint,
      token: async () => 'do-token',
      budget: new RateBudget({ perMinute: 250, perHour: 5000, clock }),
      clock,
      log: noopLog,
    });
    await listOffers(other, config, {}, signal);
    expect(emu.requests).toHaveLength(6);
  });

  it('one caller aborting does not fail a caller sharing its load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const emu = new DoEmulator();
    const { client } = setup({
      fetch: async (input, init) => {
        if (!held) {
          held = true;
          await gate;
        }
        init?.signal?.throwIfAborted();
        return emu.fetch(input, init);
      },
    });
    const first = new AbortController();
    const a = listOffers(client, config, {}, first.signal).then(
      () => undefined,
      (error: Error) => error,
    );
    const b = listOffers(client, config, {}, signal);
    await Promise.resolve();
    first.abort();
    release();
    expect((await a)?.name).toBe('AbortError');
    expect(await b).not.toHaveLength(0);
    expect(emu.requests.map((r) => r.url.pathname)).toEqual(['/v2/sizes', '/v2/regions']);
  });

  it('a failed load is not cached', async () => {
    const { client, emu } = setup();
    emu.failNext({ path: /^\/sizes$/ }, 500, { id: 'server_error', message: 'boom' });
    await failure(listOffers(client, config, {}, signal));
    expect(await listOffers(client, config, {}, signal)).not.toHaveLength(0);
  });
});

describe('ssh keys', () => {
  // Generated once with ssh-keygen; the fingerprint is `ssh-keygen -E md5 -lf`'s, not ours.
  const key =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';
  const keyFingerprint = 'f8:4e:c2:ad:a9:00:19:a3:f5:45:3d:68:6e:28:0e:3c';
  const otherKey =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPb3suug6HUnqYdJ+FX+dcKIL5gAl+WJzl6aZEZZSHDu other@bc';

  const keyPosts = (emu: DoEmulator) =>
    emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v2/account/keys');

  it('fingerprints a key as the MD5 of its blob in colon-hex', () => {
    expect(md5Fingerprint(key)).toBe(keyFingerprint);
    // Independent of the implementation: MD5 over the decoded blob, with the comment ignored.
    const blob = Buffer.from(key.split(' ')[1]!, 'base64');
    const expected = createHash('md5')
      .update(blob)
      .digest('hex')
      .replace(/(..)(?!$)/g, '$1:');
    expect(md5Fingerprint(key)).toBe(expected);
    expect(
      md5Fingerprint(`  ${key.split(' ').slice(0, 2).join(' ')}
`),
    ).toBe(keyFingerprint);
  });

  it('registers a missing key once and reuses it by fingerprint', async () => {
    const { client, emu } = setup();
    const first = await ensureSshKeys(client, [key], undefined, signal);
    const second = await ensureSshKeys(client, [key], undefined, signal);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    const posts = keyPosts(emu);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      name: 'bc-f84ec2ada90019a3',
      public_key: key,
    });
    expect(emu.state.sshKeys.get(keyFingerprint)?.id).toBe(first[0]);
    // The lookup is by fingerprint.
    expect(
      emu.requests
        .filter((r) => r.method === 'GET')
        .map((r) => r.url.pathname.replaceAll('%3A', ':')),
    ).toEqual(Array(2).fill(`/v2/account/keys/${keyFingerprint}`));
  });

  it('adds the default key after the instance keys and drops duplicates', async () => {
    const { client, emu } = setup();
    const known = seedSshKey(emu.state, 'ops', otherKey);
    const ids = await ensureSshKeys(client, [key, key, otherKey], known.fingerprint, signal);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(known.id);
    expect(keyPosts(emu)).toHaveLength(1);
    // No instance keys: just the default.
    expect(await ensureSshKeys(client, [], known.fingerprint, signal)).toEqual([known.id]);
    expect(await ensureSshKeys(client, [], undefined, signal)).toEqual([]);
  });

  it('a default key that is not in the account is INVALID_CONFIG', async () => {
    const { client } = setup();
    const error = await failure(ensureSshKeys(client, [], keyFingerprint, signal));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'defaultSshKey' });
  });

  it('validates the default fingerprint before it is used in a request path', async () => {
    const { client, emu } = setup();
    for (const bad of ['../droplets', 'f8:4e', '', `${keyFingerprint}/x`]) {
      const error = await failure(ensureSshKeys(client, [], bad, signal));
      expect(error.code, JSON.stringify(bad)).toBe('INVALID_CONFIG');
      expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'defaultSshKey' });
    }
    expect(emu.requests).toHaveLength(0);
    // A valid fingerprint in upper case is lower-cased and found.
    const known = seedSshKey(emu.state, 'ops', key);
    expect(await ensureSshKeys(client, [], keyFingerprint.toUpperCase(), signal)).toEqual([
      known.id,
    ]);
    expect(emu.requests.map((r) => r.url.pathname.replaceAll('%3A', ':'))).toEqual([
      `/v2/account/keys/${keyFingerprint}`,
    ]);
  });

  it('a racing registration re-reads instead of failing', async () => {
    const { emu, client } = setup({
      // Someone else registers the key between our GET (404) and our POST: the key is in the
      // account by the time the POST arrives, and the emulator answers it with the in-use 422.
      fetch: async (input, init) => {
        if ((init?.method ?? 'GET') === 'POST') seedSshKey(emu.state, 'racer', key);
        return emu.fetch(input, init);
      },
    });
    const ids = await ensureSshKeys(client, [key], undefined, signal);
    expect(ids).toEqual([emu.state.sshKeys.get(keyFingerprint)!.id]);
    expect(emu.state.sshKeys.size).toBe(1);
    expect(emu.requests.map((r) => r.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('an in-use 422 for a key that still cannot be read is an error, not a loop', async () => {
    const { emu, client } = setup();
    emu.failNext(
      { method: 'POST', path: /^\/account\/keys$/ },
      422,
      errorFixtures.find((f) => f.name === '422-ssh-key-in-use')!.body,
    );
    const error = await failure(ensureSshKeys(client, [key], undefined, signal));
    expect(error.code).toBe('CONFLICT');
    expect(emu.requests.map((r) => r.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it.todo('create without any SSH key is refused before a droplet is posted');

  it('rejects a malformed public key as INVALID_INPUT', async () => {
    const [type, blob] = key.split(' ') as [string, string];
    const malformed = [
      '',
      'ssh-ed25519',
      `${type} `,
      `${type} not*base64!`,
      `${type} AAAA`,
      `ssh-rsa ${blob}`,
    ];
    for (const bad of malformed) {
      expect(() => md5Fingerprint(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({
          code: 'INVALID_INPUT',
          details: { provider: 'digitalocean', reason: 'sshKey' },
        }),
      );
    }
    const { client, emu } = setup();
    const error = await failure(ensureSshKeys(client, [key, 'ssh-rsa AAAA'], undefined, signal));
    expect(error.code).toBe('INVALID_INPUT');
    // Nothing is sent for a bad key; the good one before it is not registered either.
    expect(emu.requests).toHaveLength(0);
  });
});
