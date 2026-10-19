import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runConformance } from '@better-compute/core/conformance';
import { autoAttachLabels, providerConformanceCases } from '@better-compute/vps';
import {
  isComputeError,
  manualClock,
  type ComputeError,
  type ExternalMachine,
} from '@better-compute/core';
import {
  baseFirewallName,
  budgetFor,
  digitalocean,
  digitaloceanProvider,
  doClient,
  deploymentTag,
  doConfig,
  dropletName,
  ensureSshKeys,
  firewallName,
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
  probeAccount,
  RateBudget,
  tagFor,
  toMachine,
  unprocessablePatterns,
  type DoClient,
  DoCompute,
  type DoConfig,
  type DoDroplet,
  type DoSize,
} from '@better-compute/provider-digitalocean';
import {
  failAction,
  isoSeconds,
  settleAction,
  startAction,
} from './support/do-emulator/actions.js';
import { seedAutoscalePool } from './support/do-emulator/autoscale.js';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import { seedSshKey } from './support/do-emulator/keys.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import {
  build,
  ctx,
  doAccount,
  freshBudgets,
  noopLog,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// provider-digitalocean against an in-memory emulator of the DigitalOcean endpoints it uses,
// plugged in through the `fetch` option.

const endpoint = 'https://api.digitalocean.com/v2';
const signal = new AbortController().signal;

// Generated once with ssh-keygen; the fingerprint is `ssh-keygen -E md5 -lf`'s, not ours.
const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';

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
    const droplet = seedDroplet(emu.state);
    const started = startAction(emu.state, 'create', droplet);
    settleAction(emu.state, started, 'completed');
    const action = await client.action(started.id, signal);
    expect(action).toMatchObject({
      id: started.id,
      status: 'completed',
      type: 'create',
      resource_id: droplet.id,
      resource_type: 'droplet',
      region_slug: 'nyc3',
    });
    expect(emu.requests[0]!.url.pathname).toBe(`/v2/actions/${started.id}`);
    expect((await failure(client.action(1, signal))).code).toBe('NOT_FOUND');
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

  it('persisted names match their known answers', () => {
    // These names live on real Droplets and firewalls: ownership, deletion and the network
    // teardown find resources by them, so a change to any hash or encoding orphans what exists.
    // The literals were computed apart from the provider (node:crypto sha256, and an RFC 4648
    // base32 of its own); they are never to be regenerated from the code.
    expect(tagFor(labels.owner, 'Ann@Example.com')).toBe(
      'better-compute-owner:xavj4zs4mddqeohoyfabiktbffq',
    );
    expect(tagFor(labels.owner, 'ann@example.com')).toBe(
      'better-compute-owner:xohkpkx3s7iji362grindsakqps',
    );
    expect(tagFor(labels.instance, 'Inst_1')).toBe('better-compute-instance:inst_1');
    expect(deploymentTag('default')).toBe('better-compute-deployment:37a8eec1ce19');
    expect(keyTag('inst_1')).toBe('better-compute-key:f4a0cf320b1d3887654815e5');
    expect(networkMemberTag('bc-net1')).toBe('bc-net-f0a912060f31f36a');
    expect(baseFirewallName('bc-net1')).toBe('bc-base-f0a912060f31f36a');
    expect(firewallName('bc-r1', 'bc-net1', 1000)).toBe('bc-r1.nf0a912060f31f36a.p1000');
  });
});

