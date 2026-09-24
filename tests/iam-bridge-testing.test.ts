import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isComputeError, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { successorsMigration } from '@better-compute/iam';
import {
  createEmbeddedTestIam,
  TEST_COMPUTE_AUDIENCE,
  totpCode,
  type EmbeddedTestIam,
} from '@better-compute/iam/testing';

// The embedded-IAM test kit other suites build on (computeFixture `iam: 'embedded'`, e2e, sim).

let db: SqlExecutor;
const open: EmbeddedTestIam[] = [];
const kit = async (...args: Parameters<typeof createEmbeddedTestIam>) => {
  const created = await createEmbeddedTestIam(...args);
  open.push(created);
  return created;
};

beforeAll(async () => {
  db = pglite();
  await db.migrate([successorsMigration]);
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
  await db.query('DELETE FROM authz_projection');
  await db.query('DELETE FROM iam_inbox');
});

describe('createEmbeddedTestIam', () => {
  it('bootstraps a root with MFA and two active organizations, decided through the real plugin and resolver', async () => {
    const t = await kit({ sql: db });
    expect(t.bridge.bound).toBe(true);
    expect(t.port.rootTenantId).toBe(t.root.tenantId);
    expect(await t.port.authenticate(t.root.credential)).toMatchObject({
      identityId: t.root.identityId,
      tenantId: t.root.tenantId,
      mfa: true,
    });
    expect(t.acme.tenantId).not.toBe(t.other.tenantId);

    const alice = await t.acme.member('alice');
    await t.acme.grant(alice.identityId, {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:pools:read'], resources: ['compute-pool/*'] },
      ],
    });
    await db.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('pool', 'pool-1', $1, '{}')`,
      [t.acme.tenantId],
    );
    const read = (tenantId: string) => ({
      tenantId,
      action: 'compute:pools:read',
      resource: { type: 'compute-pool', id: 'pool-1' },
    });
    // Committed but not tailed yet: the resolver's miss path reads it.
    await expect(t.port.require(alice.credential, read(t.acme.tenantId))).resolves.toBeUndefined();
    // Another organization sees nothing: 404 in its own view, denial across tenants.
    const bob = await t.other.member('bob');
    const miss = await t.port
      .require(bob.credential, read(t.other.tenantId))
      .catch((error) => error);
    expect(isComputeError(miss, 'NOT_FOUND')).toBe(true);
    expect(await t.port.authorize(bob.credential, read(t.acme.tenantId))).toBe(false);
  });

  it('writes IAM events to compute’s inbox once bound, or to memory', async () => {
    const t = await kit({ inbox: 'memory' });
    const agent = await t.iam.api.agents.create(t.acme.owner, {
      tenantId: t.acme.tenantId,
      name: 'Nightly',
      model: 'claude-sonnet-5',
    });
    await t.iam.api.agents.suspend(t.acme.owner, { tenantId: t.acme.tenantId, agentId: agent.id });
    expect(await t.dispatch()).toBeGreaterThan(0);
    expect(t.inbox!.events.map((event) => event.action)).toContain('agent:suspend');

    const bound = await kit();
    const other = await bound.iam.api.agents.create(bound.acme.owner, {
      tenantId: bound.acme.tenantId,
      name: 'Nightly',
      model: 'claude-sonnet-5',
    });
    await bound.iam.api.agents.suspend(bound.acme.owner, {
      tenantId: bound.acme.tenantId,
      agentId: other.id,
    });
    await bound.dispatch();
    expect(bound.plugin.stats().pending).toBeGreaterThan(0);
    await bound.bind(db);
    expect(bound.plugin.stats().pending).toBe(0);
    const { rows } = await db.query<{ action: string }>('SELECT action FROM iam_inbox');
    expect(rows.map((row) => row.action)).toContain('agent:suspend');
  });

  it('shares resources, creates more tenants, mints session JWTs and moves its clock', async () => {
    const t = await kit({ sessionJwts: true });
    const carol = await t.acme.member('carol');
    await t.acme.share('compute-pool', 'pool-9', 'user', { identityId: carol.identityId });
    const relationships = await t.iam.api.relationships.list(t.acme.owner, {
      tenantId: t.acme.tenantId,
    });
    expect(JSON.stringify(relationships)).toContain('pool-9');
    const third = await t.tenant('Third Org');
    expect(third.tenantId).not.toBe(t.acme.tenantId);
    await third.member('dan');
    expect(await third.signIn('dan')).toMatchObject({ token: expect.any(String) });

    await t.acme.grant(carol.identityId, {
      version: 1,
      statements: [
        {
          effect: 'allow',
          actions: ['iam:session-tokens:create'],
          resources: ['iam/${principal.id}'],
        },
        {
          effect: 'allow',
          actions: ['iam:assertions:create'],
          resources: [`iam/${TEST_COMPUTE_AUDIENCE}`],
        },
      ],
    });
    const issuer = t.iam.sessionTokens!.issuer;
    const minted = await t.iam.api.sts.getSessionToken(carol.credential, {
      format: 'jwt',
      audience: [issuer, TEST_COMPUTE_AUDIENCE],
    });
    expect(await t.port.authenticate({ token: minted.token })).toMatchObject({
      identityId: carol.identityId,
      sessionKind: 'session-token',
    });

    const before = t.now();
    t.advance(60_000);
    expect(t.now()).toBe(before + 60_000);
    expect(totpCode('JBSWY3DPEHPK3PXP', 0)).toMatch(/^\d{6}$/);
  });

  it('adds IAM jobs on request', async () => {
    const t = await kit({ runIamJobs: true });
    expect(t.bridge.modules[0].reconcilers!.map((reconciler) => reconciler.name)).toContain(
      'iam.jobs.audit-hooks',
    );
  });
});
