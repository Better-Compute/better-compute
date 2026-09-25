import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePlugin, type SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, tenantStateHandler, type IamTenantStatus } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, OTHER, ROOT, acme, options } from './support/server.js';

// Tenancy (PLAN.md §12.8 `iam:tenants:update|delete` → "suspend admissions; schedule teardown and purge"): the IAM
// bridge's tenant handler records a deletion at once and queues a re-read, making no IAM call in the inbox
// transaction (§8.1); the tenancy reconciler reads the whole subtree from IAM outside any transaction (retrying while
// IAM is down; a periodic resync from the root catches anything missed); the envelope refuses a suspended tenant's
// mutations and a deleted tenant's everything (root exempt); and the reconciler tears a deleted tenant down through
// every module's tenantDeleted hook.

const T0 = Date.UTC(2026, 8, 24, 12);
const USER = 'token-acme-user-0123456789';
const CHILD = 'token-child-user-0123456789';
const ADMIN = 'token-root-admin-0123456789';
const OTHER_USER = 'token-other-user-0123456789';
const GONE_USER = 'token-gone-user-0123456789';
const ACME_CHILD = 'tenant-acme-child';

let db: SqlExecutor;
beforeAll(async () => {
  db = pglite();
});
afterAll(async () => {
  await db.close();
});

