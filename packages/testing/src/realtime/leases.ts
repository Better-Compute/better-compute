// A probe of the `leases` table (PLAN.md §8.5): how late renewals come, when leases lapse while owned, and who
// takes them over. Built to verify the runtime's lease renewal under saturation: a renewal that comes later than
// the TTL lets another worker take the lease, and the owner's fenced transactions then fail.

import type { SqlExecutor } from '@better-compute/core';
import { summarize, type LatencySummary } from './harness.js';

export interface LeaseProbeOptions {
  /** How often the table is sampled (default 100 ms); it bounds the resolution. */
  intervalMs?: number;
  /** A `LIKE` pattern over lease names (default every lease). */
  names?: string;
}

export interface LeaseTakeover {
  name: string;
  from: string | null;
  to: string | null;
  at: number;
}

export interface LeaseProbeResult {
  samples: number;
  /** Renewals observed: an owner's `expires_at` moved forward under the same epoch. */
  renewals: number;
  /** Time between an owner's successive renewals of one lease (sampling resolution included). */
  gapMs: LatencySummary;
  /** The least time left before expiry at any renewal: how close the lease came to lapsing. */
  minHeadroomMs: number;
  /** Times an owned lease was seen expired (each episode counted once). */
  lapses: number;
  takeovers: LeaseTakeover[];
}

export interface LeaseProbe {
  stop(): Promise<LeaseProbeResult>;
}

interface Seen {
  owner: string | null;
  epoch: number;
  expires: number;
  renewedAt: number;
  lapsed: boolean;
}

/** Samples `leases` until `stop()`; timings come from the database's own clock (`compute_now()`). */
export function probeLeases(
  database: Pick<SqlExecutor, 'query'>,
  options: LeaseProbeOptions = {},
): LeaseProbe {
  const intervalMs = options.intervalMs ?? 100;
  const seen = new Map<string, Seen>();
  const gaps: number[] = [];
  const takeovers: LeaseTakeover[] = [];
  let samples = 0;
  let renewals = 0;
  let lapses = 0;
  let minHeadroomMs = Infinity;
  let running = true;

  const sample = async () => {
    const { rows } = await database.query<{
      name: string;
      owner: string | null;
      epoch: string | number;
      expires_ms: number | null;
      now_ms: number;
    }>(
      `SELECT name, owner, epoch,
              CASE WHEN expires_at = '-infinity' THEN NULL ELSE extract(epoch FROM expires_at) * 1000 END AS expires_ms,
              extract(epoch FROM compute_now()) * 1000 AS now_ms
         FROM leases WHERE name LIKE $1`,
      [options.names ?? '%'],
    );
    samples++;
    for (const row of rows) {
      const now = Number(row.now_ms);
      const expires = row.expires_ms === null ? -Infinity : Number(row.expires_ms);
      const epoch = Number(row.epoch);
      const last = seen.get(row.name);
      if (!last) {
        seen.set(row.name, { owner: row.owner, epoch, expires, renewedAt: now, lapsed: false });
        continue;
      }
      if (row.owner !== last.owner || epoch !== last.epoch) {
        takeovers.push({ name: row.name, from: last.owner, to: row.owner, at: now });
        seen.set(row.name, { owner: row.owner, epoch, expires, renewedAt: now, lapsed: false });
        continue;
      }
      if (row.owner !== null && expires > last.expires) {
        renewals++;
        gaps.push(now - last.renewedAt);
        // At this renewal the previous expiry was this far away: the margin the renewal had.
        minHeadroomMs = Math.min(minHeadroomMs, last.expires - now);
        last.expires = expires;
        last.renewedAt = now;
        last.lapsed = false;
      } else if (row.owner !== null && expires <= now && !last.lapsed) {
        lapses++;
        last.lapsed = true;
      }
    }
  };
  const loop = (async () => {
    while (running) {
      try {
        await sample();
      } catch {
        // A busy or closing store: skip the sample.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
      return {
        samples,
        renewals,
        gapMs: summarize(gaps),
        minHeadroomMs: Number.isFinite(minHeadroomMs) ? minHeadroomMs : 0,
        lapses,
        takeovers,
      };
    },
  };
}
