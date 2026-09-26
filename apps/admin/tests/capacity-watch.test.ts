import { describe, expect, it } from 'vitest';
import { capacityAt } from '@/lib/data/capacity';
import { watchPool, watchReservation, watchTenant } from '@/components/capacity/watch';

// The watch describers over the shared simulation, at a fixed clock.
const NOW = Date.UTC(2026, 8, 23, 14, 7);
const sim = { source: 'simulated' as const };

describe('capacity watch describers', () => {
  const snapshot = capacityAt(NOW);

  it('describes a pool with its booked share, free GPUs and waiting work', () => {
    const state = watchPool('pool_h100_fra1', NOW, sim)!;
    expect(state.label).toBe('H100 training');
    expect(state.summary).toMatch(/^\d+% booked · \d+ free · \d+ waiting/);
    expect(['ok', 'warn', 'crit', 'pending']).toContain(state.status);
    expect(state.href).toBe('/pools/pool_h100_fra1');
    expect(watchPool('nope', NOW, sim)?.status).toBe('off');
  });

  it('tracks a reservation through its states', () => {
    const active = snapshot.reservations.find((r) => r.state === 'active' && !r.conditions.length)!;
    expect(watchReservation(active.id, NOW, sim)).toMatchObject({ status: 'live' });
    const placed = snapshot.reservations.find((r) => r.state === 'placed')!;
    expect(watchReservation(placed.id, NOW, sim)?.summary).toMatch(/^placed · starts \d\d:\d\d UTC$/);
    const released = snapshot.reservations.find((r) => r.state === 'released')!;
    expect(watchReservation(released.id, NOW, sim)?.status).toBe('off');
    expect(watchReservation('rsv_missing', NOW, sim)?.summary).toMatch(/^gone/);
  });

  it('summarises a tenant and flags a full quota', () => {
    const state = watchTenant('ten_aurora', NOW, sim)!;
    expect(state.label).toBe('Aurora Labs');
    expect(state.summary).toMatch(/GPUs now · \d+ waiting/);
    expect(watchTenant('ten_nobody', NOW, sim)?.status).toBe('off');
  });

  it('answers nothing in live mode before the first live load', () => {
    expect(watchPool('pool_h100_fra1', NOW, { source: 'live' })).toBeNull();
  });
});
