import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import { computeFixture, type ComputeFixture } from '@better-compute/testing';

// ctx.pki.issueJoinToken({ hosted: 'kubernetes' }): a module that runs bcd as a DaemonSet on a cluster (the
// kubernetes module's pool substrate) mints the same hosted token joinTokens.create does, so JoinService lands
// the nodes at the pool's trust rule for hosted bcd (core/0027).

let fixture: ComputeFixture;
let poolId: string;

beforeAll(async () => {
  fixture = await computeFixture({ clock: 'sim' });
  const api = fixture.compute.api as any;
  const root = { token: fixture.tenants.root.token };
  fixture.iam.allow({ token: root.token });
  const site = await api.sites.create(root, {
    tenantId: fixture.tenants.root.id,
    kind: 'shared',
    region: 'eu-west-1',
    idempotencyKey: 'pki-site',
  });
  ({ id: poolId } = await api.pools.create(root, {
    tenantId: fixture.tenants.root.id,
    siteId: site.id,
    class: 'metal-host',
    policy: { kubernetes: {} },
    idempotencyKey: 'pki-pool',
  }));
});

afterAll(async () => {
  await fixture?.close();
});

describe('pki.issueJoinToken hosted', () => {
  it('records a hosted kubernetes token, and a plain one stays plain', async () => {
    const pki = fixture.compute.context.pki!;
    const issue = (hosted?: 'kubernetes') =>
      fixture.compute.context.sql.transaction((tx) =>
        pki.issueJoinToken(tx, {
          tenantId: fixture.tenants.root.id,
          role: 'node',
          poolId,
          ttlSeconds: 3600,
          maxUses: 3,
          ...(hosted ? { hosted } : {}),
        }),
      );
    const hosted = await issue('kubernetes');
    const plain = await issue();
    expect(hosted.token).toMatch(/^bcjt_/);
    const { rows } = await fixture.database.query<{ id: string; hosted: string | null; uses_left: number }>(
      `SELECT id, hosted, uses_left FROM join_tokens WHERE id = ANY($1) ORDER BY id`,
      [[hosted.id, plain.id]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.hosted]))).toEqual({
      [hosted.id]: 'kubernetes',
      [plain.id]: null,
    });
  });

  it('refuses any other hosted value, and a hosted token for a role other than node', async () => {
    const pki = fixture.compute.context.pki!;
    for (const input of [
      { role: 'node', hosted: 'docker' },
      { role: 'provisioned', hosted: 'kubernetes' },
    ]) {
      const error = await fixture.compute.context.sql
        .transaction((tx) =>
          pki.issueJoinToken(tx, {
            tenantId: fixture.tenants.root.id,
            poolId,
            ttlSeconds: 3600,
            ...(input as { role: 'node'; hosted: 'kubernetes' }),
          }),
        )
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
  });
});
