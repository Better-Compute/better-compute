import { describe, expect, it } from 'vitest';
import {
  createSimCapacitySource,
  HOUR,
  insightsFrom,
  liveStates,
  reservationGpus,
  rowFree,
  type CapacitySnapshot,
} from '@/lib/data/capacity';
import { leastDisruptiveNodes } from '@/components/capacity/scenarios';

// Invariants of the simulated capacity source: what every capacity view relies on. The clock is injected, so
// the tests never depend on the wall clock.
const NOW = Date.UTC(2026, 8, 23, 14, 7);

function simAt(now: number, seed = 0x5eed) {
  let clock = now;
  const source = createSimCapacitySource({ seed, now: () => clock });
  return { source, snapshot: () => source.snapshot(), setNow: (t: number) => (clock = t) };
}

describe('simulated capacity source', () => {
  const { source, snapshot } = simAt(NOW);
  const snap: CapacitySnapshot = snapshot();

  it('is deterministic for a seed and a clock', () => {
    const other = simAt(NOW).snapshot();
    expect(other.summary).toEqual(snap.summary);
    expect(other.reservations.length).toBe(snap.reservations.length);
    expect(other.reservations.slice(0, 50).map((r) => [r.id, r.state])).toEqual(snap.reservations.slice(0, 50).map((r) => [r.id, r.state]));
  });

  it('keeps the rollup arithmetic of the API', () => {
    for (const pool of snap.summary.pools) {
      for (const row of pool.capacity) {
        expect(row.allocatable).toBeLessThanOrEqual(row.total);
        expect(row.allocated).toBeGreaterThanOrEqual(0);
        expect(row.available).toBe(Math.max(0, row.allocatable - row.allocated - row.reserved));
        const { freeNow, utilization } = rowFree(row);
        expect(freeNow).toBeLessThanOrEqual(row.allocatable);
        expect(utilization).toBeGreaterThanOrEqual(0);
        expect(utilization).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never has one GPU held by two live reservations at the same time', () => {
    const held = new Map<string, string>();
    for (const r of snap.reservations) {
      if (!r.during || !liveStates.has(r.state) || r.during.start > NOW || r.during.end <= NOW) continue;
      for (const atom of r.atoms ?? []) {
        expect(held.get(atom), `${atom} held by ${held.get(atom)} and ${r.id}`).toBeUndefined();
        held.set(atom, r.id);
      }
    }
    expect(held.size).toBeGreaterThan(100);
  });

  it('counts free GPUs only on schedulable nodes', () => {
    for (const pool of snap.summary.pools) {
      const row = pool.capacity.find((entry) => entry.resource === 'gpu');
      if (!row) continue;
      const okGpus = snap.nodes.filter((node) => node.poolId === pool.poolId && node.health === 'ok').reduce((sum, node) => sum + node.gpus, 0);
      expect(row.allocatable).toBe(okGpus);
      expect(row.freeNow).toBeLessThanOrEqual(okGpus);
    }
  });

  it('previews and places only on schedulable nodes, and a booking shows up placed', async () => {
    const pool = snap.summary.pools.find((entry) => entry.capacity.some((row) => row.resource === 'gpu' && (row.freeNow ?? 0) >= 16))!;
    const preview = await source.preview({ poolId: pool.poolId, gpus: 1, durationMs: 4 * HOUR });
    expect(preview.fits).toBe(true);
    for (const candidate of preview.candidates) expect(snap.nodes.find((node) => node.id === candidate.nodeId)?.health).toBe('ok');
    const created = await source.create({ poolId: pool.poolId, gpus: 1, durationMs: 4 * HOUR, start: NOW + 2 * HOUR });
    expect(created.state).toBe('placed');
    expect(created.during?.start).toBe(NOW + 2 * HOUR);
    expect(source.snapshot().reservations.some((r) => r.id === created.id)).toBe(true);
  });

  it('releases and cancels through the overlay', async () => {
    const active = source.snapshot().reservations.find((r) => r.state === 'active')!;
    const released = await source.release(active.id);
    expect(released.state).toBe('released');
    const placed = source.snapshot().reservations.find((r) => r.state === 'placed')!;
    expect((await source.cancel(placed.id)).state).toBe('cancelled');
  });

  it('refuses a GPU placement in a pool without GPUs', async () => {
    const cpu = snap.summary.pools.find((entry) => !entry.capacity.some((row) => row.resource === 'gpu'))!;
    const preview = await source.preview({ poolId: cpu.poolId, gpus: 1, durationMs: HOUR });
    expect(preview.fits).toBe(false);
    expect(preview.reason).toMatch(/no GPUs/);
  });

  it('usage is only for bookings that held devices, within 30 days', () => {
    const ids = new Set(snap.reservations.map((r) => `alc_${r.id.slice(4)}`));
    for (const window of snap.usage) {
      expect(window.windowEnd).toBeLessThanOrEqual(NOW);
      expect(window.windowStart).toBeGreaterThanOrEqual(NOW - 31 * 24 * HOUR);
      expect(window.quantity).toBeGreaterThanOrEqual(0);
      if (window.meter.startsWith('gpu.')) expect(ids.has(window.allocationId)).toBe(true);
    }
  });

  it('picks the least booked nodes for maintenance', () => {
    const poolId = snap.summary.pools.find((entry) => entry.capacity.some((row) => row.resource === 'gpu'))!.poolId;
    const plan = leastDisruptiveNodes(snap, poolId, 3, NOW + HOUR, NOW + 7 * HOUR);
    expect(plan.nodes).toHaveLength(3);
    for (const node of plan.nodes) expect(node.health).toBe('ok');
  });

  it('never flags pending work as unplaceable while timelines are unknown (live)', () => {
    const insights = insightsFrom(snap, () => undefined);
    expect(insights.some((insight) => insight.kind === 'unplaceable')).toBe(false);
    expect(insights.some((insight) => insight.kind === 'pool-full-soon')).toBe(false);
  });

  it('keeps reservation GPU counts consistent with their atoms', () => {
    for (const r of snap.reservations.slice(0, 500)) {
      if (!r.atoms?.length || r.request.devices[0]?.class === 'node') continue;
      expect(r.atoms.length).toBe(reservationGpus(r));
    }
  });
});

describe('review regressions', () => {
  it('gives bookings made at the same clock instant distinct ids', async () => {
    const { source, snapshot } = simAt(NOW);
    const pool = snapshot().summary.pools.find((entry) => entry.capacity.some((row) => row.resource === 'gpu' && (row.freeNow ?? 0) >= 4))!;
    const a = await source.create({ poolId: pool.poolId, gpus: 1, durationMs: HOUR, start: NOW + HOUR });
    const b = await source.create({ poolId: pool.poolId, gpus: 1, durationMs: HOUR, start: NOW + HOUR });
    expect(a.id).not.toBe(b.id);
  });

  it('queues a booking that does not fit as pending, holding nothing', async () => {
    const { source } = simAt(NOW);
    // More GPUs per node than any node has free: can't fit.
    const created = await source.create({ poolId: 'pool_h100_fra1', gpus: 8, gang: 8, durationMs: 400 * HOUR });
    const again = source.snapshot().reservations.find((r) => r.id === created.id)!;
    expect(again.state).toBe('pending');
  });

  it('refuses an extension over GPUs a later booking holds', async () => {
    const { source, snapshot } = simAt(NOW);
    // An active reservation whose atoms have a later booking right after it.
    const all = snapshot().reservations;
    const blocked = all.find((r) => {
      if (r.state !== 'active' || !r.during || !r.atoms?.length) return false;
      return all.some((o) => o.id !== r.id && (o.state === 'placed' || o.state === 'active') && o.during && o.during.start >= r.during!.end && o.during.start < r.during!.end + 48 * HOUR && o.atoms?.some((atom) => r.atoms!.includes(atom)));
    });
    expect(blocked).toBeDefined();
    await expect(source.extend(blocked!.id, 48 * HOUR)).rejects.toThrow(/Can't extend/);
  });

  it('never emits a week unit the API rejects', async () => {
    const { formatDuration } = await import('@/lib/data/capacity');
    expect(formatDuration(7 * 24 * HOUR)).toBe('7d');
    expect(formatDuration(14 * 24 * HOUR)).toBe('14d');
  });
});

describe('simulated capacity over time', () => {
  it('turns a placed reservation active once its start passes', () => {
    const { snapshot, setNow } = simAt(NOW);
    const soon = snapshot().reservations.find((r) => r.state === 'placed' && r.during && r.during.start > NOW && r.during.start < NOW + 6 * HOUR)!;
    expect(soon).toBeDefined();
    setNow(soon.during!.start + 10 * 60_000);
    expect(snapshot().reservations.find((r) => r.id === soon.id)!.state).toBe('active');
  });
});
