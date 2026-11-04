import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeFixtures } from '@better-compute/testing';
import type { KubernetesClusterView } from '@better-compute/kubernetes';
import { kubernetesWorld, type KubernetesWorld } from './support/kubernetes-world.js';

// kubernetes.cluster.hours: one per cluster per hour from the provider's first acceptance until it is deleted,
// billed to the cluster's tenant as `kubernetes` usage windows; a pool whose billing mode is `none` records none.

const hourMs = 3_600_000;
let world: KubernetesWorld;

const windows = async (clusterId: string) =>
  (
    await world.fixture.database.query<{
      tenant_id: string;
      meter: string;
      quantity: string;
      window_start: Date | string;
      tags: Record<string, string>;
      idempotency_key: string;
    }>(
      `SELECT tenant_id, meter, quantity::text AS quantity, window_start, tags, idempotency_key
         FROM usage_windows WHERE source_kind = 'kubernetes' AND source_id = $1 ORDER BY window_start`,
      [clusterId],
    )
  ).rows;
const stateOf = async (cluster: KubernetesClusterView) =>
  (
    await world.fixture.database.query<{ state: string }>(
      `SELECT state FROM kubernetes_clusters WHERE id = $1`,
      [cluster.id],
    )
  ).rows[0]!.state;
const create = (name: string, poolId = world.poolId): Promise<KubernetesClusterView> =>
  world.api.kubernetesClusters.create(world.acme, {
    tenantId: world.acmeTenant,
    poolId,
    name,
    mode: 'autopilot',
    location: 'us-central1',
    idempotencyKey: name,
  });

beforeAll(async () => {
  world = await kubernetesWorld();
});
afterAll(closeFixtures);

describe('kubernetes.cluster.hours', () => {
  it('meters a hosted cluster from its creation at the provider until it is deleted', async () => {
    const cluster = await create('metered');
    await world.until(async () => (await stateOf(cluster)) === 'ready');
    const { rows } = await world.fixture.database.query<{ provisioned: number }>(
      `SELECT (extract(epoch FROM provisioned_at) * 1000)::float8 AS provisioned FROM kubernetes_clusters WHERE id = $1`,
      [cluster.id],
    );
    const provisioned = Number(rows[0]!.provisioned);
    // Three hours later (and past the 5 minute grace), the usage pass writes the ended hours.
    await world.fixture.advance(3 * hourMs);
    await world.tick('kubernetes.usage', 1, 6 * 60_000);
    const written = await windows(cluster.id);
    expect(written.length).toBeGreaterThanOrEqual(3);
    for (const window of written)
      expect(window).toMatchObject({
        tenant_id: world.acmeTenant,
        meter: 'kubernetes.cluster.hours',
        tags: {
          pool: world.poolId,
          region: 'us-central1',
          provider: 'fake-gke',
          source: 'kubernetes-autopilot',
        },
      });
    expect(written[0]!.idempotency_key).toMatch(
      new RegExp(`^cmp:kubernetes:${cluster.id}:\\d+:kubernetes\\.cluster\\.hours$`),
    );
    const now = world.fixture.clock.now();
    const covered = Math.floor((now - 5 * 60_000) / hourMs) * hourMs;
    const total = written.reduce((sum, window) => sum + Number(window.quantity), 0);
    expect(total).toBeCloseTo((covered - provisioned) / hourMs, 4);
    // A second pass writes nothing new.
    await world.tick('kubernetes.usage', 1, 60_000);
    expect((await windows(cluster.id)).length).toBe(written.length);

    // Deleted: billing ends at deleted_at, and no hour after it is written.
    await world.api.kubernetesClusters.delete(world.acme, {
      tenantId: world.acmeTenant,
      clusterId: cluster.id,
    });
    await world.until(async () => (await stateOf(cluster)) === 'deleted');
    await world.fixture.advance(4 * hourMs);
    await world.tick('kubernetes.usage', 1, 6 * 60_000);
    const final = await world.fixture.database.query<{ deleted: number; metered: number }>(
      `SELECT (extract(epoch FROM deleted_at) * 1000)::float8 AS deleted,
              (extract(epoch FROM metered_until) * 1000)::float8 AS metered
         FROM kubernetes_clusters WHERE id = $1`,
      [cluster.id],
    );
    const deletedAt = Number(final.rows[0]!.deleted);
    expect(Number(final.rows[0]!.metered)).toBe(deletedAt);
    const all = await windows(cluster.id);
    const sum = all.reduce((acc, window) => acc + Number(window.quantity), 0);
    expect(sum).toBeCloseTo((deletedAt - provisioned) / hourMs, 4);
    expect(all.every((window) => new Date(window.window_start).getTime() < deletedAt)).toBe(true);
  });

  it('meters nothing for a pool whose billing mode is none, nor for a cluster never created', async () => {
    const free = await world.api.pools.create(world.root, {
      tenantId: world.rootTenant,
      siteId: world.siteId,
      class: 'provider',
      providerAccountId: world.accountId,
      idempotencyKey: 'free-pool',
    });
    await world.fixture.database.query(
      `UPDATE pools SET policy = jsonb_set(coalesce(policy, '{}'::jsonb), '{billing}', '{"mode":"none"}'::jsonb)
        WHERE id = $1`,
      [free.id],
    );
    const unbilled = await world.api.kubernetesClusters.create(world.root, {
      tenantId: world.rootTenant,
      poolId: free.id,
      name: 'unbilled',
      mode: 'autopilot',
      location: 'us-central1',
      idempotencyKey: 'unbilled',
    });
    await world.until(async () => (await stateOf(unbilled)) === 'ready');
    // Never accepted by the provider: never metered.
    const never = await create('never');
    world.cloud.refuse.add(`ensureCluster ${never.providerName}`);
    await world.tick();
    expect(await stateOf(never)).toBe('error');
    await world.fixture.advance(3 * hourMs);
    await world.tick('kubernetes.usage', 1, 6 * 60_000);
    expect(await windows(unbilled.id)).toEqual([]);
    expect(await windows(never.id)).toEqual([]);
    // The watermark still advanced for the unbilled cluster.
    const { rows } = await world.fixture.database.query<{ metered_until: Date | null }>(
      `SELECT metered_until FROM kubernetes_clusters WHERE id = $1`,
      [unbilled.id],
    );
    expect(rows[0]!.metered_until).not.toBeNull();
  });
});
