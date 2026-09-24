import type { Clock, Finding, Logger, SqlTx } from '@better-compute/core';

// The one clock (PLAN.md §8.4, P9). TypeScript business time is anchored to compute_now(): the
// default clock is the process clock plus an offset sampled from the database at every lease
// renewal. A process whose clock differs from the database's by more than a second raises
// ClockSkew (a warning in the log and a selfCheck finding). Tests pass the sim clock, which moves
// with compute_sim_clock, so its samples always agree.

/** Beyond this difference between the process and `compute_now()`, the process has ClockSkew. */
export const clockSkewThresholdMs = 1_000;
/** Samples whose round trip took longer than this are too uncertain to judge skew by. */
const maxSampleRoundTripMs = 2_000;

/** The default clock: `Date.now()` plus the offset to `compute_now()` last sampled. */
export interface AnchoredClock extends Clock {
  readonly anchored: true;
  /** `compute_now()` minus the process clock, as last sampled (0 before the first sample). */
  offsetMs(): number;
  /** Whether a sample has anchored it yet. */
  sampled(): boolean;
  /** Re-anchors to a database time read between `sentAt` and `receivedAt` (process clock). */
  anchor(databaseNowMs: number, sentAt: number, receivedAt: number): void;
}

/** A clock anchored to `compute_now()`; until the first sample it reads the process clock. */
export function anchoredClock(): AnchoredClock {
  let offset = 0;
  let sampled = false;
  return {
    anchored: true,
    now: () => Date.now() + offset,
    offsetMs: () => offset,
    sampled: () => sampled,
    anchor(databaseNowMs, sentAt, receivedAt) {
      offset = Math.round(databaseNowMs - (sentAt + receivedAt) / 2);
      sampled = true;
    },
  };
}

export function isAnchoredClock(clock: Clock): clock is AnchoredClock {
  return (clock as Partial<AnchoredClock>).anchored === true;
}

/** Watches the business clock against `compute_now()` and keeps an anchored clock anchored. */
export interface ClockMonitor {
  /** The time source to bracket a database read with (the process clock for an anchored clock). */
  local(): number;
  /** Records one `compute_now()` reading taken between `sentAt` and `receivedAt` (from `local()`). */
  observe(databaseNowMs: number, sentAt: number, receivedAt: number): void;
  /** Reads `compute_now()` once and observes it. */
  sample(sql: SqlTx): Promise<void>;
  /** How far the process clock is from `compute_now()` as last judged, when it was judged. */
  skewMs(): number | undefined;
  findings(): Finding[];
}

export function createClockMonitor(clock: Clock, log: Logger): ClockMonitor {
  const anchored = isAnchoredClock(clock) ? clock : undefined;
  let skew: number | undefined;
  let skewed = false;

  const local = anchored ? () => Date.now() : () => clock.now();

  function observe(databaseNowMs: number, sentAt: number, receivedAt: number): void {
    if (!Number.isFinite(databaseNowMs)) return;
    const roundTrip = receivedAt - sentAt;
    if (anchored && (roundTrip <= maxSampleRoundTripMs || !anchored.sampled()))
      anchored.anchor(databaseNowMs, sentAt, receivedAt);
    if (roundTrip > maxSampleRoundTripMs) return;
    skew = anchored
      ? Math.abs(anchored.offsetMs())
      : Math.abs(databaseNowMs - (sentAt + receivedAt) / 2);
    if (skew > clockSkewThresholdMs && !skewed) {
      skewed = true;
      log.warn('ClockSkew: this process disagrees with compute_now()', {
        condition: 'ClockSkew',
        skewMs: Math.round(skew),
      });
    } else if (skew <= clockSkewThresholdMs && skewed) {
      skewed = false;
      log.info('ClockSkew cleared', { condition: 'ClockSkew', skewMs: Math.round(skew) });
    }
  }

  return {
    local,
    observe,
    async sample(sql) {
      const sentAt = local();
      const { rows } = await sql.query<{ now: Date }>('SELECT compute_now() AS now');
      const receivedAt = local();
      const now = rows[0]?.now;
      if (now instanceof Date) observe(now.getTime(), sentAt, receivedAt);
    },
    skewMs: () => skew,
    findings: () =>
      skewed && skew !== undefined
        ? [
            {
              check: 'clock.skew',
              severity: 'warning',
              message: `ClockSkew: this process's clock differs from compute_now() by ${Math.round(skew)} ms`,
              fix: anchored
                ? 'Synchronize the host clock (NTP); business time stays anchored to the database, but ids and logs use the host clock'
                : 'The configured clock does not follow compute_now(); pass the sim clock only with the sim compute_now(), or omit clock',
            },
          ]
        : [],
  };
}
