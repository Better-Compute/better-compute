import type { Clock, SqlTx } from '@better-compute/core';
import type { RevocationSet } from './revocation.js';

/**
 * Feeds a process's `RevocationSet` from Postgres, the truth (`node_certs.revoked_at`), so every
 * revocation path — `nodes.revokeIdentity`, node delete, a reclaim, metal retire, a dedicated-root
 * lease — reaches every gateway replica without each path remembering to publish (PLAN.md §13:
 * "a revoked node disconnects within 5 s"). Each gateway runs its own feed; the gateway already
 * closes the live session of a serial the set learns about.
 *
 * On start it loads every revoked certificate that has not expired yet (the set a restarted process
 * needs); after that it re-reads a window of `lookbackMs` before the newest revocation it saw, every
 * `intervalMs`, so transactions that commit out of `compute_now()` order are still caught.
 * `RevocationSet.add` is idempotent, so the overlap costs nothing.
 */
export interface RevocationFeedOptions {
  /** The compute database (an executor; each poll is one statement). */
  sql: Pick<SqlTx, 'query'>;
  revocations: RevocationSet;
  clock?: Clock;
  /** Poll period (default 1 000 ms). */
  intervalMs?: number;
  /** Re-read window before the newest revocation seen (default 60 000 ms). */
  lookbackMs?: number;
  /** Called with poll failures; the feed keeps polling. */
  onError?(error: unknown): void;
  /** Called after a poll that learned something new. */
  onRevoked?(entries: readonly { serial: string; nodeId: string; reason?: string }[]): void;
}

export interface RevocationFeed {
  start(): void;
  stop(): void;
  /** One poll now; answers how many serials were new to the set. */
  poll(): Promise<number>;
  /** Polls failed in a row (0 when healthy): a gauge for the gateway collector. */
  readonly consecutiveFailures: number;
}

interface RevokedRow {
  serial: string;
  node_id: string;
  revoked_at: Date | string;
  not_after: Date | string;
  revocation_reason: string | null;
}

const ms = (value: Date | string) => (value instanceof Date ? value : new Date(value)).getTime();

export function createRevocationFeed(options: RevocationFeedOptions): RevocationFeed {
  const intervalMs = options.intervalMs ?? 1_000;
  const lookbackMs = options.lookbackMs ?? 60_000;
  let newest: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let inFlight: Promise<number> | undefined;

  async function pollOnce(): Promise<number> {
    const { rows } =
      newest === undefined
        ? await options.sql.query<RevokedRow>(
            `SELECT serial, node_id, revoked_at, not_after, revocation_reason FROM node_certs
              WHERE revoked_at IS NOT NULL AND not_after > compute_now()`,
          )
        : await options.sql.query<RevokedRow>(
            `SELECT serial, node_id, revoked_at, not_after, revocation_reason FROM node_certs
              WHERE revoked_at >= $1 AND not_after > compute_now()`,
            [new Date(newest - lookbackMs)],
          );
    const learned: { serial: string; nodeId: string; reason?: string }[] = [];
    let latest = newest ?? 0;
    for (const row of rows) {
      const at = ms(row.revoked_at);
      if (at > latest) latest = at;
      const added = options.revocations.add(row.serial, {
        at,
        notAfter: ms(row.not_after),
        ...(row.revocation_reason ? { reason: row.revocation_reason } : {}),
      });
      if (added)
        learned.push({
          serial: row.serial,
          nodeId: row.node_id,
          ...(row.revocation_reason ? { reason: row.revocation_reason } : {}),
        });
    }
    // First poll with nothing revoked: start the window at "now" by the database's own clock.
    if (newest === undefined && rows.length === 0) {
      const now = await options.sql.query<{ now: Date | string }>('SELECT compute_now() AS now');
      latest = ms(now.rows[0]!.now);
    }
    newest = latest;
    options.revocations.prune(options.clock?.now() ?? Date.now());
    if (learned.length > 0) options.onRevoked?.(learned);
    return learned.length;
  }

  const poll = () => (inFlight ??= pollOnce().finally(() => (inFlight = undefined)));

  let failures = 0;
  const tick = () =>
    poll().then(
      () => {
        failures = 0;
      },
      (error: unknown) => {
        failures++;
        options.onError?.(error);
      },
    );

  function schedule() {
    if (!running) return;
    // A lapse never stops the gateway: after repeated failures poll every 5 s until one succeeds.
    const delay = failures >= 3 ? Math.max(intervalMs, 5_000) : intervalMs;
    timer = setTimeout(() => void tick().finally(schedule), delay);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    get consecutiveFailures() {
      return failures;
    },
    start() {
      if (running) return;
      running = true;
      void tick().finally(schedule);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    poll,
  };
}
