import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSimClock } from '@better-compute/postgres';
import type { CreatedSiteToken, SiteTokenInfo } from '../packages/server/src/api/site-tokens.js';
import { siteBootLeaseName, tickSiteBoot } from '../packages/server/src/controllers/site-boot.js';
import { ACME, ROOT } from './support/server.js';
import { ADMIN, START, USER, type Harness } from './support/server-api.js';
import { v02Harness } from './support/server-v02.js';

// `siteTokens` (PLAN.md §3.3 step 0, §9.2) and the SiteBoot lease (§8.5): role-`site` tokens decided
// on `compute-site/{id}`; one connected site agent holds `site:<id>:boot`, and a standby takes over
// within 30 s of the holder going away.

let h: Harness;
let site: string;
const minted: string[] = [];

beforeAll(async () => {
  h = await v02Harness({
    joinTokens: {
      mint(id) {
        const secret = `s${String(minted.length).padStart(42, '0')}`;
        minted.push(secret);
        return { token: `bcjt_${id}.${secret}`, secretHash: new Uint8Array(createHash('sha256').update(secret).digest()) };
      },
    },
  });
  site = await h.seed.site(ACME);
  h.iam.allow({ token: USER });
  h.iam.allow({ token: ADMIN });
});
afterAll(() => h.close());
beforeEach(() => h.reset());

describe('siteTokens.create and revoke', () => {
  it('mints a role-site token for the site, once, and decides on the site', async () => {
    const created = await h.call<CreatedSiteToken>('siteTokens/create', USER, {
      tenantId: ACME,
      siteId: site,
      ttlSeconds: 3600,
      maxUses: 2,
      idempotencyKey: 'agents',
    });
    expect(created).toMatchObject({ tenantId: ACME, siteId: site, role: 'site', usesLeft: 2, expiresAt: START + 3600_000 });
    expect(created.token).toBe(`bcjt_${created.id}.${minted.at(-1)}`);
    expect(h.iam.calls.map((call) => call.decision).filter(Boolean)).toEqual([
      { tenantId: ACME, action: 'compute:sites:manage', resource: { type: 'compute-site', id: site } },
    ]);
    const { rows } = await h.store.query<{ role: string; pool_id: string | null; site_id: string }>(
      'SELECT role, pool_id, site_id FROM join_tokens WHERE id = $1',
      [created.id],
    );
    expect(rows[0]).toEqual({ role: 'site', pool_id: null, site_id: site });
    expect(JSON.stringify(h.ports.events.published)).not.toContain(minted.at(-1)!);
    expect(h.ports.events.published.map((event) => event.type)).toEqual(['security.site-token.created']);

    h.reset();
    const { token, ...record } = created;
    expect(token).toBeDefined();
    expect(
      await h.call('siteTokens/create', USER, { tenantId: ACME, siteId: site, ttlSeconds: 3600, maxUses: 2, idempotencyKey: 'agents' }),
    ).toEqual(record);

    const revoked = await h.call<SiteTokenInfo>('siteTokens/revoke', USER, { tenantId: ACME, siteId: site, tokenId: created.id });
    expect(revoked.revokedAt).toBe(START);
    expect(await h.call('siteTokens/revoke', USER, { tenantId: ACME, siteId: site, tokenId: created.id })).toEqual(revoked);
  });

  it("refuses sites the tenant does not own, and node tokens through siteTokens.revoke", async () => {
    const platform = await h.seed.site(ROOT, { visibleTo: [ROOT, ACME] });
    expect(
      (await h.failure('siteTokens/create', USER, { tenantId: ACME, siteId: platform, ttlSeconds: 600, idempotencyKey: 'x' })).code,
    ).toBe('NOT_FOUND');
    const pool = await h.seed.pool(ACME, site);
    const node = await h.call<{ id: string }>('joinTokens/create', USER, { tenantId: ACME, poolId: pool, ttlSeconds: 600, idempotencyKey: 'n' });
    expect((await h.failure('siteTokens/revoke', USER, { tenantId: ACME, siteId: site, tokenId: node.id })).code).toBe('NOT_FOUND');
    for (const input of [
      { ttlSeconds: 86_401 },
      { maxUses: 17 },
      { poolId: pool },
    ])
      expect(
        (await h.failure('siteTokens/create', USER, { tenantId: ACME, siteId: site, ttlSeconds: 600, idempotencyKey: 'v', ...input })).code,
      ).toBe('INVALID_INPUT');
  });
});

describe('SiteBoot', () => {
  const agents: string[] = [];
  const connectivity = (id: string, value: 'connected' | 'disconnected') =>
    h.store.query('UPDATE nodes SET connectivity = $2 WHERE id = $1', [id, value]);
  const at = (seconds: number) => setSimClock(h.store, START + seconds * 1000);
  const tick = () => h.store.transaction((tx) => tickSiteBoot(tx, site));

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const id = await h.seed.node(ACME, site);
      await h.store.query("UPDATE nodes SET role = 'site', pool_id = NULL WHERE id = $1", [id]);
      agents.push(id);
    }
    agents.sort();
  });

  it('gives the lease to one connected agent, renews it, and fails over within 30 s', async () => {
    await at(0);
    const first = await tick();
    expect(first).toMatchObject({ active: agents[0], epoch: 1, changed: true });
    await at(10);
    expect(await tick()).toMatchObject({ active: agents[0], epoch: 1, changed: false, expiresAt: START + 25_000 });

    // The holder loses its session at t=12: its lease runs out at t=25, and only then is the standby
    // promoted, at a new epoch.
    await at(12);
    await connectivity(agents[0]!, 'disconnected');
    await at(20);
    expect(await tick()).toMatchObject({ active: agents[0], epoch: 1, changed: false });
    await at(26);
    const failover = await tick();
    // 14 s from the lost session to the promotion (at most TTL + one tick period): under 30 s.
    expect(failover).toMatchObject({ active: agents[1], epoch: 2, changed: true, previous: agents[0] });

    // The old holder comes back as a standby: the lease stays where it is.
    await connectivity(agents[0]!, 'connected');
    await at(30);
    expect(await tick()).toMatchObject({ active: agents[1], epoch: 2, changed: false });
  });

  it('releases the lease when no agent is left, and re-assigns it under a new epoch', async () => {
    await connectivity(agents[0]!, 'disconnected');
    await connectivity(agents[1]!, 'disconnected');
    await at(60);
    expect(await tick()).toMatchObject({ epoch: 3, changed: true, previous: agents[1] });
    expect((await tick()).active).toBeUndefined();
    await connectivity(agents[1]!, 'connected');
    expect(await tick()).toMatchObject({ active: agents[1], epoch: 4, changed: true });
    const { rows } = await h.store.query<{ owner: string; epoch: string }>(
      'SELECT owner, epoch::text AS epoch FROM leases WHERE name = $1',
      [siteBootLeaseName(site)],
    );
    expect(rows[0]).toEqual({ owner: agents[1], epoch: '4' });
  });
});
