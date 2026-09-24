import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftId } from '@better-compute/core';
import { hashJoinSecret, parseJoinToken } from '@better-compute/pki';
import type { CreatedJoinToken, JoinTokenInfo } from '@better-compute/server';
import { ACME, ROOT } from './support/server.js';
import { ADMIN, OUTSIDER, USER, serverHarness, type Harness } from './support/server-api.js';

// `joinTokens` (PLAN.md §3.3 step 1, §9.2): `bcjt_<id>.<secret>` shown once, sha256(secret)
// stored, every method decided on `compute-pool/{poolId}`.

let h: Harness;
let pool: string;
let platformPool: string;
let agentless: string;
const minted: string[] = [];

beforeAll(async () => {
  h = await serverHarness({
    joinTokens: {
      // A test double of the minter: deterministic secrets in the bearer format.
      mint(id) {
        const secret = `s${String(minted.length).padStart(42, '0')}`;
        minted.push(secret);
        return {
          token: `bcjt_${id}.${secret}`,
          secretHash: new Uint8Array(createHash('sha256').update(secret).digest()),
        };
      },
    },
  });
  const site = await h.seed.site(ACME);
  pool = await h.seed.pool(ACME, site);
  agentless = await h.seed.pool(ACME, site, { agent: 'none' });
  const rootSite = await h.seed.site(ROOT);
  platformPool = await h.seed.pool(ROOT, rootSite);
  h.iam.allow({ token: USER });
  h.iam.allow({ token: ADMIN });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => h.reset());

const create = (input: object, token = USER) =>
  h.call<CreatedJoinToken>('joinTokens/create', token, {
    tenantId: ACME,
    poolId: pool,
    ttlSeconds: 3600,
    ...input,
  });

describe('joinTokens.create', () => {
  it('mints a token once, stores only the secret hash, and decides on the pool', async () => {
    const created = await create({
      idempotencyKey: 'rack-1',
      expect: { mac: 'AA:BB:CC:DD:EE:0F' },
    });
    const id = await draftId('jt', ACME, 'id-user', 'rack-1');
    const secret = minted.at(-1)!;
    expect(created).toEqual({
      id,
      tenantId: ACME,
      poolId: pool,
      siteId: expect.stringMatching(/^site_/),
      role: 'node',
      usesLeft: 1,
      expect: { mac: 'aa:bb:cc:dd:ee:0f' },
      allowReclaim: false,
      expiresAt: Date.UTC(2026, 0, 1, 1),
      token: `bcjt_${id}.${secret}`,
    });
    expect(h.iam.calls.map((call) => call.decision?.resource).filter(Boolean)).toEqual([
      { type: 'compute-pool', id: pool },
    ]);
    const { rows } = await h.store.query<{ secret_hash: Uint8Array }>(
      'SELECT secret_hash FROM join_tokens WHERE id = $1',
      [id],
    );
    expect(Buffer.from(rows[0]!.secret_hash).toString('hex')).toBe(
      createHash('sha256').update(secret).digest('hex'),
    );
    expect(h.ports.events.published).toEqual([
      {
        type: 'security.join-token.created',
        tenantId: ACME,
        subject: `pool/${pool}`,
        data: {
          tokenId: id,
          poolId: pool,
          usesLeft: 1,
          expiresAt: '2026-01-01T01:00:00.000Z',
          pinned: true,
        },
      },
    ]);
    // The secret appears nowhere but the answer.
    expect(JSON.stringify(h.ports.events.published)).not.toContain(secret);
  });

  it('replays the record without the secret, and refuses a reused key', async () => {
    const first = await create({ idempotencyKey: 'replay', maxUses: 3 });
    h.reset();
    const again = await create({ idempotencyKey: 'replay', maxUses: 3 });
    const { token, ...record } = first;
    expect(token).toBeDefined();
    expect(again).toEqual(record);
    expect(h.iam.count('require')).toBe(0);
    expect(
      (
        await h.failure('joinTokens/create', USER, {
          tenantId: ACME,
          poolId: pool,
          ttlSeconds: 60,
          allowReclaim: true,
          idempotencyKey: 'replay',
        })
      ).code,
    ).toBe('CONFLICT');
  });

  it('mints only for the pool’s owner tenant, and never for agentless pools', async () => {
    expect(
      (
        await h.failure('joinTokens/create', USER, {
          tenantId: ACME,
          poolId: platformPool,
          ttlSeconds: 600,
          idempotencyKey: 'not-mine',
        })
      ).code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await h.failure('joinTokens/create', USER, {
          tenantId: ACME,
          poolId: agentless,
          ttlSeconds: 600,
          idempotencyKey: 'agentless',
        })
      ).code,
    ).toBe('INVALID_STATE');
    // Root admins mint for platform pools in the root tenant.
    const platform = await h.call<CreatedJoinToken>('joinTokens/create', ADMIN, {
      tenantId: ROOT,
      poolId: platformPool,
      ttlSeconds: 600,
      idempotencyKey: 'platform',
    });
    expect(platform).toMatchObject({ tenantId: ROOT, poolId: platformPool });
    expect(
      (
        await h.failure('joinTokens/create', OUTSIDER, {
          tenantId: ACME,
          poolId: pool,
          ttlSeconds: 600,
          idempotencyKey: 'x',
        })
      ).code,
    ).toBe('ACCESS_DENIED');
  });

  it('validates exactly', async () => {
    const base = { tenantId: ACME, poolId: pool, ttlSeconds: 600, idempotencyKey: 'v' };
    for (const [input, message] of [
      [{ ...base, ttlSeconds: 86_401 }, /ttlSeconds: Must be at most 86400/],
      [{ ...base, ttlSeconds: undefined }, /ttlSeconds: Required/],
      [{ ...base, maxUses: 0 }, /maxUses: Must be at least 1/],
      [{ ...base, expect: {} }, /expect: name at least one identifier/],
      [{ ...base, expect: { mac: 'nope' } }, /expect.mac: Must match/],
      [{ ...base, expect: { serial: 'S1', color: 'red' } }, /expect.color: Unknown field color/],
      [{ ...base, role: 'site' }, /role: Unknown field role/],
    ] as const) {
      const error = await h.failure('joinTokens/create', USER, input);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(message);
    }
  });
});

