import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import {
  createAuthzProjection,
  createRefreshHandler,
  remoteRefresher,
  signRefresh,
  type ChangeCursor,
  type ProjectionChange,
  type ProjectionRow,
  type ProjectionSource,
} from '@better-compute/iam';
import { pglite } from '@better-compute/postgres/pglite';

// Admission refresh (PLAN.md §12.4): an admission decides on the row its transaction 1 committed. In-process, a
// fresh read must not be overwritten by a tail page read before it; in remote mode, compute's port posts a signed
// refresh the IAM host answers once its replica replayed compute's commit.

const secret = 'refresh-test-secret-of-at-least-32-chars';
const row = (gpus: number): ProjectionRow => ({
  type: 'reservation',
  id: 'rsv_1',
  tenantId: 'ten_a',
  attributes: { gpuCount: gpus },
});

/** A source over one mutable row; `hold()` makes the next `changes()` wait, reading the row when it is called. */
function fakeSource(initial: ProjectionRow) {
  let current: ProjectionRow | undefined = initial;
  let seq = 0;
  let gets = 0;
  let gate: { release: () => void } | undefined;
  const pending: Promise<void>[] = [];
  const source: ProjectionSource = {
    load: async () => ({ rows: current ? [current] : [], cursor: { txid: '0', seq: '0' } }),
    async changes(cursor: ChangeCursor) {
      // The page's snapshot is taken now, before it waits.
      const snapshot = current;
      const changed: ProjectionChange[] =
        Number(cursor.seq) < seq ? [{ type: 'reservation', id: 'rsv_1', tenantId: 'ten_a' }] : [];
      if (gate) {
        const wait = new Promise<void>((resolve) => (gate = { release: resolve }));
        pending.push(wait);
        await wait;
      }
      return {
        changed,
        rows: snapshot && changed.length ? [snapshot] : [],
        cursor: { txid: '1', seq: String(seq) },
      };
    },
    async get() {
      gets++;
      return current;
    },
  };
  return {
    source,
    set(next: ProjectionRow | undefined) {
      current = next;
      seq++;
    },
    hold() {
      gate = { release: () => {} };
    },
    release() {
      const open = gate;
      gate = undefined;
      open?.release();
    },
    get gets() {
      return gets;
    },
  };
}