describe('offers', () => {
  const config: DoConfig = { token: 'secret://do/t', regions: ['tor1'] };

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
    const wide: DoConfig = { token: 'secret://do/t', regions: ['tor1', 'atl1'] };
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
    const wide: DoConfig = { token: 'secret://do/t', regions: ['tor1', 'atl1'] };
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
  const key = testKey;
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
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'sshKeyFingerprint' });
  });

  it('validates the default fingerprint before it is used in a request path', async () => {
    const { client, emu } = setup();
    for (const bad of ['../droplets', 'f8:4e', '', `${keyFingerprint}/x`]) {
      const error = await failure(ensureSshKeys(client, [], bad, signal));
      expect(error.code, JSON.stringify(bad)).toBe('INVALID_CONFIG');
      expect(error.details).toMatchObject({
        provider: 'digitalocean',
        reason: 'sshKeyFingerprint',
      });
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

  it('create without any SSH key is refused before a droplet is posted', async () => {
    freshBudgets();
    const emu = new DoEmulator();
    const compute = await build(emu);
    const error = await failure(
      compute.create(
        { offerId: 'nyc3/s-1vcpu-1gb', image: 'ubuntu-24-04-x64', userData: '', name: 'i1' },
        ctx('i1'),
      ),
    );
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'noSshKey' });
    expect(emu.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

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

describe('compute', () => {
  beforeEach(freshBudgets);

  /** Every emulator the section built, for the last test's sweep over all their requests. */
  const emulators: DoEmulator[] = [];
  const t0 = Date.parse('2026-10-18T10:00:00Z');
  function emulator(): DoEmulator {
    const emu = new DoEmulator({ now: () => t0 });
    emulators.push(emu);
    return emu;
  }

  const ours = (key: string) => [
    'better-compute-managed:true',
    deploymentTag('default'),
    keyTag(key),
  ];
  const request = (over: Record<string, unknown> = {}) => ({
    offerId: 'nyc3/s-2vcpu-4gb',
    image: 'ubuntu-24-04-x64',
    userData: '#cloud-config\n',
    name: 'inst_1',
    sshKeys: [testKey],
    labels: { [labels.tenant]: 'acme' },
    ...over,
  });
  const posts = (emu: DoEmulator) =>
    emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v2/droplets');
  const deletes = (emu: DoEmulator) =>
    emu.requests.filter((r) => r.method === 'DELETE').map((r) => r.url.pathname);
  const withKey = (emu: DoEmulator, key: string) =>
    [...emu.state.droplets.values()].filter((d) => d.tags.includes(keyTag(key)));

  it('create posts the droplet with tags, keys, vpc and user data', async () => {
    const emu = emulator();
    const vpc = seedVpc(emu.state, { name: 'prod', region: 'nyc3' });
    const compute = await build(emu, { ...doAccount, vpc: 'prod' });
    // A label can't override a tag only the provider writes.
    const machine = await compute.create(
      request({ labels: { [labels.tenant]: 'acme', [labels.managed]: 'false' } }),
      ctx('inst_1'),
    );

    expect(posts(emu)).toHaveLength(1);
    const body = posts(emu)[0]!.body as Record<string, unknown>;
    const keyId = emu.state.sshKeys.get(md5Fingerprint(testKey))!.id;
    expect(body).toEqual({
      name: 'bc-inst-1',
      region: 'nyc3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      ssh_keys: [keyId],
      user_data: '#cloud-config\n',
      vpc_uuid: vpc.id,
      monitoring: true,
      ipv6: false,
      tags: expect.arrayContaining([
        'better-compute-managed:true',
        deploymentTag('default'),
        keyTag('inst_1'),
        'better-compute-instance:inst_1',
        'better-compute-tenant:acme',
      ]),
    });
    expect(body.tags).toHaveLength(5);
    const droplet = withKey(emu, 'inst_1')[0]!;
    expect(machine).toMatchObject({
      id: String(droplet.id),
      name: 'bc-inst-1',
      state: 'pending',
      offerId: 'nyc3/s-2vcpu-4gb',
      region: 'nyc3',
      labels: { [labels.tenant]: 'acme', [labels.managed]: 'true', [labels.instance]: 'inst_1' },
      claimedBy: 'inst_1',
    });
    // A new Droplet has no addresses yet.
    expect(machine.addresses).toEqual([]);
    // The tags of the create exist as account tags now (DO creates them implicitly).
    expect(emu.state.tags.has(keyTag('inst_1'))).toBe(true);
  });

  it('create resolves the vpc by uuid or by name, and sends none without one', async () => {
    const emu = emulator();
    const vpc = seedVpc(emu.state, { name: 'prod', region: 'nyc3' });
    const byUuid = await build(emu, { ...doAccount, vpc: vpc.id });
    await byUuid.create(request({ image: '12345' }), ctx('a'));
    expect(posts(emu)[0]!.body).toMatchObject({ vpc_uuid: vpc.id, image: 12345 });
    // A uuid is used as it is: no lookup.
    expect(emu.requests.some((r) => r.url.pathname === '/v2/vpcs')).toBe(false);

    const none = await build(emu, { ...doAccount, monitoring: false, ipv6: true });
    await none.create(request(), ctx('b'));
    const body = posts(emu)[1]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('vpc_uuid');
    expect(body).toMatchObject({ monitoring: false, ipv6: true });

    const missing = await build(emu, { ...doAccount, vpc: 'nope' });
    const error = await failure(missing.create(request(), ctx('c')));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'vpc' });
    expect(posts(emu)).toHaveLength(2);
  });

  it('create retries with one key return the same droplet without a second POST', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const first = await compute.create(request(), ctx('inst_1'));
    const second = await compute.create(request(), ctx('inst_1'));
    expect(second.id).toBe(first.id);
    expect(posts(emu)).toHaveLength(1);
    // Another key is another machine.
    const other = await compute.create(request({ name: 'inst_2' }), ctx('inst_2'));
    expect(other.id).not.toBe(first.id);
    expect(posts(emu)).toHaveLength(2);
    // The lookup is by the key tag.
    const lookup = emu.requests.find(
      (r) => r.method === 'GET' && r.url.pathname === '/v2/droplets',
    );
    expect(lookup!.url.searchParams.get('tag_name')).toBe(keyTag('inst_1'));
    expect(lookup!.url.searchParams.get('per_page')).toBe('200');
  });

  it('a retried GPU create finds its droplet through the gpus list, not only by tag', async () => {
    const emu = emulator();
    const compute = await build(emu, { ...doAccount, regions: ['tor1'] });
    const gpu = request({ offerId: 'tor1/gpu-h100x1-80gb', image: 'gpu-h100x1-base' });
    const first = await compute.create(gpu, ctx('inst_1'));
    expect(first.gpus).toEqual({ model: 'H100', count: 1 });
    // The emulator follows the spec's pessimistic reading: a tag_name list omits GPU Droplets.
    const byTag = await emu.fetch(`${endpoint}/droplets?tag_name=${keyTag('inst_1')}`, {
      headers: { authorization: 'Bearer do-token' },
    });
    expect(((await byTag.json()) as { droplets: unknown[] }).droplets).toHaveLength(0);

    const second = await compute.create(gpu, ctx('inst_1'));
    expect(second.id).toBe(first.id);
    expect(posts(emu)).toHaveLength(1);
    const gpuLists = emu.requests.filter((r) => r.url.searchParams.get('type') === 'gpus');
    expect(gpuLists.length).toBeGreaterThan(0);
    for (const list of gpuLists) expect(list.url.searchParams.has('tag_name')).toBe(false);
    // A plain offer never scans the GPU list.
    const before = emu.requests.length;
    await compute.create(request({ offerId: 'tor1/s-2vcpu-4gb', name: 'p' }), ctx('plain'));
    expect(emu.requests.slice(before).some((r) => r.url.searchParams.get('type') === 'gpus')).toBe(
      false,
    );
  });

  it('two racing creates with one key converge on the oldest droplet', async () => {
    const emu = emulator();
    const compute = await build(emu);
    // A droplet of another deployment with the same key is not ours: never returned, never reaped.
    const foreign = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('other'), keyTag('inst_1')],
    });
    // A racing create with the same key lands between our lookup and our POST, a second later.
    let racer: Record<string, any> | undefined;
    emu.beforeAction('POST /droplets', () => {
      racer = seedDroplet(emu.state, {
        tags: ours('inst_1'),
        size_slug: 's-2vcpu-4gb',
        created_at: isoSeconds(t0 + 1000),
      });
    });
    const first = await compute.create(request(), ctx('inst_1'));
    const second = await compute.create(request(), ctx('inst_1'));
    expect(racer).toBeDefined();
    expect(second.id).toBe(first.id);
    expect(first.id).not.toBe(String(racer!.id));
    expect(withKey(emu, 'inst_1').map((d) => d.id)).toEqual([foreign.id, Number(first.id)]);
    expect(deletes(emu)).toEqual([`/v2/droplets/${racer!.id}`]);

    // When the racer is the older one, ours is the one reaped.
    const older = emulator();
    const other = await build(older);
    let early: Record<string, any> | undefined;
    older.beforeAction('POST /droplets', () => {
      early = seedDroplet(older.state, {
        tags: ours('inst_1'),
        size_slug: 's-2vcpu-4gb',
        created_at: isoSeconds(t0 - 1000),
      });
    });
    const winner = await other.create(request(), ctx('inst_1'));
    expect(winner.id).toBe(String(early!.id));
    expect(withKey(older, 'inst_1').map((d) => d.id)).toEqual([early!.id]);
    expect(deletes(older)).toHaveLength(1);
    expect(deletes(older)[0]).not.toBe(`/v2/droplets/${early!.id}`);

    // Two calls in flight at once: both post, both reap the newer one (one DELETE finds it gone).
    const both = emulator();
    const twin = await build(both);
    const [a, b] = await Promise.all([
      twin.create(request(), ctx('inst_1')),
      twin.create(request(), ctx('inst_1')),
    ]);
    expect(posts(both)).toHaveLength(2);
    expect(a.id).toBe(b.id);
    expect(withKey(both, 'inst_1').map((d) => String(d.id))).toEqual([a.id]);
  });

  it('create maps capacity, quota and invalid-size 422s', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const cases: [string, string][] = [
      ['422-size-unavailable-in-region', 'CAPACITY_UNAVAILABLE'],
      ['422-insufficient-capacity', 'CAPACITY_UNAVAILABLE'],
      ['422-region-unavailable', 'CAPACITY_UNAVAILABLE'],
      ['422-droplet-limit', 'QUOTA_EXCEEDED'],
      ['422-invalid-size', 'INVALID_INPUT'],
      ['422-invalid-image', 'INVALID_INPUT'],
    ];
    for (const [name, code] of cases) {
      const fixture = errorFixtures.find((f) => f.name === name)!;
      emu.failNext({ method: 'POST', path: /^\/droplets$/ }, fixture.status, fixture.body);
      const error = await failure(compute.create(request(), ctx(name)));
      expect(error.code, name).toBe(code);
      expect(error.details, name).toMatchObject({
        provider: 'digitalocean',
        status: 422,
        requestId: fixture.body.request_id,
      });
    }
    // The emulator's own checks: a size DO doesn't know, and one the region doesn't sell.
    const unknown = await failure(compute.create(request({ offerId: 'nyc3/s-99vcpu' }), ctx('u')));
    expect(unknown.code).toBe('INVALID_INPUT');
    const elsewhere = await failure(
      compute.create(request({ offerId: 'nyc3/gpu-h100x1-80gb' }), ctx('e')),
    );
    expect(elsewhere.code).toBe('CAPACITY_UNAVAILABLE');
    expect(emu.state.droplets.size).toBe(0);
  });

  it('a create action that errors surfaces from get as CAPACITY_UNAVAILABLE', async () => {
    const emu = emulator();
    const compute = await build(emu);
    failAction(emu.state, { type: 'create' });
    const machine = await compute.create(request(), ctx('inst_1'));
    expect(machine.state).toBe('pending');
    const error = await failure(compute.get(machine.id, ctx()));
    expect(error.code).toBe('CAPACITY_UNAVAILABLE');
    expect(error.details).toMatchObject({
      provider: 'digitalocean',
      reason: 'createActionErrored',
    });
    expect(error.message).toMatch(/create action errored/);
    // The action is read from the Droplet's own action list.
    expect(emu.requests.some((r) => r.url.pathname === `/v2/droplets/${machine.id}/actions`)).toBe(
      true,
    );

    // A create that goes well is pending while its action runs, then running.
    const ok = await compute.create(request({ name: 'inst_2' }), ctx('inst_2'));
    expect((await compute.get(ok.id, ctx()))?.state).toBe('pending');
    const running = await compute.get(ok.id, ctx());
    expect(running?.state).toBe('running');
    expect(running?.addresses).toHaveLength(2);
  });

  it('get maps states and answers undefined for a missing or malformed id', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const states = { new: 'pending', active: 'running', off: 'stopped', archive: 'deleted' };
    for (const [status, state] of Object.entries(states)) {
      const droplet = seedDroplet(emu.state, { status: status as 'new' });
      expect((await compute.get(String(droplet.id), ctx()))?.state, status).toBe(state);
    }
    const weird = seedDroplet(emu.state);
    weird.status = 'something-new';
    expect((await compute.get(String(weird.id), ctx()))?.state).toBe('unknown');

    expect(await compute.get('999', ctx())).toBeUndefined();
    const sent = emu.requests.length;
    expect(await compute.get('abc', ctx())).toBeUndefined();
    expect(emu.requests).toHaveLength(sent);
  });

  it('toMachine reads addresses, labels, the claim and the network', () => {
    const emu = emulator();
    const droplet = seedDroplet(emu.state, {
      region: 'tor1',
      size_slug: 'gpu-h100x1-80gb',
      ipv6: true,
      tags: [
        'web',
        tagFor(labels.instance, 'inst_7'),
        tagFor(labels.tenant, 'acme'),
        networkMemberTag('n1'),
      ],
    }) as unknown as DoDroplet;
    const machine = toMachine(droplet);
    const v4 = (type: string) => droplet.networks.v4.find((n) => n.type === type)!.ip_address;
    expect(machine).toEqual({
      id: String(droplet.id),
      name: droplet.name,
      state: 'running',
      offerId: 'tor1/gpu-h100x1-80gb',
      region: 'tor1',
      addresses: [v4('public'), v4('private'), droplet.networks.v6[0]!.ip_address],
      machineType: 'gpu-h100x1-80gb',
      vcpu: 20,
      memoryGiB: 240,
      gpus: { model: 'H100', count: 1 },
      labels: { [labels.instance]: 'inst_7', [labels.tenant]: 'acme' },
      claimedBy: 'inst_7',
      createdAt: t0,
      networks: [
        {
          network: droplet.vpc_uuid,
          address: v4('private'),
          publicAddress: v4('public'),
          tags: [
            tagFor(labels.instance, 'inst_7'),
            tagFor(labels.tenant, 'acme'),
            networkMemberTag('n1'),
          ],
        },
      ],
    });
    // Without a VPC there is no network entry; without an instance tag no claim.
    const bare = seedDroplet(emu.state, { vpc_uuid: null }) as unknown as DoDroplet;
    expect(toMachine(bare).networks).toBeUndefined();
    expect(toMachine(bare).claimedBy).toBeUndefined();
  });

  it('oversized user data is refused before anything is posted', async () => {
    const emu = emulator();
    const compute = await build(emu);
    // DO's limit is 64 KiB of bytes, not characters.
    for (const userData of ['x'.repeat(65_537), 'é'.repeat(32_769)]) {
      const error = await failure(compute.create(request({ userData }), ctx('big')));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'userData' });
    }
    expect(emu.requests).toHaveLength(0);
    await compute.create(request({ userData: 'x'.repeat(65_536) }), ctx('edge'));
    expect(posts(emu)).toHaveLength(1);
  });

  it('a catalog image ref is UNSUPPORTED until P3', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const error = await failure(compute.create(request({ image: 'ubuntu@24.04' }), ctx()));
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'catalogImage' });
    expect(emu.requests).toHaveLength(0);
  });

  it('a spot offer is UNSUPPORTED until P3, even with allowSpot', async () => {
    const emu = emulator();
    const compute = await build(emu, { ...doAccount, allowSpot: true });
    const error = await failure(
      compute.create(request({ offerId: 'nyc3/s-2vcpu-4gb@spot' }), ctx()),
    );
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'spot' });
    expect(posts(emu)).toHaveLength(0);
  });

  it('a region outside the account and a bad label are refused up front', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const region = await failure(compute.create(request({ offerId: 'tor1/s-2vcpu-4gb' }), ctx()));
    expect(region.code).toBe('INVALID_INPUT');
    expect(region.details).toMatchObject({ provider: 'digitalocean', reason: 'region' });
    const label = await failure(
      compute.create(request({ labels: { 'example.com/team': 'a' } }), ctx()),
    );
    expect(label.code).toBe('INVALID_INPUT');
    expect(label.details).toMatchObject({ provider: 'digitalocean', reason: 'label' });
    // A key with a colon could forge a reserved prefix: `better-compute-instance:x:v` would read
    // as a second instance tag. Any colon in a key is refused.
    for (const key of [`${labels.instance}:x`, 'team:a', ':'] as const) {
      const colon = await failure(compute.create(request({ labels: { [key]: 'v' } }), ctx()));
      expect(colon.code, key).toBe('INVALID_INPUT');
      expect(colon.details, key).toMatchObject({ provider: 'digitalocean', reason: 'label' });
    }
    expect(emu.requests).toHaveLength(0);
  });

  it('delete refuses an unmanaged or foreign-deployment droplet; no DELETE is sent', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const unmanaged = seedDroplet(emu.state, { tags: [] });
    const foreign = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('other')],
    });
    // Claimed into this deployment but not handed over (no managed tag).
    const attached = seedDroplet(emu.state, {
      tags: [deploymentTag('default'), tagFor(labels.instance, 'inst_9')],
    });
    const mine = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('default')],
    });
    for (const droplet of [unmanaged, foreign, attached]) {
      const error = await failure(compute.delete(String(droplet.id), ctx()));
      expect(error.code).toBe('INVALID_STATE');
      expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'notManaged' });
    }
    expect(deletes(emu)).toEqual([]);
    await compute.delete(String(mine.id), ctx());
    expect(deletes(emu)).toEqual([`/v2/droplets/${mine.id}`]);
    expect([...emu.state.droplets.keys()]).toEqual([unmanaged.id, foreign.id, attached.id]);
  });

  it('delete of a droplet that is already gone succeeds', async () => {
    const emu = emulator();
    const compute = await build(emu);
    await compute.delete('999', ctx());
    await compute.delete('abc', ctx());
    expect(deletes(emu)).toEqual([]);
    // Gone between our read and our DELETE.
    const mine = seedDroplet(emu.state, { tags: ours('x') });
    emu.failNext({ method: 'DELETE', path: /^\/droplets\/\d+$/ }, 404, {
      id: 'not_found',
      message: 'The resource you were accessing could not be found.',
    });
    await compute.delete(String(mine.id), ctx());
    expect(deletes(emu)).toEqual([`/v2/droplets/${mine.id}`]);
  });

  // -------------------------------------------------------------------- reap and retry paths

  it('a retried create with two owned droplets under one key keeps the oldest and reaps only the other', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const old = seedDroplet(emu.state, {
      tags: ours('inst_1'),
      created_at: isoSeconds(t0 - 2000),
    });
    const newer = seedDroplet(emu.state, {
      tags: ours('inst_1'),
      created_at: isoSeconds(t0 - 1000),
    });
    // Same key tag, but not ours to delete: another deployment's, and one that is not managed.
    const foreign = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('other'), keyTag('inst_1')],
      created_at: isoSeconds(t0 - 3000),
    });
    const unmanaged = seedDroplet(emu.state, {
      tags: [deploymentTag('default'), keyTag('inst_1')],
      created_at: isoSeconds(t0 - 4000),
    });
    const machine = await compute.create(request(), ctx('inst_1'));
    expect(machine.id).toBe(String(old.id));
    expect(posts(emu)).toHaveLength(0);
    expect(deletes(emu)).toEqual([`/v2/droplets/${newer.id}`]);
    expect([...emu.state.droplets.keys()]).toEqual([old.id, foreign.id, unmanaged.id]);
  });

  it('a create whose POST fails UNAVAILABLE returns the droplet if it landed', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const serverError = errorFixtures.find((e) => e.name === 'server-error')!;
    // The Droplet is created, then the answer is lost to a 500.
    let landed: Record<string, any> | undefined;
    emu.beforeAction('POST /droplets', () => {
      landed = seedDroplet(emu.state, {
        name: 'bc-inst-1',
        size_slug: 's-2vcpu-4gb',
        status: 'new',
        tags: [...ours('inst_1'), tagFor(labels.instance, 'inst_1')],
      });
    });
    emu.failNext({ method: 'POST', path: /^\/droplets$/ }, serverError.status, serverError.body);
    const machine = await compute.create(request(), ctx('inst_1'));
    expect(landed).toBeDefined();
    expect(machine.id).toBe(String(landed!.id));
    expect(posts(emu)).toHaveLength(1);
    expect(deletes(emu)).toEqual([]);
  });

  it('a create whose POST fails UNAVAILABLE with nothing landed rethrows that error', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const serverError = errorFixtures.find((e) => e.name === 'server-error')!;
    emu.failNext({ method: 'POST', path: /^\/droplets$/ }, serverError.status, serverError.body);
    const error = await failure(compute.create(request(), ctx('inst_1')));
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.details).toMatchObject({ provider: 'digitalocean', status: 500 });
    expect(posts(emu)).toHaveLength(1);
    expect(emu.state.droplets.size).toBe(0);
    // The key lookup ran again after the failed POST.
    const lookups = emu.requests.filter(
      (r) => r.method === 'GET' && r.url.searchParams.get('tag_name') === keyTag('inst_1'),
    );
    expect(lookups).toHaveLength(2);
  });

  it('get answers undefined when the droplet vanishes while its create action is read', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const fresh = seedDroplet(emu.state, { status: 'new', tags: ours('inst_1') });
    emu.failNext({ method: 'GET', path: /^\/droplets\/\d+\/actions$/ }, 404, {
      id: 'not_found',
      message: 'The resource you were accessing could not be found.',
    });
    expect(await compute.get(String(fresh.id), ctx())).toBeUndefined();
    // Other failures of that read still surface.
    const serverError = errorFixtures.find((e) => e.name === 'server-error')!;
    emu.failNext({ method: 'GET', path: /^\/droplets\/\d+\/actions$/ }, 500, serverError.body);
    expect((await failure(compute.get(String(fresh.id), ctx()))).code).toBe('UNAVAILABLE');
  });

  // ---------------------------------------------------------------- power, reinstall, list

  const instanceTags = (instance: string) => [
    'better-compute-managed:true',
    deploymentTag('default'),
    tagFor(labels.instance, instance),
  ];
  const actionPosts = (emu: DoEmulator) =>
    emu.requests.filter(
      (r) => r.method === 'POST' && /^\/v2\/droplets\/\d+\/actions$/.test(r.url.pathname),
    );

  it('power maps actions; nmi is UNSUPPORTED', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const droplet = seedDroplet(emu.state, { tags: instanceTags('inst_1') });
    const id = String(droplet.id);
    const mapping = [
      ['on', 'power_on'],
      ['off', 'power_off'],
      ['graceful-off', 'shutdown'],
      ['graceful-restart', 'reboot'],
      ['cycle', 'power_cycle'],
      ['reset', 'power_cycle'],
    ] as const;
    for (const [action] of mapping) expect(await compute.power(id, action, ctx())).toBeUndefined();
    expect(actionPosts(emu).map((r) => r.body)).toEqual(mapping.map(([, type]) => ({ type })));
    for (const r of actionPosts(emu)) expect(r.url.pathname).toBe(`/v2/droplets/${id}/actions`);
    // The actions are recorded, and an off/on pair is observable through get.
    expect([...emu.state.actions.values()].map((a) => a.type)).toEqual(mapping.map(([, t]) => t));
    await compute.power(id, 'off', ctx());
    expect((await compute.get(id, ctx()))?.state).toBe('stopped');
    await compute.power(id, 'on', ctx());
    expect((await compute.get(id, ctx()))?.state).toBe('running');

    // nmi has no DigitalOcean equivalent: refused before any request.
    const sent = emu.requests.length;
    const error = await failure(compute.power(id, 'nmi', ctx()));
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'nmi' });
    expect(emu.requests).toHaveLength(sent);

    // An attached droplet (claimed, not handed over: no managed tag) can still be powered.
    const attached = seedDroplet(emu.state, {
      tags: [deploymentTag('default'), tagFor(labels.instance, 'inst_9')],
    });
    await compute.power(String(attached.id), 'graceful-off', ctx());
    expect(emu.state.droplets.get(attached.id)!.status).toBe('off');
    // A missing droplet is NOT_FOUND.
    expect((await failure(compute.power('999', 'on', ctx()))).code).toBe('NOT_FOUND');
    expect((await failure(compute.power('abc', 'on', ctx()))).code).toBe('NOT_FOUND');
  });

  it("power and reinstall refuse a droplet that is not this instance's", async () => {
    const emu = emulator();
    const compute = await build(emu);
    const unmanaged = seedDroplet(emu.state, { tags: [] });
    const foreign = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('other'), tagFor(labels.instance, 'i')],
    });
    // In this deployment but never claimed by an instance.
    const unclaimed = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('default')],
    });
    // Claimed in this deployment without the managed tag: powerable, never rebuilt.
    const attached = seedDroplet(emu.state, {
      tags: [deploymentTag('default'), tagFor(labels.instance, 'inst_9')],
    });
    // An instance tag without this deployment's tag.
    const stray = seedDroplet(emu.state, { tags: [tagFor(labels.instance, 'inst_9')] });

    for (const droplet of [unmanaged, foreign, unclaimed, stray]) {
      const error = await failure(compute.power(String(droplet.id), 'off', ctx()));
      expect(error.code).toBe('INVALID_STATE');
      expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'notInstance' });
    }
    for (const droplet of [unmanaged, foreign, attached, stray]) {
      const error = await failure(compute.reinstall(String(droplet.id), 'ubuntu-24-04-x64', ctx()));
      expect(error.code).toBe('INVALID_STATE');
      expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'notManaged' });
    }
    expect(actionPosts(emu)).toEqual([]);
    expect([...emu.state.actions.values()]).toEqual([]);
  });

  it('reinstall rebuilds with the image', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const droplet = seedDroplet(emu.state, { tags: instanceTags('inst_1') });
    const id = String(droplet.id);
    expect(await compute.reinstall(id, 'debian-12-x64', ctx())).toBeUndefined();
    await compute.reinstall(id, '12345', ctx());
    expect(actionPosts(emu).map((r) => r.body)).toEqual([
      { type: 'rebuild', image: 'debian-12-x64' },
      { type: 'rebuild', image: 12345 },
    ]);
    // A rebuild keeps the droplet's status.
    expect(emu.state.droplets.get(droplet.id)!.status).toBe('active');
    expect([...emu.state.actions.values()].map((a) => a.type)).toEqual(['rebuild', 'rebuild']);

    // Catalog images are not supported yet, as in create; refused before any request.
    const sent = emu.requests.length;
    const error = await failure(compute.reinstall(id, 'my-image@1', ctx()));
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'catalogImage' });
    expect(emu.requests).toHaveLength(sent);
    expect((await failure(compute.reinstall('999', 'debian-12-x64', ctx()))).code).toBe(
      'NOT_FOUND',
    );
  });

  async function listed(compute: DoCompute): Promise<ExternalMachine[]> {
    const out: ExternalMachine[] = [];
    for await (const machine of compute.list(ctx())) out.push(machine);
    return out;
  }

  it("list yields only this deployment's managed droplets, across pages", async () => {
    const emu = emulator();
    const compute = await build(emu);
    const mine: number[] = [];
    for (let i = 0; i < 450; i += 1)
      mine.push(seedDroplet(emu.state, { tags: instanceTags(`i${i}`) }).id);
    // None of these are ours to manage.
    seedDroplet(emu.state, { tags: [] });
    seedDroplet(emu.state, { tags: ['better-compute-managed:true', deploymentTag('other')] });
    seedDroplet(emu.state, { tags: [deploymentTag('default'), tagFor(labels.instance, 'att')] });

    const machines = await listed(compute);
    expect(machines.map((m) => m.id)).toEqual(mine.map(String));
    expect(machines[0]).toMatchObject({ state: 'running', claimedBy: 'i0' });

    const lists = emu.requests.filter(
      (r) =>
        r.method === 'GET' &&
        r.url.pathname === '/v2/droplets' &&
        r.url.searchParams.has('tag_name'),
    );
    expect(lists.map((r) => r.url.searchParams.get('page') ?? '1')).toEqual(['1', '2', '3']);
    for (const r of lists) {
      expect(r.url.searchParams.get('tag_name')).toBe(deploymentTag('default'));
      expect(r.url.searchParams.get('per_page')).toBe('200');
    }
  });

  it('list includes managed GPU droplets', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const plain = seedDroplet(emu.state, { tags: instanceTags('plain') });
    const gpu = seedDroplet(emu.state, {
      size_slug: 'gpu-h100x1-80gb',
      region: 'tor1',
      tags: instanceTags('gpu'),
    });
    // GPU droplets that are not ours: another deployment's, and one that is not managed.
    seedDroplet(emu.state, {
      size_slug: 'gpu-h100x1-80gb',
      region: 'tor1',
      tags: ['better-compute-managed:true', deploymentTag('other')],
    });
    seedDroplet(emu.state, {
      size_slug: 'gpu-h100x1-80gb',
      region: 'tor1',
      tags: [deploymentTag('default'), tagFor(labels.instance, 'att')],
    });

    const machines = await listed(compute);
    expect(machines.map((m) => m.id).sort()).toEqual([String(plain.id), String(gpu.id)].sort());
    expect(machines.find((m) => m.id === String(gpu.id))?.gpus).toEqual({
      model: 'H100',
      count: 1,
    });
    // The GPU list is its own request and never carries tag_name (research S2).
    const gpuLists = emu.requests.filter((r) => r.url.searchParams.get('type') === 'gpus');
    expect(gpuLists).toHaveLength(1);
    expect(gpuLists[0]!.url.searchParams.has('tag_name')).toBe(false);
  });

  it('the definition builds a client without any request or secret, and checks its options', async () => {
    expect(digitalocean).toMatchObject({
      extension: 'provider',
      id: 'digitalocean',
      version: '0.1.0',
      provides: ['vps'],
      capabilities: ['power', 'reinstall', 'list', 'discover', 'claim', 'networks'],
    });
    const emu = emulator();
    let resolved = 0;
    const context = {
      clock: manualClock(1_000_000),
      secrets: {
        resolve: async (ref: string) => {
          resolved += 1;
          return secrets.resolve(ref);
        },
      },
      log: noopLog,
      account: platformAccount,
    };
    const config = { token: 'secret://do/t', regions: ['nyc3'] } as DoConfig;
    const compute = await digitaloceanProvider({ fetch: emu.fetch }).create(config, context);
    expect(emu.requests).toHaveLength(0);
    expect(resolved).toBe(0);
    // The token is resolved on first use, once.
    expect((await compute.listOffers({})).length).toBeGreaterThan(0);
    expect(await compute.get('999', ctx())).toBeUndefined();
    expect(resolved).toBe(1);
    const requests = emu.requests.length;

    const refused = async (options: object, account: object) =>
      failure(
        (async () =>
          digitaloceanProvider({ fetch: emu.fetch, ...options }).create(
            account as typeof config,
            context,
          ))(),
      );
    expect((await refused({}, { ...config, regions: [] })).code).toBe('INVALID_CONFIG');
    for (const inCallWaitMs of [-1, 20_001, 1.5, Number.NaN])
      expect((await refused({ inCallWaitMs }, config)).code, String(inCallWaitMs)).toBe(
        'INVALID_CONFIG',
      );
    await digitaloceanProvider({ fetch: emu.fetch, inCallWaitMs: 20_000 }).create(config, context);
    // discoverTag is a tag as DO stores it: refused, never lower-cased, when it is not one.
    for (const discoverTag of ['Fleet', '', 'a b', 'fleet/x', 'x'.repeat(256)]) {
      const error = await refused({}, { ...config, discoverTag });
      expect(error.code, discoverTag).toBe('INVALID_CONFIG');
      expect(error.details, discoverTag).toMatchObject({
        provider: 'digitalocean',
        reason: 'discoverTag',
      });
    }
    for (const discoverTag of ['fleet', 'env:prod', 'k8s_pool-1', 'x'.repeat(255)])
      await digitaloceanProvider({ fetch: emu.fetch }).create({ ...config, discoverTag }, context);
    expect(emu.requests).toHaveLength(requests);
  });

  it('never calls a tag-scoped bulk endpoint', () => {
    const all: RecordedRequest[] = emulators.flatMap((emu) => emu.requests);
    expect(all.length).toBeGreaterThan(50);
    const bulk = all.filter(
      (r) =>
        (r.method === 'DELETE' || r.method === 'POST') &&
        ['/v2/droplets', '/v2/droplets/actions'].includes(r.url.pathname) &&
        r.url.searchParams.has('tag_name'),
    );
    expect(bulk).toEqual([]);
  });
});