describe('tenancy', () => {
  it('suspends, deletes and tears down tenants from IAM events', async () => {
    const iam = fakeIam();
    iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user', sessionId: 'ses-user' });
    iam.addCaller(CHILD, { tenantId: ACME_CHILD, identityId: 'id-child', sessionId: 'ses-child' });
    iam.addCaller(ADMIN, { tenantId: ROOT, identityId: 'id-admin', mfa: true });
    iam.addCaller(OTHER_USER, { tenantId: OTHER, identityId: 'id-other' });
    for (const token of [USER, CHILD, ADMIN, OTHER_USER]) iam.allow({ token });
    // A module holding something per tenant: the first teardown pass is still releasing, the second is done.
    const released: string[] = [];
    let passes = 0;
    const holder = definePlugin({
      id: 'holder',
      async tenantDeleted(_context, tenantId) {
        passes++;
        if (passes === 1) return 'SYNC_AGAIN';
        released.push(tenantId);
        return 'DONE';
      },
    });
    // One simulated time for compute's own clock (its leases) and the store's compute_now().
    let now = T0;
    const compute = betterCompute({
      ...options(db, iam),
      clock: { now: () => now },
      plugins: [acme, holder],
    });
    await compute.initialize();
    await useSimClock(db, T0);
    try {
      const poke = (token: string, tenantId: string, widgetId: string) =>
        compute.api.plugins.acme.widgets.poke({ token }, { tenantId, widgetId });
      const get = (token: string, tenantId: string, widgetId: string) =>
        compute.api.plugins.acme.widgets.get({ token }, { tenantId, widgetId });
      const events = async (type: string) =>
        (
          await db.query<{ subject: string }>(
            `SELECT payload->>'subject' AS subject FROM outbox WHERE topic = $1 ORDER BY txid, seq`,
            [type],
          )
        ).rows.map((row) => row.subject);
      expect(await poke(USER, ACME, 'w1')).toMatchObject({ poked: 'w1' });

      // IAM's view, and whether it answers.
      let iamStates: IamTenantStatus[] = [
        { tenantId: ACME, status: 'suspended' },
        { tenantId: ACME_CHILD, status: 'suspended' },
      ];
      let iamDown = false;
      const reads: string[] = [];
      const handler = tenantStateHandler(compute, {
        readTenants: async (tenantId) => {
          reads.push(tenantId);
          if (iamDown) throw Object.assign(new Error('IAM is down'), { code: 'UNAVAILABLE' });
          return iamStates;
        },
      });
      const deliver = (action: string, subjectId = ACME) =>
        db.transaction((tx) => handler(tx, { tenantId: ROOT, action, subjectId, metadata: {} }));
      const tick = () => compute.jobs['tenancy']!.tick();
      /** Time moves in small steps, as it does for real (the singleton lease renews between them). */
      const advance = async (ms: number) => {
        for (let left = ms; left > 0; left -= 5_000) {
          now += Math.min(5_000, left);
          await setSimClock(db, now);
          await tick();
          await compute.jobs['tenancy.resync']!.tick();
        }
      };

      // IAM suspends acme; the suspension cascades to its child organization. The inbox transaction asks IAM
      // nothing: the reconciler reads the subtree.
      await deliver('iam:tenants:update');
      expect(reads).toEqual([]);
      expect(await poke(USER, ACME, 'w1b')).toMatchObject({ poked: 'w1b' });
      await tick();
      expect(reads).toContain(ACME);

      await expect(poke(USER, ACME, 'w2')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
        status: 403,
        details: { tenantId: ACME, state: 'suspended' },
      });
      await expect(poke(CHILD, ACME_CHILD, 'w3')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
      });
      // Reads go on; root may still act in the suspended tenant; other tenants are untouched.
      expect(await get(USER, ACME, 'w1')).toMatchObject({ exists: true });
      expect(await poke(ADMIN, ACME, 'w-root')).toMatchObject({ poked: 'w-root' });
      expect(await poke(OTHER_USER, OTHER, 'w-other')).toMatchObject({ poked: 'w-other' });

      // A replay changes nothing.
      await deliver('iam:tenants:update');
      await tick();
      expect(await events('tenant.state-changed')).toEqual([
        `tenant/${ACME}`,
        `tenant/${ACME_CHILD}`,
      ]);

      // IAM is down while the reactivation is read: nothing changes (no fail-open), and the key is retried with
      // back-off until IAM answers.
      iamStates = [
        { tenantId: ACME, status: 'active' },
        { tenantId: ACME_CHILD, status: 'active' },
      ];
      iamDown = true;
      await deliver('iam:tenants:update');
      await tick();
      await expect(poke(USER, ACME, 'w4')).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
      iamDown = false;
      await advance(5_000);
      expect(await poke(USER, ACME, 'w4')).toMatchObject({ poked: 'w4' });

      // Deleted: a teardown cannot be undone, so the event alone is not trusted: nothing changes until IAM
      // confirms it (IAM has already ended the tenant's sessions); then everything is refused.
      iamStates = [{ tenantId: ACME_CHILD, status: 'deleted' }];
      iamDown = true;
      await deliver('iam:tenants:delete', ACME_CHILD);
      await tick();
      expect(await poke(CHILD, ACME_CHILD, 'w5a')).toMatchObject({ poked: 'w5a' });
      iamDown = false;
      await advance(5_000);
      await expect(poke(CHILD, ACME_CHILD, 'w5')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
      });
      await expect(get(CHILD, ACME_CHILD, 'w1')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
        details: { state: 'deleted' },
      });
      expect(await poke(USER, ACME, 'w6')).toMatchObject({ poked: 'w6' });
      // Root reads a deleted tenant but never writes into it (nothing would tear that down).
      expect(await get(ADMIN, ACME_CHILD, 'w1')).toMatchObject({ exists: false });
      await expect(poke(ADMIN, ACME_CHILD, 'w-root-late')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
      });

      // The teardown runs until every module is done: the one still releasing is asked again by the sweep (30 s).
      await tick();
      expect(passes).toBeGreaterThanOrEqual(1);
      await advance(35_000);
      await tick();
      expect(passes).toBe(2);
      expect(released).toEqual([ACME_CHILD]);
      expect(await events('tenant.torn-down')).toEqual([`tenant/${ACME_CHILD}`]);
      const { rows } = await db.query<{ done: boolean }>(
        `SELECT teardown_done_at IS NOT NULL AS done FROM compute_tenant_states WHERE tenant_id = $1`,
        [ACME_CHILD],
      );
      expect(rows).toEqual([{ done: true }]);
      // Done: later sweeps ask nobody again.
      await advance(65_000);
      expect(passes).toBe(2);

      // The periodic resync (every 15 min, from the root) catches a suspension whose event never arrived.
      iamStates = [
        { tenantId: ROOT, status: 'active' },
        { tenantId: OTHER, status: 'suspended' },
        { tenantId: ACME_CHILD, status: 'deleted' },
      ];
      reads.length = 0;
      await advance(15 * 60_000);
      expect(reads).toContain(ROOT);
      await expect(poke(OTHER_USER, OTHER, 'w-resync')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
      });
      iamStates = [{ tenantId: OTHER, status: 'active' }];
      await deliver('iam:tenants:update', OTHER);
      await tick();
      expect(await poke(OTHER_USER, OTHER, 'w7')).toMatchObject({ poked: 'w7' });
      expect(passes).toBe(2);

      // The root tenant is never suspended or deleted, and `missing` never starts a teardown by itself (an id IAM
      // does not know as a tenant, such as an invitation's, only confirms a tenant already refused).
      iamStates = [
        { tenantId: ROOT, status: 'suspended' },
        { tenantId: 'inv_not_a_tenant', status: 'missing' },
        { tenantId: ACME_CHILD, status: 'missing' },
      ];
      await deliver('iam:tenants:update', ROOT);
      await tick();
      const { rows: recorded } = await db.query<{ tenant_id: string; state: string }>(
        `SELECT tenant_id, state FROM compute_tenant_states ORDER BY tenant_id`,
      );
      expect(recorded.filter((row) => row.state !== 'active')).toEqual([
        { tenant_id: ACME_CHILD, state: 'deleted' },
      ]);
      expect(await poke(ADMIN, ROOT, 'w-root-own')).toMatchObject({ poked: 'w-root-own' });
      expect(passes).toBe(2);
    } finally {
      await compute.stop();
    }
  });

  it('applies only deletions, to the named tenant, without a reader', async () => {
    const iam = fakeIam();
    iam.addCaller(OTHER_USER, { tenantId: OTHER, identityId: 'id-other' });
    iam.allow({ token: OTHER_USER });
    const compute = betterCompute({ ...options(db, iam), plugins: [acme] });
    await compute.initialize();
    try {
      // A bare handler on a structural compute (no `tenants.setReader`): no sync key, no IAM read.
      const bare = tenantStateHandler({
        context: compute.context,
        tenants: { invalidate: compute.tenants.invalidate },
      });
      const deliver = (action: string, tenantId = 'tenant-gone') =>
        db.transaction((tx) =>
          bare(tx, { tenantId, action, subjectId: 'tenant-gone', metadata: {} }),
        );
      await deliver('iam:tenants:update');
      const states = async () =>
        (
          await db.query<{ state: string }>(
            `SELECT state FROM compute_tenant_states WHERE tenant_id = 'tenant-gone'`,
          )
        ).rows.map((row) => row.state);
      expect(await states()).toEqual([]);
      // An event naming another tenant than its own is not trusted with a teardown.
      await deliver('iam:tenants:delete', ROOT);
      expect(await states()).toEqual([]);
      await deliver('iam:tenants:delete');
      expect(await states()).toEqual(['deleted']);
      // An API-only replica (`serve --roles api`, never initialized) loads the states on its first call.
      iam.addCaller(GONE_USER, { tenantId: 'tenant-gone', identityId: 'id-gone' });
      iam.allow({ token: GONE_USER });
      const replica = betterCompute({ ...options(db, iam), plugins: [acme] });
      await expect(
        replica.api.plugins.acme.widgets.get(
          { token: GONE_USER },
          { tenantId: 'tenant-gone', widgetId: 'w' },
        ),
      ).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
      await replica.stop();
      expect(
        await compute.api.plugins.acme.widgets.poke(
          { token: OTHER_USER },
          { tenantId: OTHER, widgetId: 'w' },
        ),
      ).toMatchObject({ poked: 'w' });
    } finally {
      await compute.stop();
    }
  });
});
