import { describe, expect, it } from 'vitest';
import { createRealtimeFleet } from '@better-compute/testing';

// The v0.4 claims on the reference store (PLAN.md §16): the real-time spine against a real Postgres, where the
// single-process PGlite runs saturate (bench/realtime-spine). Skipped until a disposable database is given:
//
//   BETTER_COMPUTE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/rt_pg pnpm bench:scale
//
// The fleet migrates the database, so point it at an empty one. The full runs are realtime-spine and
// realtime-fleet with the same variable; this target only proves the wiring end to end on Postgres.

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;

describe.skipIf(!postgresUrl)('postgres spine (needs BETTER_COMPUTE_POSTGRES_URL)', () => {
  it('joins, adopts and activates reservations on Postgres', async () => {
    const fleet = await createRealtimeFleet({ postgresUrl: postgresUrl! });
    try {
      const joined = await fleet.join(20, { timeoutMs: 5 * 60_000 });
      expect(joined.missing).toEqual([]);
      const placed = await fleet.place(20, { ratePerSecond: 10, timeoutMs: 5 * 60_000 });
      expect(placed.missing).toEqual([]);
      console.log(JSON.stringify({ adopted: joined.adopted, active: placed.active }));
    } finally {
      await fleet.close();
    }
  });
});
