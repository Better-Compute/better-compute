import { describe, expect, it } from 'vitest';
import { fleetAttention } from '@/components/fleet/attention';
import { watchBatch, watchNode, watchRollout, watchSandbox } from '@/components/fleet/watch';
import { applyActions, fleetActions, storeState } from '@/components/fleet/store';
import { gpuHolders } from '@/lib/data/capacity';
import { eventsBetween, rolloutNodeStates, scopeFleet, simulateFleet, type NodeInfo } from '@/lib/data/fleet';
import { nodeHealth } from '@/lib/data/fleet-health';
import { liveHealth, liveSnapshot } from '@/lib/data/fleet-live';
import { poolPulse } from '@/lib/data/platform';
import { pools, sites } from '@/lib/data/topology';

// The fleet simulation's invariants (it must agree with the Overview, capacity and itself), the live mapping and
// the attention feed. Every call passes its own clock: nothing here reads the wall clock.

const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);

describe('simulateFleet', () => {
  const snapshot = simulateFleet(T0);

  it('is deterministic in (now, seed)', () => {
    const again = simulateFleet(T0, 'better-compute');
    expect(JSON.stringify(again)).toBe(JSON.stringify(snapshot));
    expect(JSON.stringify(simulateFleet(T0 + 60_000))).not.toBe(JSON.stringify(snapshot));
  });

  it('has every topology node once, with unique ids and hostnames', () => {
    expect(snapshot.nodes).toHaveLength(pools.reduce((sum, pool) => sum + pool.nodes, 0));
    expect(new Set(snapshot.nodes.map((node) => node.id)).size).toBe(snapshot.nodes.length);
    expect(new Set(snapshot.nodes.map((node) => node.hostname)).size).toBe(snapshot.nodes.length);
    for (const pool of pools) {
      const members = snapshot.nodes.filter((node) => node.poolId === pool.id);
      expect(members).toHaveLength(pool.nodes);
      for (const node of members) expect(node.gpus).toHaveLength(pool.kind === 'gpu' ? pool.gpusPerNode : 0);
    }
  });

  it('agrees with poolPulse and the shared health decision', () => {
    for (const pool of pools) {
      const pulse = poolPulse(pool, T0);
      const members = snapshot.nodes.filter((node) => node.poolId === pool.id);
      for (const state of ['offline', 'degraded', 'provisioning'] as const)
        expect(members.filter((node) => node.health === state), `${pool.id} ${state}`).toHaveLength(pulse.nodes[state]);
      for (const node of members) expect(node.health).toBe(nodeHealth(node.id, T0, node.unit)!.health);
    }
  });

  it('takes GPU bookings from capacity, never on an unhealthy GPU', () => {
    const holders = gpuHolders(T0);
    for (const node of snapshot.nodes)
      for (const gpu of node.gpus) {
        const holder = holders.get(`${node.id}/gpu${gpu.index}`);
        if (!gpu.healthy) expect(gpu.allocation).toBeUndefined();
        else expect(gpu.allocation?.reservationId).toBe(holder?.reservationId);
      }
  });

  it('marks offline nodes unreachable and gives them no telemetry', () => {
    for (const node of snapshot.nodes.filter((each) => each.health === 'offline')) {
      expect(node.connectivity).not.toBe('connected');
      expect(node.conditions.some((condition) => condition.type === 'NodeUnreachable')).toBe(true);
      expect(node.gpus.every((gpu) => gpu.telemetry === undefined)).toBe(true);
    }
  });

  it('keeps rollout and batch counts consistent with their members', () => {
    for (const rollout of snapshot.rollouts) {
      const total = rolloutNodeStates.reduce((sum, state) => sum + rollout.nodes[state], 0);
      expect(total).toBe(rollout.nodeList.length);
    }
    for (const batch of snapshot.batches) {
      expect(Object.values(batch.commands).reduce((sum, count) => sum + count, 0)).toBe(batch.members.length);
      expect(batch.scopeSize).toBe(batch.members.length);
    }
  });

  it('scopes to one site', () => {
    const site = sites[0]!;
    const scoped = scopeFleet(snapshot, site.id);
    expect(scoped.nodes.length).toBeGreaterThan(0);
    expect(scoped.nodes.every((node) => node.siteId === site.id)).toBe(true);
    expect(scoped.incidents.every((incident) => incident.siteId === site.id)).toBe(true);
  });
});

describe('eventsBetween', () => {
  const snapshot = simulateFleet(T0);

  it('re-reads the same events for any split of a window, oldest first, no duplicates', () => {
    const whole = eventsBetween(snapshot, T0 - 600_000, T0, 5_000);
    const halves = [...eventsBetween(snapshot, T0 - 600_000, T0 - 300_000, 5_000), ...eventsBetween(snapshot, T0 - 300_000, T0, 5_000)];
    expect(halves.map((event) => event.id)).toEqual(whole.map((event) => event.id));
    expect(new Set(whole.map((event) => event.id)).size).toBe(whole.length);
    const times = whole.map((event) => Date.parse(event.time));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times.every((t) => t > T0 - 600_000 && t <= T0)).toBe(true);
  });
});

