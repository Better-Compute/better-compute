import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Caller, Decision } from '@better-compute/core';
import { betterCompute } from '@better-compute/server';
import { createCaches, credentialKey } from '../packages/server/src/caches.js';
import { fakeIam } from './support/fake-iam.js';
import { ACME, acme, options } from './support/server.js';
import { OUTSIDER, USER, serverHarness, type Harness } from './support/server-api.js';

// The IAM caches (PLAN.md §3.4 step 2, §9.2, P7): authentication 30 s by sha256 of the credential,
// allowed read decisions 10 s by (session, tenant, action, type, id), mutations never; both
// bounded, and dropped by the IAM bridge on inbox events.

const caller = (identityId: string, sessionId = `ses-${identityId}`): Caller => ({
  identityId,
  identityKind: 'user',
  tenantId: ACME,
  sessionId,
  sessionKind: 'user',
  mfa: false,
});
const decision = (id: string, action = 'compute:nodes:read'): Decision => ({
  tenantId: ACME,
  action,
  resource: { type: 'compute-node', id },
});

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

/** A load function that counts its calls. */
function counted<T>(value: () => T | Promise<T>) {
  const load = async () => {
    load.calls += 1;
    return value();
  };
  load.calls = 0;
  return load;
}

describe('createCaches(): authentication', () => {
  it('reuses an authentication for 30 s, keyed by the credential material only', async () => {
    const time = clock();
    const caches = createCaches({ now: time.now });
    const load = counted(() => caller('id-a'));
    expect(await caches.authenticate({ token: 'tok-a' }, load)).toEqual(caller('id-a'));
    await caches.authenticate({ token: 'tok-a' }, load);
    expect(load.calls).toBe(1);
    // Headers that do not authenticate do not matter; the bearer header is other material.
    const headers = { authorization: 'Bearer tok-a', 'x-request-id': 'r-1' };
    await caches.authenticate({ headers }, load);
    await caches.authenticate({ headers: { ...headers, 'x-request-id': 'r-2' } }, load);
    expect(load.calls).toBe(2);
    time.advance(29_999);
    await caches.authenticate({ token: 'tok-a' }, load);
    expect(load.calls).toBe(2);
    time.advance(1);
    await caches.authenticate({ token: 'tok-a' }, load);
    expect(load.calls).toBe(3);
  });

  it('hands out copies, shares one call among concurrent misses and never caches a failure', async () => {
    const caches = createCaches({ now: clock().now });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = counted(async () => {
      await gate;
      return caller('id-b');
    });
    const pending = [1, 2, 3].map(() => caches.authenticate({ token: 'tok-b' }, slow));
    release();
    const callers = await Promise.all(pending);
    expect(slow.calls).toBe(1);
    callers[0]!.tenantId = 'mutated';
    expect((await caches.authenticate({ token: 'tok-b' }, slow)).tenantId).toBe(ACME);

    const failing = counted((): Caller => {
      throw new Error('UNAUTHENTICATED');
    });
    await expect(caches.authenticate({ token: 'tok-c' }, failing)).rejects.toThrow();
    await expect(caches.authenticate({ token: 'tok-c' }, failing)).rejects.toThrow();
    expect(failing.calls).toBe(2);
  });

  it('does not keep an answer that was in flight when its identity was dropped', async () => {
    const caches = createCaches({ now: clock().now });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = counted(async () => {
      await gate;
      return caller('id-d');
    });
    const pending = caches.authenticate({ token: 'tok-d' }, slow);
    caches.dropIdentity('id-d');
    release();
    await pending;
    await caches.authenticate({ token: 'tok-d' }, slow);
    expect(slow.calls).toBe(2);
  });

  it('keys nothing without credential material', () => {
    expect(credentialKey({})).toBeUndefined();
    expect(credentialKey({ headers: { 'x-request-id': 'r' } })).toBeUndefined();
    expect(credentialKey({ token: 't' })).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialKey({ token: 't' })).not.toBe(credentialKey({ token: 'u' }));
  });

  it('is bounded, least recently used first out', async () => {
    const caches = createCaches({ now: clock().now, maxEntries: 2 });
    const load = counted(() => caller('id-e'));
    await caches.authenticate({ token: 'one' }, load);
    await caches.authenticate({ token: 'two' }, load);
    await caches.authenticate({ token: 'one' }, load); // one is now the most recent
    await caches.authenticate({ token: 'three' }, load); // evicts two
    expect(caches.stats().authentications).toBe(2);
    expect(load.calls).toBe(3);
    await caches.authenticate({ token: 'one' }, load);
    expect(load.calls).toBe(3);
    await caches.authenticate({ token: 'two' }, load);
    expect(load.calls).toBe(4);
  });

  it('is off with a zero TTL', async () => {
    const caches = createCaches({ now: clock().now, authenticationTtlMs: 0, readDecisionTtlMs: 0 });
    const load = counted(() => caller('id-f'));
    await caches.authenticate({ token: 'x' }, load);
    await caches.authenticate({ token: 'x' }, load);
    const allow = counted(() => true);
    await caches.authorize(caller('id-f'), decision('n'), allow);
    await caches.authorize(caller('id-f'), decision('n'), allow);
    expect([load.calls, allow.calls]).toEqual([2, 2]);
  });
});

