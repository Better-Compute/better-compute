import { describe, expect, it } from 'vitest';
import { HOUR, type CapacityNode, type CapacitySnapshot, type Reservation } from '@/lib/data/capacity';
import { diagnoseWait, timelineReach } from '@/components/capacity/diagnose';

// "Why is it waiting" over a hand-built pool: two 8-GPU nodes, one tenant with a GPU quota.
const NOW = Date.UTC(2026, 8, 23, 14, 0);

function reservation(id: string, over: Partial<Reservation> & { gpus?: number; nodes?: number; atoms?: string[] }): Reservation {
  const { gpus = 8, nodes, atoms, ...rest } = over;
  return {
    id,
    tenantId: 'acme',
    poolId: 'p1',
    state: 'pending',
    request: { poolId: 'p1', devices: [{ class: 'gpu', count: gpus }], duration: '4h', ...(nodes ? { gang: { size: nodes } } : {}) },
    during: { start: NOW + HOUR, end: NOW + 5 * HOUR },
    ownerIdentityId: 'u1',
    idempotencyKey: id,
    conditions: [],
    version: 1,
    ...(atoms ? { atoms, nodeIds: [...new Set(atoms.map((atom) => atom.split('/')[0]!))] } : {}),
    ...rest,
  } as Reservation;
}

const busy = (id: string, node: string, count: number, from = 0) =>
  reservation(id, { state: 'active', tenantId: 'other', gpus: count, during: { start: NOW - HOUR, end: NOW + 10 * HOUR }, atoms: Array.from({ length: count }, (_, i) => `${node}/gpu${from + i}`) });

function snapshot(reservations: Reservation[], opts: { quota?: number; used?: number; nodes?: CapacityNode[] } = {}): CapacitySnapshot {
  return {
    now: NOW,
    tenantId: 'admin',
    reservations,
    quotas: [{ tenantId: 'acme', poolId: 'p1', resource: 'gpu', max: opts.quota ?? 32, used: opts.used ?? 0 }],
    nodes: opts.nodes ?? [
      { id: 'n1', poolId: 'p1', gpus: 8, health: 'ok' },
      { id: 'n2', poolId: 'p1', gpus: 8, health: 'ok' },
    ],
  } as unknown as CapacitySnapshot;
}

const verdicts = (d: ReturnType<typeof diagnoseWait>) => Object.fromEntries(d.checks.map((check) => [check.id, check.verdict]));

