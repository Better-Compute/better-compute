import { describe, expect, it } from 'vitest';
import {
  createRolloutView,
  fleetDriftView,
  nodeTable,
  rolloutProgress,
  type ComputeRequester,
  type RolloutDetail,
} from '@better-compute/console-kit';

// console-kit admin views: rollout progress, fleet drift, node table.

const rollout = (overrides: Partial<RolloutDetail> = {}): RolloutDetail => ({
  id: 'rollout_1',
  version: '1.4.0',
  state: 'running',
  waves: [10, 50, 100],
  wave: 1,
  nodeList: [
    { nodeId: 'n1', poolId: 'p', wave: 0, state: 'succeeded' },
    { nodeId: 'n2', poolId: 'p', wave: 1, state: 'upgrading' },
    { nodeId: 'n3', poolId: 'p', wave: 1, state: 'failed', error: 'timeout' },
    { nodeId: 'n4', poolId: 'p', wave: 2, state: 'pending' },
    { nodeId: 'n5', poolId: 'p', wave: 2, state: 'skipped', error: 'offline' },
  ],
  ...overrides,
});

describe('rollout progress', () => {
  it('summarizes waves, failures and what an admin may do', () => {
    const progress = rolloutProgress(rollout());
    expect(progress.waves.map((wave) => wave.status)).toEqual(['done', 'current', 'waiting']);
    expect(progress.waves[1]).toMatchObject({ nodes: 2, counts: { upgrading: 1, failed: 1 } });
    expect(progress).toMatchObject({ done: 2, total: 5, failed: 1 });
    expect(progress.can).toEqual({ pause: true, resume: false, abort: true });
    expect(progress.failures.map((node) => node.nodeId)).toEqual(['n3']);
    expect(rolloutProgress(rollout({ state: 'paused', reason: 'failure gate' })).can).toEqual({
      pause: false,
      resume: true,
      abort: true,
    });
    const completed = rolloutProgress(
      rollout({
        state: 'completed',
        wave: 2,
        nodeList: [{ nodeId: 'n1', poolId: 'p', wave: 2, state: 'succeeded' }],
      }),
    );
    expect(completed.waves.map((wave) => wave.status)).toEqual(['done', 'done', 'done']);
    expect(completed.can).toEqual({ pause: false, resume: false, abort: false });
  });

  it('loads through rollouts.get', async () => {
    const calls: unknown[] = [];
    const api: ComputeRequester = {
      async $request<O>(path: string, input?: unknown) {
        calls.push({ path, input });
        return rollout() as O;
      },
    };
    const view = createRolloutView(api, { tenantId: 'root', rolloutId: 'rollout_1' });
    await view.refresh();
    expect(view.get().value).toMatchObject({ version: '1.4.0', failed: 1 });
    expect(calls).toEqual([
      { path: 'rollouts/get', input: { tenantId: 'root', rolloutId: 'rollout_1' } },
    ]);
  });
});

describe('fleet drift view', () => {
  it('groups changes by kind in dependency order', () => {
    const view = fleetDriftView({
      applied: { planHash: 'h', appliedBy: 'usr_root', appliedAt: 1, checkedAt: 2 },
      drift: {
        blocked: false,
        summary: { update: 2, create: 1 },
        changes: [
          { kind: 'offer', name: 'vps -> acme', action: 'update', fields: ['quota'] },
          { kind: 'pool', name: 'vps', action: 'update', fields: ['policy'] },
          { kind: 'pool', name: 'burst', action: 'create' },
        ],
      },
    });
    expect(view).toMatchObject({
      managed: true,
      drifted: true,
      appliedBy: 'usr_root',
      checkedAt: 2,
    });
    expect(view.groups.map((group) => group.kind)).toEqual(['pool', 'offer']);
    expect(view.groups[0]!.changes.map((change) => change.name)).toEqual(['burst', 'vps']);
    expect(fleetDriftView({})).toEqual({
      managed: false,
      drifted: false,
      groups: [],
      blocked: false,
    });
  });
});

describe('node table', () => {
  const nodes = [
    {
      id: 'node_b',
      poolId: 'pool_1',
      connectivity: 'connected',
      provisionState: 'adopted',
      cordoned: false,
      labels: [{ key: 'rack', value: 'R12' }],
      conditions: [{ type: 'GpuXid', status: 'true' }],
    },
    {
      id: 'node_a',
      poolId: 'pool_2',
      connectivity: 'lost',
      provisionState: 'adopted',
      cordoned: true,
    },
    { id: 'node_c', poolId: 'pool_1', connectivity: 'connected', provisionState: 'deployed' },
  ];
  it('filters by text, state, flags and conditions, and sorts stably', () => {
    expect(nodeTable(nodes).map((node) => node.id)).toEqual(['node_a', 'node_b', 'node_c']);
    expect(nodeTable(nodes, { filter: { text: 'r12' } }).map((node) => node.id)).toEqual([
      'node_b',
    ]);
    expect(
      nodeTable(nodes, { filter: { connectivity: ['connected'], cordoned: false } }).map(
        (n) => n.id,
      ),
    ).toEqual(['node_b', 'node_c']);
    expect(nodeTable(nodes, { filter: { conditions: ['GpuXid'] } }).map((n) => n.id)).toEqual([
      'node_b',
    ]);
    expect(nodeTable(nodes, { sort: 'conditions', descending: true }).map((n) => n.id)).toEqual([
      'node_b',
      'node_a',
      'node_c',
    ]);
    expect(nodeTable(nodes, { sort: 'pool' }).map((n) => n.id)).toEqual([
      'node_b',
      'node_c',
      'node_a',
    ]);
  });
});
