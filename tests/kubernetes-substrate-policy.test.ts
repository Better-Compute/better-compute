import { describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import {
  kubernetesMigrations,
  parsePoolSubstrate,
  substrateIdentity,
  substratePolicyValidator,
} from '@better-compute/kubernetes';

// policy.substrate: what a pool backed by a managed Kubernetes cluster declares, checked by the kubernetes module's
// pool-policy validator at pools.create/update (fail closed: anything unclear is INVALID_INPUT).

const account = 'pacct_01m6qeam71qjbg1rp4g1czpvaf';
const gpu = { name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } };
const create = {
  kind: 'kubernetes',
  account,
  cluster: { create: { location: 'us-central1' } },
  flavors: [gpu],
};
const policy = (substrate: unknown, kubernetes: unknown = {}) => ({ kubernetes, substrate });

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('parsePoolSubstrate', () => {
  it('reads a create substrate with defaults', () => {
    expect(parsePoolSubstrate(policy(create))).toEqual({
      kind: 'kubernetes',
      account,
      cluster: {
        create: { location: 'us-central1', releaseChannel: 'regular', authorizedNetworks: [], privateNodes: false },
      },
      flavors: [{ name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 }, spot: false }],
      allowSpot: false,
      upgrades: 'surge',
    });
    expect(parsePoolSubstrate({})).toBeUndefined();
  });

  it('reads an adopt substrate, with or without flavors', () => {
    const adopted = parsePoolSubstrate(
      policy({ kind: 'kubernetes', account, cluster: { adopt: 'projects/p/locations/us-central1/clusters/prod' } }),
    );
    expect(adopted).toMatchObject({ cluster: { adopt: 'projects/p/locations/us-central1/clusters/prod' }, flavors: [] });
  });

  it('takes Spot flavors only with allowSpot', () => {
    const spot = { ...gpu, name: 'gpu-spot', spot: true };
    expect(refusal(() => parsePoolSubstrate(policy({ ...create, flavors: [gpu, spot] })))).toMatch(/allowSpot/);
    expect(parsePoolSubstrate(policy({ ...create, allowSpot: true, flavors: [gpu, spot] }))!.flavors[1]).toMatchObject({
      spot: true,
    });
  });

  it('refuses what it cannot converge', () => {
    const cases: [unknown, unknown, RegExp][] = [
      [{ ...create, kind: 'nomad' }, {}, /kind/],
      [{ ...create, account: 'acct' }, {}, /account/],
      [{ ...create, cluster: {} }, {}, /create or adopt/],
      [{ ...create, cluster: { create: { location: 'us-central1' }, adopt: 'x' } }, {}, /create or adopt/],
      [{ ...create, cluster: { adopt: 'has space' } }, {}, /adopt/],
      [{ ...create, flavors: [] }, {}, /at least one flavor/],
      [{ ...create, flavors: [gpu, gpu] }, {}, /twice/],
      [{ ...create, flavors: [{ ...gpu, nodes: -1 }] }, {}, /nodes/],
      [{ ...create, flavors: [{ ...gpu, extra: 1 }] }, {}, /extra/],
      [{ ...create, surprise: true }, {}, /surprise/],
      [create, undefined, /policy\.kubernetes/],
      [create, { apiServer: 'https://k8s:6443' }, /k8s-join/],
      [create, { gpuApi: 'dra' }, /device plugin/],
    ];
    for (const [substrate, kubernetes, message] of cases)
      expect(refusal(() => parsePoolSubstrate({ ...(kubernetes !== undefined ? { kubernetes } : {}), substrate }))).toMatch(
        message,
      );
  });

  it('keys the identity on account, mode, location or adopted id, and private nodes', () => {
    const base = parsePoolSubstrate(policy(create))!;
    const sameIdentity = parsePoolSubstrate(
      policy({ ...create, cluster: { create: { location: 'us-central1', version: '1.34' } }, flavors: [{ ...gpu, nodes: 5 }] }),
    )!;
    expect(substrateIdentity(sameIdentity)).toBe(substrateIdentity(base));
    const moved = parsePoolSubstrate(policy({ ...create, cluster: { create: { location: 'europe-west4' } } }))!;
    expect(substrateIdentity(moved)).not.toBe(substrateIdentity(base));
  });
});

describe('substratePolicyValidator', () => {
  it('is a pool-policy extension that refuses provider pools and bad substrates', async () => {
    expect(substratePolicyValidator.extension).toBe('pool-policy');
    await expect(substratePolicyValidator.validate(policy(create), { class: 'metal-host' })).resolves.toBeUndefined();
    await expect(substratePolicyValidator.validate({}, { class: 'provider' })).resolves.toBeUndefined();
    await expect(substratePolicyValidator.validate(policy(create), { class: 'provider' })).rejects.toThrow(/provider pool/);
    await expect(substratePolicyValidator.validate(policy({ ...create, kind: 'x' }), { class: 'metal-host' })).rejects.toThrow(
      /kind/,
    );
  });

  it('ships its migration', () => {
    expect(kubernetesMigrations.map((migration) => migration.name)).toEqual([
      'kubernetes/0001_clusters',
      'kubernetes/0002_substrates',
    ]);
  });
});

describe('pools.create with a substrate', () => {
  it('runs the validator: a bad substrate is refused, a good one is stored', async () => {
    const { kubernetesWorld } = await import('./support/kubernetes-world.js');
    const world = await kubernetesWorld();
    try {
      const make = (substrate: unknown, key: string) =>
        world.api.pools.create(world.root, {
          tenantId: world.rootTenant,
          siteId: world.siteId,
          class: 'metal-host',
          policy: { kubernetes: {}, substrate },
          idempotencyKey: key,
        });
      const error = await make({ ...create, account: world.accountId, flavors: [] }, 'bad').catch((thrown: unknown) => thrown);
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
      const pool = await make({ ...create, account: world.accountId }, 'good');
      expect(pool.policy.substrate).toMatchObject({ kind: 'kubernetes', account: world.accountId });
      const { rows } = await world.fixture.database.query(`SELECT count(*)::int AS n FROM kubernetes_pool_substrates`);
      expect(rows[0]).toEqual({ n: 0 });
    } finally {
      await world.fixture.close();
    }
  });
});