describe('attach', () => {
  beforeEach(freshBudgets);

  const t0 = Date.parse('2026-10-18T10:00:00Z');
  const emulator = () => new DoEmulator({ now: () => t0 });
  const instanceTag = (instance: string) => tagFor(labels.instance, instance);
  const managed = 'better-compute-managed:true';

  async function discovered(compute: DoCompute): Promise<ExternalMachine[]> {
    const out: ExternalMachine[] = [];
    for await (const machine of compute.discover!(ctx())) out.push(machine);
    return out;
  }
  const dropletLists = (emu: DoEmulator) =>
    emu.requests.filter((r) => r.method === 'GET' && r.url.pathname === '/v2/droplets');
  const tagWrites = (emu: DoEmulator) =>
    emu.requests.filter((r) => r.url.pathname.startsWith('/v2/tags') && r.method !== 'GET');
  const unassigned = (emu: DoEmulator) =>
    emu.requests
      .filter((r) => r.method === 'DELETE')
      .map((r) => decodeURIComponent(r.url.pathname));
  const autoscaleLists = (emu: DoEmulator) =>
    emu.requests.filter((r) => r.url.pathname === '/v2/droplets/autoscale');

  it('discover yields unmanaged droplets with labels decoded from tags', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const hand = seedDroplet(emu.state, {
      tags: ['better-compute-tenant:acme', 'better-compute-pool:pool_1', 'web', 'Env:Prod'],
    });
    const bare = seedDroplet(emu.state, { tags: [] });

    const machines = await discovered(compute);
    expect(machines.map((m) => m.id)).toEqual([String(hand.id), String(bare.id)]);
    // The labels vps auto-attach reads, by the keys it reads them with.
    expect(machines[0]!.labels).toEqual({
      [autoAttachLabels.tenant]: 'acme',
      [autoAttachLabels.pool]: 'pool_1',
    });
    expect(machines[0]!.claimedBy).toBeUndefined();
    expect(machines[1]!.labels).toEqual({});
    for (const r of dropletLists(emu)) expect(r.url.searchParams.get('per_page')).toBe('200');
  });

  it('discover honours discoverTag and configured regions', async () => {
    const emu = emulator();
    const compute = await build(emu, { ...doAccount, discoverTag: 'fleet' });
    const wanted = seedDroplet(emu.state, { tags: ['fleet'], name: 'wanted' });
    seedDroplet(emu.state, { tags: ['other'] });
    seedDroplet(emu.state, { tags: ['fleet'], region: 'tor1' });
    // A tagged GPU droplet in a configured region, and one without the tag.
    const gpu = seedDroplet(emu.state, {
      size_slug: 'gpu-h100x1-80gb',
      region: 'nyc3',
      tags: ['FLEET'],
    });
    seedDroplet(emu.state, { size_slug: 'gpu-h100x1-80gb', region: 'nyc3', tags: ['other'] });

    const machines = await discovered(compute);
    expect(machines.map((m) => m.id).sort()).toEqual([String(wanted.id), String(gpu.id)].sort());
    const lists = dropletLists(emu);
    expect(lists.map((r) => r.url.searchParams.get('tag_name'))).toEqual(['fleet', null]);
    // The GPU list can't be combined with tag_name (research S2): the tag is applied here.
    expect(lists[1]!.url.searchParams.get('type')).toBe('gpus');
  });

  it('discover includes GPU droplets, which the default list omits', async () => {
    const emu = emulator();
    const compute = await build(emu, { ...doAccount, regions: ['nyc3', 'tor1'] });
    const plain = seedDroplet(emu.state, { tags: [] });
    const gpu = seedDroplet(emu.state, { size_slug: 'gpu-h100x1-80gb', region: 'tor1', tags: [] });

    const machines = await discovered(compute);
    expect(machines.map((m) => m.id)).toEqual([String(plain.id), String(gpu.id)]);
    expect(machines[1]!.gpus).toEqual({ model: 'H100', count: 1 });
    expect(dropletLists(emu).filter((r) => r.url.searchParams.get('type') === 'gpus')).toHaveLength(
      1,
    );
  });

  it('claim tags the droplet; managed also hands deletion over', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const a = seedDroplet(emu.state, { tags: ['better-compute-tenant:acme'] });
    const b = seedDroplet(emu.state, { tags: [] });

    const machine = await compute.claim!(String(a.id), 'inst_1', ctx());
    expect(machine).toMatchObject({ id: String(a.id), claimedBy: 'inst_1' });
    expect(machine.labels).toMatchObject({ [labels.instance]: 'inst_1', [labels.tenant]: 'acme' });
    expect(a.tags).toEqual(
      expect.arrayContaining([instanceTag('inst_1'), deploymentTag('default')]),
    );
    expect(a.tags).not.toContain(managed);
    // An attached droplet is powerable but never deletable: better-compute did not create it.
    await compute.power(String(a.id), 'off', ctx());
    expect((await failure(compute.delete(String(a.id), ctx()))).details?.reason).toBe('notManaged');
    expect(emu.state.droplets.has(a.id)).toBe(true);

    // With managed, the droplet is deletable as well.
    await compute.claim!(String(b.id), 'inst_2', ctx(), { managed: true });
    expect(b.tags).toEqual(expect.arrayContaining([instanceTag('inst_2'), managed]));
    await compute.delete(String(b.id), ctx());
    expect(emu.state.droplets.has(b.id)).toBe(false);
  });

  it('a claim is idempotent and a later managed claim only adds the managed tag', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: [] });
    const id = String(d.id);
    await compute.claim!(id, 'inst_1', ctx());
    const first = tagWrites(emu).length;
    expect(first).toBeGreaterThan(0);

    await compute.claim!(id, 'inst_1', ctx());
    expect(tagWrites(emu)).toHaveLength(first);

    await compute.claim!(id, 'inst_1', ctx(), { managed: true });
    const added = tagWrites(emu).slice(first);
    expect(added.map((r) => `${r.method} ${decodeURIComponent(r.url.pathname)}`)).toEqual([
      'POST /v2/tags',
      `POST /v2/tags/${managed}/resources`,
    ]);
    expect(added[1]!.body).toEqual({ resources: [{ resource_id: id, resource_type: 'droplet' }] });
    expect(d.tags.filter((t: string) => t === instanceTag('inst_1'))).toHaveLength(1);
    expect(d.tags).toContain(managed);
  });

  it('a droplet claimed by another instance is CONFLICT', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: [instanceTag('other')] });
    const error = await failure(compute.claim!(String(d.id), 'inst_1', ctx(), { managed: true }));
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'claimedByAnother' });
    expect(tagWrites(emu)).toEqual([]);
    expect(d.tags).toEqual([instanceTag('other')]);
  });

  it('a claim that races another claim backs out its own tag', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: ['better-compute-tenant:acme'] });
    // While our claim writes its tags, another instance claims the droplet.
    emu.beforeAction('POST /tags/*/resources', () => {
      (d.tags as string[]).push(instanceTag('other'));
    });

    const error = await failure(compute.claim!(String(d.id), 'inst_1', ctx(), { managed: true }));
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ reason: 'claimedByAnother' });
    // Our instance tag is gone and the managed tag was never written; the other claim is
    // untouched and the deployment tag stays.
    expect(d.tags).toContain(instanceTag('other'));
    expect(d.tags).not.toContain(instanceTag('inst_1'));
    expect(d.tags).not.toContain(managed);
    expect(d.tags).toContain('better-compute-tenant:acme');
    expect(d.tags).toContain(deploymentTag('default'));
    expect(unassigned(emu)).toEqual([`/v2/tags/${instanceTag('inst_1')}/resources`]);
  });

  it('a claim that races keeps a managed tag it did not add', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: [managed] });
    emu.beforeAction('POST /tags/*/resources', () => {
      (d.tags as string[]).push(instanceTag('other'));
    });
    await failure(compute.claim!(String(d.id), 'inst_1', ctx(), { managed: true }));
    expect(d.tags).toContain(managed);
    expect(d.tags).not.toContain(instanceTag('inst_1'));
  });

  it("a claim that loses never wrote the managed tag, so it cannot take the winner's", async () => {
    const emu = emulator();
    const winner = await build(emu);
    const d = seedDroplet(emu.state, { tags: [] });
    const id = String(d.id);
    // The loser has read the untagged droplet; before it writes, the winner claims it whole.
    let raced = false;
    const racing: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
      if (!raced && init?.method === 'POST' && url.pathname === '/v2/tags') {
        raced = true;
        await winner.claim!(id, 'inst_a', ctx(), { managed: true });
      }
      return emu.fetch(input, init);
    };
    const loser = await build(emu, doAccount, { fetch: racing });

    const error = await failure(loser.claim!(id, 'inst_b', ctx(), { managed: true }));
    expect(raced).toBe(true);
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ reason: 'claimedByAnother' });
    // The winner's claim is whole, and still deletable.
    expect(d.tags).toEqual(
      expect.arrayContaining([instanceTag('inst_a'), deploymentTag('default'), managed]),
    );
    expect(d.tags).not.toContain(instanceTag('inst_b'));
    expect(unassigned(emu)).toEqual([`/v2/tags/${instanceTag('inst_b')}/resources`]);
    // The managed tag is assigned once: by the winner.
    const managedWrites = emu.requests.filter(
      (r) =>
        r.method === 'POST' &&
        decodeURIComponent(r.url.pathname) === `/v2/tags/${managed}/resources`,
    );
    expect(managedWrites).toHaveLength(1);
    await winner.delete(id, ctx());
    expect(emu.state.droplets.has(d.id)).toBe(false);
  });

  it('a managed write that fails leaves a plain claim that a repeated claim completes', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: [] });
    const id = String(d.id);
    const serverError = errorFixtures.find((e) => e.name === 'server-error')!;
    emu.failNext(
      { method: 'POST', path: /^\/tags\/better-compute-managed[^/]*\/resources$/ },
      serverError.status,
      serverError.body,
    );

    expect((await failure(compute.claim!(id, 'inst_1', ctx(), { managed: true }))).code).toBe(
      'UNAVAILABLE',
    );
    expect(d.tags).toEqual(
      expect.arrayContaining([instanceTag('inst_1'), deploymentTag('default')]),
    );
    expect(d.tags).not.toContain(managed);

    const machine = await compute.claim!(id, 'inst_1', ctx(), { managed: true });
    expect(machine.claimedBy).toBe('inst_1');
    expect(d.tags).toContain(managed);
    await compute.delete(id, ctx());
    expect(emu.state.droplets.has(d.id)).toBe(false);
  });

  it("a failed back-out leaves a state that the loser's next claim heals", async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: [] });
    const id = String(d.id);
    emu.beforeAction('POST /tags/*/resources', () => {
      (d.tags as string[]).push(instanceTag('other'));
    });
    const serverError = errorFixtures.find((e) => e.name === 'server-error')!;
    emu.failNext(
      { method: 'DELETE', path: /^\/tags\/[^/]+\/resources$/ },
      serverError.status,
      serverError.body,
    );

    // The back-out fails, but the caller still learns the claim is lost.
    const lost = await failure(compute.claim!(id, 'inst_1', ctx()));
    expect(lost.details).toMatchObject({ reason: 'claimedByAnother' });
    expect(d.tags).toEqual(expect.arrayContaining([instanceTag('inst_1'), instanceTag('other')]));

    // The retry finds its own tag next to the rival's, drops it and is still refused.
    const retry = await failure(compute.claim!(id, 'inst_1', ctx()));
    expect(retry.details).toMatchObject({ reason: 'claimedByAnother' });
    expect(d.tags).toContain(instanceTag('other'));
    expect(d.tags).not.toContain(instanceTag('inst_1'));
    expect(unassigned(emu)).toEqual([
      `/v2/tags/${instanceTag('inst_1')}/resources`,
      `/v2/tags/${instanceTag('inst_1')}/resources`,
    ]);
  });

  it("only a pool's member list makes a pool label: a tag or a create label cannot", async () => {
    const forged = 'better-compute-autoscale-pool:pool_x';
    const droplet = seedDroplet(emulator().state, { tags: [forged, 'better-compute-tenant:acme'] });
    expect(toMachine(droplet as unknown as DoDroplet).labels).toEqual({
      'better-compute-tenant': 'acme',
    });

    const emu = emulator();
    const compute = await build(emu);
    await compute.create(
      {
        offerId: 'nyc3/s-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        userData: '',
        name: 'inst_1',
        sshKeys: [testKey],
        labels: { [labels.autoscalePool]: 'pool_x', [labels.tenant]: 'acme' },
      },
      ctx('inst_1'),
    );
    const made = [...emu.state.droplets.values()][0]!;
    expect(made.tags).not.toContain(forged);
    expect(made.tags).toContain('better-compute-tenant:acme');
  });

  it('a claim of a droplet that is missing or outside the account regions is refused', async () => {
    const emu = emulator();
    const compute = await build(emu);
    expect((await failure(compute.claim!('999', 'inst_1', ctx()))).code).toBe('NOT_FOUND');
    expect((await failure(compute.claim!('not-an-id', 'inst_1', ctx()))).code).toBe('NOT_FOUND');
    const far = seedDroplet(emu.state, { region: 'tor1', tags: [] });
    const error = await failure(compute.claim!(String(far.id), 'inst_1', ctx()));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details?.reason).toBe('region');
    expect(tagWrites(emu)).toEqual([]);
  });

  it('autoscale pool members are discovered but refused for claim', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const member = seedDroplet(emu.state, { tags: ['better-compute-autoscale-pool:forged'] });
    const free = seedDroplet(emu.state, { tags: ['better-compute-autoscale-pool:forged'] });
    const pool = seedAutoscalePool(emu.state, { name: 'web', members: [member.id] });

    const machines = await discovered(compute);
    // A forged tag is not membership: only the pool's own member list is.
    expect(machines.find((m) => m.id === String(member.id))!.labels).toEqual({
      'better-compute-autoscale-pool': pool.id,
    });
    expect(machines.find((m) => m.id === String(free.id))!.labels).toEqual({});
    expect(autoscaleLists(emu)).toHaveLength(1);
    expect(autoscaleLists(emu)[0]!.url.searchParams.get('per_page')).toBe('200');
    expect(
      emu.requests.some((r) => r.url.pathname === `/v2/droplets/autoscale/${pool.id}/members`),
    ).toBe(true);

    const error = await failure(compute.claim!(String(member.id), 'inst_1', ctx()));
    expect(error.code).toBe('INVALID_STATE');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'autoscalePool' });
    expect(tagWrites(emu)).toEqual([]);
    // Another droplet is free to claim.
    await compute.claim!(String(free.id), 'inst_1', ctx());
  });

  it('pool membership is looked up once a minute for claims, and anew for each discover', async () => {
    const emu = emulator();
    const clock = manualClock(1_000_000);
    const client = doClient({
      fetch: emu.fetch,
      endpoint,
      token: async () => 'do-token',
      budget: new RateBudget({ perMinute: 250, perHour: 5000, clock }),
      clock,
      log: noopLog,
    });
    const compute = new DoCompute(
      doAccount as DoConfig,
      { clock, secrets, log: noopLog, account: platformAccount },
      { deployment: 'default', inCallWaitMs: 0 },
      client,
    );
    const [a, b, c, d] = [1, 2, 3, 4].map(() => seedDroplet(emu.state, { tags: [] }));
    await compute.claim!(String(a!.id), 'inst_1', ctx());
    await compute.claim!(String(b!.id), 'inst_2', ctx());
    expect(autoscaleLists(emu)).toHaveLength(1);

    // A pool takes a droplet; a claim within the minute still goes by the membership it holds.
    seedAutoscalePool(emu.state, { name: 'web', members: [c!.id, d!.id] });
    clock.advance(59_000);
    await compute.claim!(String(c!.id), 'inst_3', ctx());
    expect(autoscaleLists(emu)).toHaveLength(1);

    // After the minute it looks again.
    clock.advance(2_000);
    const error = await failure(compute.claim!(String(d!.id), 'inst_4', ctx()));
    expect(error.details?.reason).toBe('autoscalePool');
    expect(autoscaleLists(emu)).toHaveLength(2);

    // A discover always looks, and what it finds is what the next claim sees.
    await discovered(compute);
    expect(autoscaleLists(emu)).toHaveLength(3);
    await failure(compute.claim!(String(d!.id), 'inst_4', ctx()));
    expect(autoscaleLists(emu)).toHaveLength(3);
  });

  it("release removes only this instance's tags", async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: ['better-compute-tenant:acme'] });
    const id = String(d.id);
    await compute.claim!(id, 'inst_1', ctx(), { managed: true });
    const before = emu.requests.length;

    // Another instance's release changes nothing, and neither does a droplet that is gone.
    await compute.release!(id, 'inst_2', ctx());
    await compute.release!('999', 'inst_1', ctx());
    await compute.release!('not-an-id', 'inst_1', ctx());
    expect(emu.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(d.tags).toContain(instanceTag('inst_1'));

    await compute.release!(id, 'inst_1', ctx());
    // Nothing of this deployment claims it any more, so the deployment tag goes too.
    expect(d.tags).toEqual(['better-compute-tenant:acme']);
    // The managed tag goes first: a half-done release is still a claim, never a deletable
    // droplet. The deployment tag goes last, once no instance tag is left.
    expect(unassigned(emu)).toEqual([
      `/v2/tags/${managed}/resources`,
      `/v2/tags/${instanceTag('inst_1')}/resources`,
      `/v2/tags/${deploymentTag('default')}/resources`,
    ]);

    // Released twice is released once.
    await compute.release!(id, 'inst_1', ctx());
    expect(unassigned(emu)).toHaveLength(3);
    // Released, it can be claimed by someone else.
    await compute.claim!(id, 'inst_2', ctx());
    expect(d.tags).toContain(instanceTag('inst_2'));
  });

  it('release keeps the managed tag while another instance tag is on the droplet', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, {
      tags: [managed, deploymentTag('default'), instanceTag('inst_1'), instanceTag('other')],
    });
    await compute.release!(String(d.id), 'inst_1', ctx());
    // The deployment tag stays too: the other instance tag may be this deployment's.
    expect(d.tags).toEqual([managed, deploymentTag('default'), instanceTag('other')]);
  });

  it('a release that failed before the deployment tag finishes on a retry', async () => {
    const emu = emulator();
    const compute = await build(emu);
    const d = seedDroplet(emu.state, { tags: [] });
    const id = String(d.id);
    await compute.claim!(id, 'inst_1', ctx(), { managed: true });
    const serverError = errorFixtures.find((e) => e.name === 'server-error')!;
    emu.failNext(
      { method: 'DELETE', path: /^\/tags\/better-compute-deployment[^/]*\/resources$/ },
      serverError.status,
      serverError.body,
    );
    expect((await failure(compute.release!(id, 'inst_1', ctx()))).code).toBe('UNAVAILABLE');
    expect(d.tags).toEqual([deploymentTag('default')]);
    // No instance tag and no managed tag: the retry takes the deployment tag off.
    await compute.release!(id, 'inst_1', ctx());
    expect(d.tags).toEqual([]);

    // A managed droplet with no instance tag keeps its deployment tag: this release removed
    // nothing, and without the deployment tag the managed one could never be deleted.
    const orphan = seedDroplet(emu.state, { tags: [managed, deploymentTag('default')] });
    await compute.release!(String(orphan.id), 'inst_1', ctx());
    expect(orphan.tags).toEqual([managed, deploymentTag('default')]);
  });

  it("released by one deployment, a droplet is never that deployment's again", async () => {
    const emu = emulator();
    const a = await build(emu, doAccount, { deployment: 'a' });
    const b = await build(emu, doAccount, { deployment: 'b' });
    const d = seedDroplet(emu.state, { tags: [] });
    const id = String(d.id);
    await a.claim!(id, 'inst_a', ctx());
    await a.release!(id, 'inst_a', ctx());
    expect(d.tags).toEqual([]);
    await b.claim!(id, 'inst_b', ctx(), { managed: true });
    expect([...d.tags].sort()).toEqual([deploymentTag('b'), instanceTag('inst_b'), managed].sort());
    // Deployment a can neither power nor delete what b claimed.
    expect((await failure(a.power(id, 'off', ctx()))).details?.reason).toBe('notInstance');
    expect((await failure(a.delete(id, ctx()))).details?.reason).toBe('notManaged');
  });

  it("a managed claim refuses a droplet that carries another deployment's tag", async () => {
    const emu = emulator();
    const compute = await build(emu);
    // A deployment tag another control plane left (a claim it lost, or a release from before).
    const d = seedDroplet(emu.state, { tags: [deploymentTag('other')] });
    const id = String(d.id);
    const error = await failure(compute.claim!(id, 'inst_1', ctx(), { managed: true }));
    expect(error.code).toBe('INVALID_STATE');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'otherDeployment' });
    // Refused before any write.
    expect(tagWrites(emu)).toEqual([]);
    expect(d.tags).toEqual([deploymentTag('other')]);

    // A tag that appears between the claim's writes and the managed write is refused as well:
    // the plain claim stays and the managed tag is never written.
    const e = seedDroplet(emu.state, { tags: [] });
    emu.beforeAction('POST /tags/*/resources', () => {
      if (!(e.tags as string[]).includes(deploymentTag('other')))
        (e.tags as string[]).push(deploymentTag('other'));
    });
    const raced = await failure(compute.claim!(String(e.id), 'inst_2', ctx(), { managed: true }));
    expect(raced.details).toMatchObject({ reason: 'otherDeployment' });
    expect(e.tags).not.toContain(managed);
    expect(e.tags).toContain(instanceTag('inst_2'));

    // A plain claim is not refused: it hands no deletion over.
    const f = seedDroplet(emu.state, { tags: [deploymentTag('other')] });
    expect((await compute.claim!(String(f.id), 'inst_3', ctx())).claimedBy).toBe('inst_3');
  });
});