describe('the default minter', () => {
  it('mints in @better-compute/pki’s format, so JoinService can verify the token', async () => {
    const plain = await serverHarness();
    try {
      const site = await plain.seed.site(ACME);
      const own = await plain.seed.pool(ACME, site);
      plain.iam.allow({ token: USER });
      const created = await plain.call<CreatedJoinToken>('joinTokens/create', USER, {
        tenantId: ACME,
        poolId: own,
        ttlSeconds: 600,
        idempotencyKey: 'pki',
      });
      const parsed = parseJoinToken(created.token);
      expect(parsed?.id).toBe(created.id);
      const { rows } = await plain.store.query<{ secret_hash: Uint8Array }>(
        'SELECT secret_hash FROM join_tokens WHERE id = $1',
        [created.id],
      );
      expect(Buffer.from(rows[0]!.secret_hash)).toEqual(
        Buffer.from(hashJoinSecret(parsed!.secret)),
      );
    } finally {
      await plain.close();
    }
  });
});

describe('joinTokens.list and revoke', () => {
  it('lists active tokens without secrets, revokes idempotently, and lists inactive on request', async () => {
    const kept = await create({ idempotencyKey: 'list-kept' });
    const revoked = await create({ idempotencyKey: 'list-revoked' });
    h.reset();
    const done = await h.call<JoinTokenInfo>('joinTokens/revoke', USER, {
      tenantId: ACME,
      poolId: pool,
      tokenId: revoked.id,
    });
    expect(done.revokedAt).toBe(Date.UTC(2026, 0, 1));
    expect(h.iam.calls.at(-1)!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:join-tokens:revoke',
      resource: { type: 'compute-pool', id: pool },
    });
    expect(h.ports.events.published.map((event) => event.type)).toEqual([
      'security.join-token.revoked',
    ]);
    h.reset();
    expect(
      await h.call('joinTokens/revoke', USER, {
        tenantId: ACME,
        poolId: pool,
        tokenId: revoked.id,
      }),
    ).toEqual(done);
    expect(h.ports.events.published).toEqual([]);

    const active = await h.call<{ items: JoinTokenInfo[] }>('joinTokens/list', USER, {
      tenantId: ACME,
      poolId: pool,
    });
    const ids = active.items.map((token) => token.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(revoked.id);
    expect(JSON.stringify(active)).not.toContain('bcjt_');
    const all = await h.call<{ items: JoinTokenInfo[] }>('joinTokens/list', USER, {
      tenantId: ACME,
      poolId: pool,
      includeInactive: true,
    });
    expect(all.items.map((token) => token.id)).toContain(revoked.id);
    expect(
      (
        await h.failure('joinTokens/revoke', USER, {
          tenantId: ACME,
          poolId: platformPool,
          tokenId: kept.id,
        })
      ).code,
    ).toBe('NOT_FOUND');
  });
});
