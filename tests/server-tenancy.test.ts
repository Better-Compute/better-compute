import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePlugin, type SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, tenantStateHandler, type IamTenantStatus } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, OTHER, ROOT, acme, options } from './support/server.js';

// Tenancy (PLAN.md §12.8 `iam:tenants:update|delete` → "suspend admissions; schedule teardown and purge"): the IAM
// bridge's tenant handler mirrors suspended and deleted tenants (their whole subtree, re-read from IAM), the
// envelope refuses a suspended tenant's mutations and a deleted tenant's everything (root exempt), and the
// tenancy reconciler tears a deleted tenant down through every module's tenantDeleted hook.

const T0 = Date.UTC(2026, 8, 24, 12);
const USER = 'token-acme-user-0123456789';
const CHILD = 'token-child-user-0123456789';
const ADMIN = 'token-root-admin-0123456789';
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
    iam.addCaller('token-other-user-0123456789', { tenantId: OTHER, identityId: 'id-other' });
    for (const token of [USER, CHILD, ADMIN, 'token-other-user-0123456789']) iam.allow({ token });
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
    const compute = betterCompute({ ...options(db, iam), plugins: [acme, holder] });
    await compute.initialize();
    await useSimClock(db, T0);
    try {
      const poke = (token: string, tenantId: string, widgetId: string) =>
        compute.api.plugins.acme.widgets.poke({ token }, { tenantId, widgetId });
      const get = (token: string, tenantId: string, widgetId: string) =>
        compute.api.plugins.acme.widgets.get({ token }, { tenantId, widgetId });
      expect(await poke(USER, ACME, 'w1')).toMatchObject({ poked: 'w1' });

      // IAM suspends acme; the suspension cascades to its child organization.
      let iamStates: IamTenantStatus[] = [
        { tenantId: ACME, status: 'suspended' },
        { tenantId: ACME_CHILD, status: 'suspended' },
      ];
      const handler = tenantStateHandler(compute, { readTenants: async () => iamStates });
      const deliver = (action: string, subjectId = ACME) =>
        db.transaction((tx) => handler(tx, { tenantId: ROOT, action, subjectId, metadata: {} }));
      await deliver('iam:tenants:update');

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
      expect(await poke('token-other-user-0123456789', OTHER, 'w-other')).toMatchObject({
        poked: 'w-other',
      });

      // A replay changes nothing; reactivation lifts the refusal.
      const events = async (type: string) =>
        (
          await db.query<{ subject: string }>(
            `SELECT payload->>'subject' AS subject FROM outbox WHERE topic = $1 ORDER BY txid, seq`,
            [type],
          )
        ).rows.map((row) => row.subject);
      await deliver('iam:tenants:update');
      expect(await events('tenant.state-changed')).toEqual([
        `tenant/${ACME}`,
        `tenant/${ACME_CHILD}`,
      ]);
      iamStates = [
        { tenantId: ACME, status: 'active' },
        { tenantId: ACME_CHILD, status: 'active' },
      ];
      await deliver('iam:tenants:update');
      expect(await poke(USER, ACME, 'w4')).toMatchObject({ poked: 'w4' });

      // Deleted: everything is refused, and the teardown runs until every module is done.
      iamStates = [{ tenantId: ACME_CHILD, status: 'deleted' }];
      await deliver('iam:tenants:delete', ACME_CHILD);
      await expect(poke(CHILD, ACME_CHILD, 'w5')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
      });
      await expect(get(CHILD, ACME_CHILD, 'w1')).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED',
        details: { state: 'deleted' },
      });
      expect(await poke(USER, ACME, 'w6')).toMatchObject({ poked: 'w6' });

      const tick = () => compute.jobs['tenancy']!.tick();
      await tick();
      expect(passes).toBeGreaterThanOrEqual(1);
      // The module still releasing is asked again by the sweep (every 30 s) until it is done. Time moves in
      // small steps, as it does for real (the singleton lease renews between them).
      let now = T0;
      const advance = async (ms: number) => {
        for (let left = ms; left > 0; left -= 5_000) {
          now += Math.min(5_000, left);
          await setSimClock(db, now);
          await tick();
        }
      };
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

      // Without a reader, only a deletion is applied (to the named tenant).
      const bare = tenantStateHandler(compute);
      await db.transaction((tx) =>
        bare(tx, { tenantId: ROOT, action: 'iam:tenants:update', subjectId: OTHER, metadata: {} }),
      );
      expect(await poke('token-other-user-0123456789', OTHER, 'w7')).toMatchObject({ poked: 'w7' });
    } finally {
      await compute.stop();
    }
  });
});