describe('diagnoseWait', () => {
  it('passes everything when the window is free', () => {
    const d = diagnoseWait(reservation('r', {}), snapshot([]));
    expect(d.cause).toBeUndefined();
    expect(verdicts(d)).toEqual({ quota: 'ok', shape: 'ok', service: 'ok', capacity: 'ok', fragmentation: 'ok' });
  });

  it('puts a missing confirmation before everything else', () => {
    const d = diagnoseWait(reservation('r', { state: 'awaiting-confirmation' }), snapshot([], { quota: 0 }));
    expect(d.cause?.id).toBe('confirmation');
  });

  it('never blames quota: a waiting reservation was charged at create', () => {
    // Live: used already includes its own 8 GPUs, so available is 0; that is not why it waits.
    const d = diagnoseWait(reservation('r', {}), snapshot([], { quota: 16, used: 16 }));
    expect(d.cause).toBeUndefined();
    expect(d.checks.find((check) => check.id === 'quota')?.verdict).toBe('ok');
  });

  it('sizes a whole-node request by the pool’s nodes', () => {
    const whole = reservation('r', { request: { poolId: 'p1', devices: [{ class: 'node', count: 1 }], duration: '4h' } });
    const nodes: CapacityNode[] = [
      { id: 'n1', poolId: 'p1', gpus: 4, health: 'ok' },
      { id: 'n2', poolId: 'p1', gpus: 4, health: 'ok' },
    ];
    const d = diagnoseWait(whole, snapshot([busy('a', 'n2', 4)], { nodes }));
    expect(d.needed).toEqual({ gpus: 4, perNode: 4, nodes: 1 });
    expect(d.cause).toBeUndefined();
  });

  it('loads timelines through the wanted window', () => {
    const hour = NOW;
    expect(timelineReach(hour, [])).toBe(hour + 7 * 24 * HOUR);
    // Rounded up to the hour, plus a day to search for a later fit.
    expect(timelineReach(hour, [NOW + 10 * 24 * HOUR + 1])).toBe(NOW + 11 * 24 * HOUR + HOUR);
    expect(timelineReach(hour, [NOW + 90 * 24 * HOUR])).toBe(hour + 30 * 24 * HOUR);
  });

  it("doesn't pass a window the timeline only half covers", () => {
    const timeline = {
      poolId: 'p1',
      allocatable: 16,
      buckets: Array.from({ length: 3 }, (_, i) => ({ start: NOW + i * HOUR, end: NOW + (i + 1) * HOUR, booked: 0, free: 16 })),
    };
    const d = diagnoseWait(reservation('r', {}), snapshot([], { nodes: [] }), timeline);
    expect(d.checks.find((check) => check.id === 'capacity')?.verdict).toBe('unknown');
  });

  it('says a shape can never fit', () => {
    const d = diagnoseWait(reservation('r', { gpus: 8, nodes: 3 }), snapshot([]));
    expect(d.cause?.id).toBe('shape');
  });

  it('counts nodes out of service', () => {
    const d = diagnoseWait(
      reservation('r', { gpus: 8, nodes: 2 }),
      snapshot([], { nodes: [{ id: 'n1', poolId: 'p1', gpus: 8, health: 'ok' }, { id: 'n2', poolId: 'p1', gpus: 8, health: 'maintenance' }] }),
    );
    expect(d.cause?.id).toBe('service');
  });

  it('tells scattered free GPUs from too few', () => {
    const scattered = diagnoseWait(reservation('r', { gpus: 8 }), snapshot([busy('a', 'n1', 4), busy('b', 'n2', 4)]));
    expect(scattered.cause?.id).toBe('fragmentation');
    expect(scattered.blockers.map((b) => b.reservation.id).sort()).toEqual(['a', 'b']);

    const full = diagnoseWait(reservation('r', { gpus: 8 }), snapshot([busy('a', 'n1', 8), busy('b', 'n2', 4)]));
    expect(full.cause?.id).toBe('capacity');
  });

  it('ignores itself and bookings outside the window', () => {
    const later = reservation('late', { state: 'placed', tenantId: 'other', during: { start: NOW + 6 * HOUR, end: NOW + 8 * HOUR }, atoms: ['n1/gpu0'] });
    const self = reservation('r', { atoms: ['n1/gpu1'] });
    const d = diagnoseWait(self, snapshot([self, later]));
    expect(d.cause).toBeUndefined();
    expect(d.blockers).toEqual([]);
  });

  it('checks a pending reservation at its requested start, not now', () => {
    // Busy until NOW + 10 h; the reservation (no window yet) asks to start at NOW + 12 h.
    const wants = reservation('r', { during: undefined, request: { poolId: 'p1', devices: [{ class: 'gpu', count: 8 }], duration: '4h', start: NOW + 12 * HOUR } });
    const d = diagnoseWait(wants, snapshot([busy('a', 'n1', 8), busy('b', 'n2', 8)]));
    expect(d.window.start).toBe(NOW + 12 * HOUR);
    expect(d.cause).toBeUndefined();
  });

  it('falls back to the timeline without nodes', () => {
    const timeline = {
      poolId: 'p1',
      allocatable: 16,
      buckets: Array.from({ length: 24 }, (_, i) => ({ start: NOW + i * HOUR, end: NOW + (i + 1) * HOUR, booked: i < 6 ? 12 : 0, free: i < 6 ? 4 : 16 })),
    };
    const d = diagnoseWait(reservation('r', {}), snapshot([], { nodes: [] }), timeline);
    expect(d.cause?.id).toBe('capacity');
    expect(d.fitsAt).toBe(NOW + 6 * HOUR);
  });
});