describe('createCaches(): read decisions', () => {
  it('keeps allows for 10 s per session and decision, and never keeps a denial', async () => {
    const time = clock();
    const caches = createCaches({ now: time.now });
    const allow = counted(() => true);
    expect(await caches.authorize(caller('id-a'), decision('n1'), allow)).toBe(true);
    expect(await caches.authorize(caller('id-a'), decision('n1'), allow)).toBe(true);
    expect(allow.calls).toBe(1);
    // Another session, resource, action or tenant is another decision.
    await caches.authorize(caller('id-a', 'ses-2'), decision('n1'), allow);
    await caches.authorize(caller('id-a'), decision('n2'), allow);
    await caches.authorize(caller('id-a'), decision('n1', 'compute:nodes:exec'), allow);
    await caches.authorize(caller('id-a'), { ...decision('n1'), tenantId: 'tenant-other' }, allow);
    expect(allow.calls).toBe(5);
    expect(caches.cachedDecision(caller('id-a'), decision('n1'))).toBe(true);
    time.advance(10_000);
    expect(caches.cachedDecision(caller('id-a'), decision('n1'))).toBeUndefined();

    const deny = counted(() => false);
    expect(await caches.authorize(caller('id-a'), decision('n3'), deny)).toBe(false);
    expect(await caches.authorize(caller('id-a'), decision('n3'), deny)).toBe(false);
    expect(deny.calls).toBe(2);
  });

  it('drops by identity, by session, all decisions, or everything', async () => {
    const caches = createCaches({ now: clock().now });
    const allow = counted(() => true);
    const fill = async () => {
      for (const who of [caller('id-a'), caller('id-b')]) {
        await caches.authenticate({ token: who.identityId }, async () => who);
        await caches.authorize(who, decision('n'), allow);
      }
    };
    await fill();
    expect(caches.stats()).toEqual({ authentications: 2, decisions: 2 });
    caches.dropIdentity('id-a');
    expect(caches.stats()).toEqual({ authentications: 1, decisions: 1 });
    expect(caches.cachedDecision(caller('id-b'), decision('n'))).toBe(true);
    caches.dropSession('ses-id-b');
    expect(caches.stats()).toEqual({ authentications: 0, decisions: 0 });
    await fill();
    caches.dropDecisions();
    expect(caches.stats()).toEqual({ authentications: 2, decisions: 0 });
    caches.clear();
    expect(caches.stats()).toEqual({ authentications: 0, decisions: 0 });
  });

  it('remembers per-item allows only when nothing was dropped meanwhile', () => {
    const caches = createCaches({ now: clock().now });
    const generation = caches.generation();
    caches.rememberAllowed(caller('id-a'), [decision('n1')], generation);
    expect(caches.cachedDecision(caller('id-a'), decision('n1'))).toBe(true);
    const stale = caches.generation();
    caches.dropDecisions();
    caches.rememberAllowed(caller('id-a'), [decision('n2')], stale);
    expect(caches.cachedDecision(caller('id-a'), decision('n2'))).toBeUndefined();
  });
});

describe('the envelope with its caches', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serverHarness({ plugins: [acme] });
    h.iam.allow({ token: USER, action: 'compute:acme:read' });
    h.iam.allow({ token: USER, action: 'compute:acme:poke' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => h.reset());

  const read = (widgetId: string, token = USER) =>
    h.call('plugins/acme/widgets/get', token, { tenantId: ACME, widgetId });
  const methods = () => h.iam.calls.map((call) => call.method);

  it('authenticates once per 30 s and decides an allowed read once per 10 s', async () => {
    await read('w-1');
    await read('w-1');
    expect(methods()).toEqual(['authenticate', 'authorize']);
    // Same scope (compute-tenant/acme): the second widget is the same decision.
    await read('w-2');
    expect(methods()).toEqual(['authenticate', 'authorize']);
    h.clock.advance(10_000);
    await read('w-1');
    expect(methods()).toEqual(['authenticate', 'authorize', 'authorize']);
    h.clock.advance(20_000);
    await read('w-1');
    expect(methods()).toEqual([
      'authenticate',
      'authorize',
      'authorize',
      'authenticate',
      'authorize',
    ]);
  });

  it('never caches a mutation', async () => {
    const poke = (widgetId: string) =>
      h.call('plugins/acme/widgets/poke', USER, { tenantId: ACME, widgetId });
    await poke('w-cache-1');
    await poke('w-cache-2');
    expect(methods()).toEqual(['authenticate', 'require', 'require']);
  });

  it('asks again after a denial, and after the bridge drops an identity', async () => {
    const token = 'token-acme-late-0123456789';
    h.iam.addCaller(token, { tenantId: ACME, identityId: 'id-late', sessionId: 'ses-late' });
    expect(
      (await h.failure('plugins/acme/widgets/get', token, { tenantId: ACME, widgetId: 'w' })).code,
    ).toBe('ACCESS_DENIED');
    h.iam.allow({ token, action: 'compute:acme:read' });
    await read('w', token);
    expect(methods()).toEqual(['authenticate', 'authorize', 'authorize']);
    h.operations.caches.dropIdentity('id-late');
    await read('w', token);
    expect(methods()).toEqual([
      'authenticate',
      'authorize',
      'authorize',
      'authenticate',
      'authorize',
    ]);
  });

  it('caches no refusal of the tenant pre-check beyond the authentication', async () => {
    await h.failure('plugins/acme/widgets/get', OUTSIDER, { tenantId: ACME, widgetId: 'w' });
    await h.failure('plugins/acme/widgets/get', OUTSIDER, { tenantId: ACME, widgetId: 'w' });
    expect(methods()).toEqual(['authenticate']);
  });

  it('is exposed as compute.caches for the IAM bridge', () => {
    const compute = betterCompute(
      options({ query() {}, transaction() {}, migrate() {} } as never, fakeIam()),
    );
    expect(Object.keys(compute.caches).sort()).toEqual([
      'clear',
      'dropDecisions',
      'dropIdentity',
      'dropSession',
      'stats',
    ]);
    expect(compute.caches.stats()).toEqual({ authentications: 0, decisions: 0 });
  });
});