describe('definition', () => {
  beforeEach(freshBudgets);

  const emulator = () => new DoEmulator({ now: () => Date.parse('2026-10-18T10:00:00Z') });
  const reads = (emu: DoEmulator) => emu.requests.map((r) => `${r.method} ${r.url.pathname}`);
  const probeContext = {
    clock: manualClock(1_000_000),
    secrets,
    log: noopLog,
    account: platformAccount,
  };
  const forbidden = (emu: DoEmulator, path: RegExp) =>
    emu.failNext({ method: 'GET', path }, 403, emu.error('forbidden').body as object);

  it('passes every case of the ProviderImpl contract', async () => {
    const report = await runConformance(providerConformanceCases(), () => {
      const emu = emulator();
      // A create needs an SSH key: the account's default one.
      const key = seedSshKey(emu.state, 'ops', testKey);
      const hand = seedDroplet(emu.state, { name: 'legacy', tags: [] });
      return {
        provider: digitaloceanProvider({ fetch: emu.fetch }),
        config: { ...doAccount, sshKeyFingerprint: key.fingerprint },
        attachable: String(hand.id),
        offerId: 'nyc3/s-1vcpu-1gb',
        image: 'ubuntu-24-04-x64',
        context: { secrets, account: platformAccount },
      };
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(report.passed).toHaveLength(providerConformanceCases().length);
  });

  it('is a well-formed definition with the documented capabilities', async () => {
    expect(digitalocean).toMatchObject({
      id: 'digitalocean',
      version: '0.1.0',
      provides: ['vps'],
      extension: 'provider',
    });
    expect(digitalocean.capabilities).toEqual([
      'power',
      'reinstall',
      'list',
      'discover',
      'claim',
      'networks',
    ]);
    const parsed = await digitalocean.config['~standard'].validate(doAccount);
    expect(parsed).toMatchObject({
      value: { monitoring: true, ipv6: false, allowSpot: false, previews: false },
    });
    const none = await digitalocean.config['~standard'].validate({ ...doAccount, regions: [] });
    expect('issues' in none && none.issues?.length).toBeTruthy();
  });

  it('building a client makes no request', async () => {
    const emu = emulator();
    const resolve = vi.fn(secrets.resolve);
    const impl = await digitaloceanProvider({ fetch: emu.fetch }).create(doAccount as DoConfig, {
      ...probeContext,
      secrets: { resolve },
    });
    expect(emu.requests).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
    // The first request resolves the token, once; later ones reuse it.
    await impl.get('123', ctx());
    await impl.get('124', ctx());
    expect(emu.requests.length).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('secret://do/t');
  });

  it('an inline token is refused; a SecretRef resolves on first use', async () => {
    // The manifest accepts only a secret reference, so a raw token never reaches `create`.
    for (const token of ['dop_v1_abc', '']) {
      const parsed = await digitalocean.config['~standard'].validate({ ...doAccount, token });
      expect('issues' in parsed && parsed.issues?.length, JSON.stringify(token)).toBeTruthy();
    }
    const ok = await digitalocean.config['~standard'].validate({
      ...doAccount,
      token: 'env://DO_TOKEN',
    });
    expect('issues' in ok && ok.issues).toBeFalsy();

    // The reference resolves on the first request, and its value is the bearer.
    const emu = emulator();
    const resolve = vi.fn(async () => 'do-token');
    const impl = await digitaloceanProvider({ fetch: emu.fetch }).create(doAccount as DoConfig, {
      ...probeContext,
      secrets: { resolve },
    });
    expect(resolve).not.toHaveBeenCalled();
    await impl.listOffers({});
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(emu.requests[0]!.headers.authorization).toBe('Bearer do-token');
  });

  it('probeAccount reports the account and a fully scoped token', async () => {
    const emu = emulator();
    emu.account.droplet_limit = 40;
    const report = await probeAccount(doAccount as DoConfig, probeContext, { fetch: emu.fetch });
    expect(report).toEqual({
      account: { uuid: emu.account.uuid, status: 'active', dropletLimit: 40 },
      families: { compute: 'ok', networks: 'ok', keys: 'ok', tags: 'ok' },
      missing: [],
    });
    // Single, read-only requests: one page of each, nothing that changes anything.
    expect(reads(emu).sort()).toEqual(
      [
        'GET /v2/account',
        'GET /v2/account/keys',
        'GET /v2/droplets',
        'GET /v2/firewalls',
        'GET /v2/regions',
        'GET /v2/sizes',
        'GET /v2/tags',
        'GET /v2/vpcs',
      ].sort(),
    );
    for (const r of emu.requests.filter((r) => r.url.pathname !== '/v2/account'))
      expect(r.url.searchParams.get('per_page')).toBe('1');
  });

  it('probeAccount reports denied families from 403s and lists the missing scopes', async () => {
    const emu = emulator();
    forbidden(emu, /^\/firewalls$/);
    forbidden(emu, /^\/sizes$/);
    forbidden(emu, /^\/tags$/);
    const report = await probeAccount(doAccount as DoConfig, probeContext, { fetch: emu.fetch });
    expect(report.families).toEqual({
      compute: 'denied',
      networks: 'denied',
      keys: 'ok',
      tags: 'denied',
    });
    expect(report.missing).toEqual(['sizes:read', 'firewall:read', 'tag:read']);
    expect(report.account.status).toBe('active');
  });

  it('probeAccount fails on a token the account refuses, and on other errors', async () => {
    const refused = emulator();
    refused.validTokens.clear();
    const bad = await failure(
      probeAccount(doAccount as DoConfig, probeContext, { fetch: refused.fetch }),
    );
    expect(bad.code).toBe('INVALID_CONFIG');
    expect(bad.details).toMatchObject({ provider: 'digitalocean', status: 401 });

    // Without account:read nothing else can be told.
    const scoped = emulator();
    forbidden(scoped, /^\/account$/);
    const denied = await failure(
      probeAccount(doAccount as DoConfig, probeContext, { fetch: scoped.fetch }),
    );
    expect(denied.code).toBe('ACCESS_DENIED');

    // Anything but a 403 on a family's probe is not a verdict about the scope.
    const broken = emulator();
    broken.failNext({ method: 'GET', path: /^\/vpcs$/ }, 500, broken.error('server-error').body);
    const unavailable = await failure(
      probeAccount(doAccount as DoConfig, probeContext, { fetch: broken.fetch }),
    );
    expect(unavailable.details).toMatchObject({ provider: 'digitalocean', status: 500 });
  });
});

describe('definition: scoped account bodies and timeouts', () => {
  beforeEach(freshBudgets);

  const emulator = () => new DoEmulator({ now: () => Date.parse('2026-10-18T10:00:00Z') });
  const probeContext = {
    clock: manualClock(1_000_000),
    secrets,
    log: noopLog,
    account: platformAccount,
  };

  it('probeAccount reports compute denied when droplet:read is missing and the body has no droplet_limit', async () => {
    const emu = emulator();
    delete emu.account.droplet_limit;
    emu.failNext({ method: 'GET', path: /^\/droplets$/ }, 403, emu.error('forbidden').body);
    const report = await probeAccount(doAccount as DoConfig, probeContext, { fetch: emu.fetch });
    expect(report.families).toEqual({
      compute: 'denied',
      networks: 'ok',
      keys: 'ok',
      tags: 'ok',
    });
    expect(report.missing).toEqual(['droplet:read']);
    expect(report.account.dropletLimit).toBeUndefined();
    expect(report.account).toEqual({ uuid: emu.account.uuid, status: 'active' });
  });

  it('probeAccount refuses an account body without a uuid', async () => {
    const emu = emulator();
    delete emu.account.uuid;
    const error = await failure(
      probeAccount(doAccount as DoConfig, probeContext, { fetch: emu.fetch }),
    );
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'badBody' });
  });

  it('probeAccount turns its own timeout into UNAVAILABLE', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A server that never answers: the request ends only when the probe aborts it.
      const hang = (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
        );
      const pending = failure(
        probeAccount(doAccount as DoConfig, probeContext, { fetch: hang as typeof fetch }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;
      expect(error.code).toBe('UNAVAILABLE');
      expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