describe('projection refresh against a concurrent tail page', () => {
  it('a page read before a fresh read re-reads the row instead of putting its older copy back', async () => {
    const fake = fakeSource(row(4));
    const projection = createAuthzProjection({ source: fake.source });
    await projection.load();

    // A change is committed (8 GPUs) and a tail page starts reading it...
    fake.set(row(8));
    fake.hold();
    const syncing = projection.sync();
    await Promise.resolve();
    // ...then an admission commits 12 and refreshes before that page is applied.
    fake.set(row(12));
    await projection.refresh('reservation', 'rsv_1', 'ten_a');
    expect(projection.get('reservation', 'rsv_1', 'ten_a')?.attributes.gpuCount).toBe(12);
    const before = fake.gets;
    fake.release();
    await syncing;
    // The page carried 8; the row was read again rather than regressing.
    expect(projection.get('reservation', 'rsv_1', 'ten_a')?.attributes.gpuCount).toBe(12);
    expect(fake.gets).toBe(before + 1);

    // A page that starts after the fresh read applies normally.
    fake.set(row(16));
    await projection.sync();
    expect(projection.get('reservation', 'rsv_1', 'ten_a')?.attributes.gpuCount).toBe(16);
    expect(fake.gets).toBe(before + 1);

    // A delete seen by a fresh read is not undone by an older page either.
    fake.set(row(20));
    fake.hold();
    const again = projection.sync();
    await Promise.resolve();
    fake.set(undefined);
    await projection.refresh('reservation', 'rsv_1', 'ten_a');
    fake.release();
    await again;
    expect(projection.get('reservation', 'rsv_1', 'ten_a')).toBeUndefined();
  });

  it('a failed fresh read drops the row (fail closed)', async () => {
    const fake = fakeSource(row(4));
    const errors: unknown[] = [];
    const projection = createAuthzProjection({
      source: {
        ...fake.source,
        get: () => Promise.reject(new Error('replica away')),
      },
      onError: (error) => errors.push(error),
    });
    await projection.load();
    await projection.refresh('reservation', 'rsv_1', 'ten_a');
    expect(projection.get('reservation', 'rsv_1', 'ten_a')).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('remote admission refresh', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite();
  });
  afterAll(async () => {
    await db.close();
  });

  async function host(options: { sql?: Pick<SqlExecutor, 'query'>; timeoutMs?: number } = {}) {
    const fake = fakeSource(row(4));
    const projection = createAuthzProjection({ source: fake.source });
    await projection.load();
    const handler = createRefreshHandler({ projection, secret, pollMs: 1, ...options });
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return handler(request);
    };
    return { fake, projection, handler, fetch, requests };
  }

  it('re-reads the committed row on the IAM host before the decision', async () => {
    const h = await host({ sql: db });
    const refresh = remoteRefresher({
      url: 'https://iam.test/compute/refresh',
      secret,
      sql: db,
      fetch: h.fetch,
    });
    h.fake.set(row(9));
    await refresh('ten_a', { type: 'compute-reservation', id: 'rsv_1' });
    expect(h.projection.get('reservation', 'rsv_1', 'ten_a')?.attributes.gpuCount).toBe(9);
    // The body names the kind (unprefixed) and compute's WAL position after the commit.
    const sent = JSON.parse(await h.requests[0]!.text()) as Record<string, string>;
    expect(sent).toMatchObject({
      purpose: 'refresh',
      tenantId: 'ten_a',
      type: 'reservation',
      id: 'rsv_1',
    });
    expect(sent.lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);

    // The IAM host's own types are not compute's to refresh.
    await refresh('ten_a', { type: 'iam-project', id: 'p1' });
    expect(h.requests).toHaveLength(1);
  });

  it('waits for the replica to replay the commit, and fails the admission when it does not', async () => {
    let polls = 0;
    const lagging = (catchUpAfter: number) => ({
      query: async () => ({ rows: [{ caught: ++polls > catchUpAfter }], rowCount: 1 }),
    });
    const caughtUp = await host({ sql: lagging(3) as never });
    const refresh = remoteRefresher({
      url: 'https://iam.test/compute/refresh',
      secret,
      sql: db,
      fetch: caughtUp.fetch,
    });
    await refresh('ten_a', { type: 'compute-reservation', id: 'rsv_1' });
    expect(polls).toBe(4);

    polls = 0;
    const stuck = await host({ sql: lagging(Infinity) as never, timeoutMs: 20 });
    await expect(
      remoteRefresher({ url: 'https://iam.test/r', secret, sql: db, fetch: stuck.fetch })('ten_a', {
        type: 'compute-reservation',
        id: 'rsv_1',
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('504') });
  });

  it('refuses bad signatures, stale timestamps and malformed bodies; fails closed when unreachable', async () => {
    const h = await host();
    const post = (body: string, signature: string) =>
      h.handler(
        new Request('https://iam.test/r', {
          method: 'POST',
          body,
          headers: { 'x-better-compute-signature': signature },
        }),
      );
    const good = signRefresh(
      secret,
      { purpose: 'refresh', tenantId: 'ten_a', type: 'reservation', id: 'rsv_1' },
      Date.now(),
    );
    expect((await post(good.body, good.signature)).status).toBe(200);
    const forged = signRefresh(
      'another-secret-that-is-at-least-32-characters',
      { purpose: 'refresh', tenantId: 'ten_a', type: 'reservation', id: 'rsv_1' },
      Date.now(),
    );
    expect((await post(forged.body, forged.signature)).status).toBe(401);
    const old = signRefresh(
      secret,
      { purpose: 'refresh', tenantId: 'ten_a', type: 'reservation', id: 'rsv_1' },
      Date.now() - 600_000,
    );
    expect((await post(old.body, old.signature)).status).toBe(401);
    // An inbox batch signed with the same secret is not a refresh.
    const inbox = signRefresh(secret, { events: [] } as never, Date.now());
    expect((await post(inbox.body, inbox.signature)).status).toBe(400);
    const badLsn = signRefresh(
      secret,
      { purpose: 'refresh', tenantId: 'ten_a', type: 'reservation', id: 'rsv_1', lsn: "0/1'; --" },
      Date.now(),
    );
    expect((await post(badLsn.body, badLsn.signature)).status).toBe(400);
    expect((await h.handler(new Request('https://iam.test/r'))).status).toBe(405);

    h.projection.stop();
    expect((await post(good.body, good.signature)).status).toBe(503);

    await expect(
      remoteRefresher({
        url: 'https://iam.test/r',
        secret,
        fetch: () => Promise.reject(new TypeError('fetch failed')),
      })('ten_a', { type: 'compute-reservation', id: 'rsv_1' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(() => createRefreshHandler({ projection: h.projection, secret: 'short' })).toThrow(/32/);
  });
});