describe('applyActions', () => {
  it('cordons from the moment of the action, and not in views of earlier moments', () => {
    const node = simulateFleet(T0).nodes.find((each) => !each.cordoned && each.health === 'ready')!;
    fleetActions.cordon([node.id], T0 + 1_000, 'test');
    const after = applyActions(simulateFleet(T0 + 2_000), storeState()).nodes.find((each) => each.id === node.id)!;
    expect(after.cordoned).toBe(true);
    expect(after.noScheduleReasons).toContain('cordoned');
    const before = applyActions(simulateFleet(T0), storeState()).nodes.find((each) => each.id === node.id)!;
    expect(before.cordoned).toBe(false);
  });
});
describe('liveSnapshot', () => {
  const base: NodeInfo = {
    id: 'node_live_1',
    siteId: 'site_a',
    poolId: 'pool_a',
    ownerTenantId: 'ten_root',
    role: 'dedicated',
    provisionState: 'deployed',
    maintenance: false,
    cordoned: false,
    connectivity: 'connected',
    trust: 'platform',
    noScheduleReasons: [],
    hardwareKeyTrusted: true,
    generation: 3,
    observedGeneration: 3,
    identityGeneration: 1,
    version: 7,
  };

  it('buckets health like fleet-health', () => {
    expect(liveHealth(base)).toBe('ready');
    expect(liveHealth({ ...base, connectivity: 'unreachable' })).toBe('offline');
    expect(liveHealth({ ...base, provisionState: 'commissioning' })).toBe('provisioning');
    expect(liveHealth({ ...base, noScheduleReasons: ['Xid79'] })).toBe('degraded');
    expect(liveHealth({ ...base, cordoned: true, noScheduleReasons: ['cordoned', 'taint:x'] })).toBe('ready');
  });

  it('maps list rows without inventing data, and turns NoSchedule reasons into incidents', () => {
    const snapshot = liveSnapshot({ tenantId: 'ten_root', nodes: [base, { ...base, id: 'node_live_2', noScheduleReasons: ['Xid79', 'taint:gpu'] }] }, T0);
    expect(snapshot.simulated).toBe(false);
    expect(snapshot.nodes[0]!.gpus).toEqual([]);
    expect(snapshot.nodes[1]!.conditions.map((condition) => condition.type)).toEqual(['Xid79']);
    expect(snapshot.incidents.map((incident) => incident.nodeId)).toEqual(['node_live_2']);
  });
});

describe('fleetAttention', () => {
  it('gives each node at most one item, caps node items at ten plus a "more" item, and has unique ids', () => {
    const items = fleetAttention(T0);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    const nodeItems = items.filter((item) => item.subject.startsWith('node/'));
    expect(new Set(nodeItems.map((item) => item.subject)).size).toBe(nodeItems.length);
    expect(nodeItems.length).toBeLessThanOrEqual(10);
    expect(items.every((item) => item.source === 'fleet' && item.href.startsWith('/'))).toBe(true);
  });

  it('shows nothing in live mode until the poller has an answer', () => {
    expect(fleetAttention(T0, {}, { source: 'live' })).toEqual([]);
  });
});

describe('watch describers', () => {
  const snapshot = simulateFleet(T0);
  const sim = { source: 'simulated' as const };

  it('describes nodes by health', () => {
    const offline = snapshot.nodes.find((node) => node.health === 'offline')!;
    expect(watchNode(offline.id, T0, sim)!.status).toBe('crit');
    const ready = snapshot.nodes.find((node) => node.health === 'ready' && !node.cordoned && !node.conditions.some((c) => c.status === 'true' && c.type !== 'DaemonOutdated' && c.type !== 'RebootRequired' && c.type !== 'CertExpiring'))!;
    const state = watchNode(ready.id, T0, sim)!;
    expect(state.status).toBe('ok');
    expect(state.summary).toMatch(/^ready/);
    expect(state.href).toBe(`/nodes/${ready.id}`);
    expect(watchNode('n-nowhere-000', T0, sim)).toBeNull();
  });

  it('describes sandboxes, rollouts and batches', () => {
    expect(watchSandbox('sbx_gone', T0, sim)!.status).toBe('off');
    const live = snapshot.sandboxes.find((sandbox) => sandbox.state === 'ready' && sandbox.expiresAt - T0 > 10 * 60_000)!;
    expect(watchSandbox(live.id, T0, sim)!.status).toBe('live');
    const running = snapshot.rollouts.find((rollout) => rollout.state === 'running' || rollout.state === 'paused')!;
    expect(watchRollout(running.id, T0, sim)!.summary).toContain(`wave ${running.wave + 1}/`);
    const pending = snapshot.batches.find((batch) => batch.state === 'pending')!;
    expect(watchBatch(pending.batchId, T0, sim)!.status).toBe('pending');
  });

  it('returns nothing in live mode before the poller has answered', () => {
    expect(watchNode(snapshot.nodes[0]!.id, T0, { source: 'live' })).toBeNull();
  });
});