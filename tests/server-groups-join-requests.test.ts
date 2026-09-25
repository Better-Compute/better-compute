import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JoinRequestInfo } from '../packages/server/src/api/join-requests.js';
import { expireJoinRequests } from '@better-compute/postgres';
import { ACME } from './support/server.js';
import { OUTSIDER, USER, type Harness } from './support/server-api.js';
import { consumeApproved, seedJoinRequest, sha256, v02Harness } from './support/server-v02.js';

// `joinRequests` (PLAN.md §3.3 step 4, §9.2): the approval queue of deferred joins, decided on
// `compute-pool/{poolId}`. Approve and reject are idempotent; an approval admits exactly one join.

let h: Harness;
let site: string;
let pool: string;
let otherPool: string;
let n = 0;

beforeAll(async () => {
  h = await v02Harness();
  site = await h.seed.site(ACME);
  pool = await h.seed.pool(ACME, site);
  otherPool = await h.seed.pool(ACME, await h.seed.site(ACME));
  h.iam.allow({ token: USER });
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const request = (extra: object = {}) =>
  seedJoinRequest(h.store, { tenantId: ACME, siteId: site, hardwareKey: `hk-${++n}`, ...extra });
const call = <T = JoinRequestInfo>(method: string, input: object) =>
  h.call<T>(`joinRequests/${method}`, USER, { tenantId: ACME, poolId: pool, ...input });

describe('joinRequests.list', () => {
  it("lists the pool's requests and its site's unassigned ones, pending by default", async () => {
    const mine = await request({ poolId: pool });
    const unassigned = await request();
    const elsewhere = await seedJoinRequest(h.store, {
      tenantId: ACME,
      siteId: site,
      poolId: otherPool,
      hardwareKey: 'hk-other',
    });
    const listed = await call<{ items: JoinRequestInfo[] }>('list', {});
    const ids = listed.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([mine, unassigned]));
    expect(ids).not.toContain(elsewhere);
    const item = listed.items.find((entry) => entry.id === unassigned)!;
    expect(item).toMatchObject({
      tenantId: ACME,
      siteId: site,
      attestor: 'discovery',
      state: 'pending',
      ip: '10.0.0.9',
      vouchedBy: 'node_s1te',
      bootLeaseEpoch: 3,
      hardwareKey: Buffer.from(sha256(`hk-${n}`)).toString('hex'),
    });
    expect(item.poolId).toBeUndefined();
    expect(h.iam.calls.map((c) => c.decision?.resource).filter(Boolean)).toEqual([{ type: 'compute-pool', id: pool }]);
  });

  it("refuses another tenant's pool and callers without access", async () => {
    expect((await h.failure('joinRequests/list', OUTSIDER, { tenantId: ACME, poolId: pool })).code).toBe('ACCESS_DENIED');
    expect((await h.failure('joinRequests/list', USER, { tenantId: ACME, poolId: 'pool_nope' })).code).toBe('NOT_FOUND');
  });
});

describe('joinRequests.approve', () => {
  it('approves once, assigns the pool, and admits exactly one join with the recorded CSR', async () => {
    const id = await request({ csr: 'csr-a' });
    const approved = await call('approve', { requestId: id, reason: 'rack 7 replacement' });
    expect(approved).toMatchObject({
      id,
      state: 'approved',
      poolId: pool,
      decidedBy: 'id-user',
      reason: 'rack 7 replacement',
      expiresAt: Date.UTC(2026, 0, 1, 1),
    });
    expect(h.ports.events.published.map((event) => event.type)).toEqual(['security.join-request.approved']);
    // Idempotent: a second approval answers with the first and publishes nothing.
    h.reset();
    expect(await call('approve', { requestId: id })).toEqual(approved);
    expect(h.ports.events.published).toEqual([]);

    // The retry with another CSR is not admitted; the right one is, once.
    expect(await consumeApproved(h.store, { tenantId: ACME, hardwareKey: `hk-${n}`, csr: 'csr-b', nodeId: 'node_x' })).toBeUndefined();
    expect(await consumeApproved(h.store, { tenantId: ACME, hardwareKey: `hk-${n}`, csr: 'csr-a', nodeId: 'node_x' })).toBe(id);
    expect(await consumeApproved(h.store, { tenantId: ACME, hardwareKey: `hk-${n}`, csr: 'csr-a', nodeId: 'node_x' })).toBeUndefined();
    // Consumed is final.
    const error = await h.failure('joinRequests/approve', USER, { tenantId: ACME, poolId: pool, requestId: id });
    expect(error.code).toBe('INVALID_STATE');
    expect(error.details).toMatchObject({ state: 'consumed' });
  });

  it('matches by (site, mac) when the attestor had no hardware key', async () => {
    const id = await seedJoinRequest(h.store, { tenantId: ACME, siteId: site, mac: 'aa:bb:cc:00:00:01', csr: 'csr-m' });
    await call('approve', { requestId: id });
    expect(await consumeApproved(h.store, { tenantId: ACME, siteId: site, mac: 'aa:bb:cc:00:00:01', csr: 'csr-m', nodeId: 'node_y' })).toBe(id);
  });

  it('keeps one pending request per machine', async () => {
    await request({ hardwareKey: 'dup' });
    await expect(request({ hardwareKey: 'dup' })).rejects.toThrow();
    await seedJoinRequest(h.store, { tenantId: ACME, siteId: site, mac: 'aa:bb:cc:00:00:02' });
    await expect(seedJoinRequest(h.store, { tenantId: ACME, siteId: site, mac: 'aa:bb:cc:00:00:02' })).rejects.toThrow();
  });

  it('refuses expired requests, and an approval not used in time expires', async () => {
    const stale = await request({ ttlSeconds: 60 });
    const approvedThenIdle = await request({ csr: 'late' });
    await call('approve', { requestId: approvedThenIdle, ttlSeconds: 120 });
    // Time passes: both expiries lie behind the database clock.
    await h.store.query(`UPDATE join_requests SET expires_at = compute_now() - interval '1 second' WHERE id = $1`, [stale]);
    expect((await h.failure('joinRequests/approve', USER, { tenantId: ACME, poolId: pool, requestId: stale })).code).toBe('INVALID_STATE');
    await h.store.query(`UPDATE join_requests SET expires_at = compute_now() - interval '1 second' WHERE id = $1`, [approvedThenIdle]);
    expect(await consumeApproved(h.store, { tenantId: ACME, hardwareKey: `hk-${n}`, csr: 'late', nodeId: 'node_z' })).toBeUndefined();
    expect(await expireJoinRequests(h.store)).toBeGreaterThanOrEqual(2);
    const { rows } = await h.store.query<{ state: string }>('SELECT state FROM join_requests WHERE id = ANY($1) ORDER BY id', [[stale, approvedThenIdle]]);
    expect(rows.map((row) => row.state)).toEqual(['expired', 'expired']);
  });

  it("does not decide another pool's request", async () => {
    const id = await seedJoinRequest(h.store, { tenantId: ACME, siteId: site, poolId: otherPool, hardwareKey: 'elsewhere' });
    expect((await h.failure('joinRequests/approve', USER, { tenantId: ACME, poolId: pool, requestId: id })).code).toBe('NOT_FOUND');
  });
});

describe('joinRequests.reject', () => {
  it('rejects idempotently, withdraws an unused approval, and never un-rejects', async () => {
    const id = await request();
    const rejected = await call('reject', { requestId: id, reason: 'unknown asset' });
    expect(rejected).toMatchObject({ state: 'rejected', reason: 'unknown asset', decidedBy: 'id-user' });
    h.reset();
    expect(await call('reject', { requestId: id })).toEqual(rejected);
    expect(h.ports.events.published).toEqual([]);
    expect((await h.failure('joinRequests/approve', USER, { tenantId: ACME, poolId: pool, requestId: id })).code).toBe('INVALID_STATE');

    const approved = await request({ csr: 'withdrawn' });
    await call('approve', { requestId: approved });
    expect(await call('reject', { requestId: approved })).toMatchObject({ state: 'rejected' });
    expect(await consumeApproved(h.store, { tenantId: ACME, hardwareKey: `hk-${n}`, csr: 'withdrawn', nodeId: 'node_w' })).toBeUndefined();
  });

  it('validates exactly', async () => {
    for (const input of [
      { requestId: 'jt_0123456789abcdefghjkmnpqrs' },
      { requestId: 'jreq_0123456789abcdefghjkmnpqrs', ttlSeconds: 5 },
      { requestId: 'jreq_0123456789abcdefghjkmnpqrs', color: 'red' },
    ])
      expect((await h.failure('joinRequests/approve', USER, { tenantId: ACME, poolId: pool, ...input })).code).toBe('INVALID_INPUT');
  });
});
