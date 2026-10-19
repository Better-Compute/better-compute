// better-iam's scheduler jobs, run by compute's worker role `iam` (PLAN.md §12.1 supported topology): in
// embedded mode compute's processes are the only IAM hosts on the IAM database, so someone has to dispatch
// audit hooks, the auth outbox, budget alerts, period closes and the retention sweep. Each job is a
// singleton (`shardBy: 'none'`) periodic reconciler, so one worker runs it at a time.

import { ComputeError, type Duration, type Reconciler } from '@better-compute/core';

/** The better-iam jobs compute runs; `betterIam()`'s result satisfies it. */
export interface IamJobsHost {
  events: { dispatch(): Promise<{ dispatched: number }> };
  auth: { dispatchOutbox(limit?: number): Promise<unknown> };
  billing: {
    checkBudgets(input?: { tenantId?: string }): Promise<unknown>;
    closePeriod(input?: Record<string, unknown>): Promise<unknown>;
  };
  sweepExpired(): Promise<{ truncated?: boolean } | unknown>;
}

/** When a job runs: the clock and the period-close grace (`iamJobReconcilers` passes both). */
export interface IamJobRun {
  /** Epoch ms now. Default `Date.now()`. */
  now?: number;
  /** Hours a UTC month must have run before the previous one closes (default 6). */
  closeGraceHours?: number;
}

export interface IamJob {
  name: string;
  every: Duration;
  /** Resolves true when the job wants to run again right away (a full batch, a truncated sweep). */
  run(host: IamJobsHost, at?: IamJobRun): Promise<boolean>;
}

/** D18's default: a month closes once the next one is 6 hours old, after its last windows have flushed. */
const defaultCloseGraceHours = 6;
const HOUR = 3_600_000;

/** Whether the current UTC month is at least `graceHours` old, so the previous month may close. */
function closeGraceElapsed(now: number, graceHours: number): boolean {
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return now >= monthStart + graceHours * HOUR;
}

/** Validates a `closeGraceHours` option: a number of hours from 0 to 72. */
function closeGraceHoursOf(value: unknown, where: string): number {
  if (value === undefined) return defaultCloseGraceHours;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 72)
    throw new ComputeError('INVALID_CONFIG', `${where} must be a number of hours from 0 to 72`);
  return value;
}

/**
 * The schedule: audit hooks every second (the inbox's latency floor; better-iam's console dispatches at the
 * same rate), the auth outbox every 5 s, budgets, the period close and the sweep hourly. The period close (D18)
 * calls `closePeriod()` (which closes the previous month and is harmless once it is closed) only once the current
 * UTC month is `closeGraceHours` old, so the usage flush (`iam.usage`, hourly) has landed the month's last
 * windows first.
 */
export const iamJobs: readonly IamJob[] = Object.freeze([
  {
    name: 'iam.jobs.audit-hooks',
    every: '1s',
    run: async (host) => (await host.events.dispatch()).dispatched >= 100,
  },
  {
    name: 'iam.jobs.auth-outbox',
    every: '5s',
    run: async (host) => {
      await host.auth.dispatchOutbox();
      return false;
    },
  },
  {
    name: 'iam.jobs.budgets',
    every: '1h',
    run: async (host) => {
      await host.billing.checkBudgets();
      return false;
    },
  },
  {
    name: 'iam.jobs.close-period',
    every: '1h',
    run: async (host, at = {}) => {
      if (!closeGraceElapsed(at.now ?? Date.now(), at.closeGraceHours ?? defaultCloseGraceHours))
        return false;
      await host.billing.closePeriod();
      return false;
    },
  },
  {
    name: 'iam.jobs.sweep',
    every: '1h',
    run: async (host) => {
      const result = (await host.sweepExpired()) as { truncated?: boolean } | undefined;
      return result?.truncated === true;
    },
  },
] satisfies IamJob[]);

export interface IamJobReconcilerOptions {
  /** Which jobs to run; default all of `iamJobs`. */
  only?: readonly string[];
  /** Job failures; the job returns `DONE` and runs again at its next period. Must not throw. */
  onError?(error: unknown, job: string): void;
  /**
   * Hours a UTC month must have run before `iam.jobs.close-period` closes the previous one (D18; default 6, from 0
   * to 72). Set `vps({ billing: { closeGraceHours } })` to the same value.
   */
  closeGraceHours?: number;
  /** The clock (epoch ms); default the run's `context.clock`, else `Date.now()`. */
  now?: () => number;
}

/** The `iamJobs` as singleton periodic reconcilers (key `run`). */
export function iamJobReconcilers(
  host: IamJobsHost,
  options: IamJobReconcilerOptions = {},
): Reconciler[] {
  const closeGraceHours = closeGraceHoursOf(
    options.closeGraceHours,
    'iamJobReconcilers({ closeGraceHours })',
  );
  return iamJobs
    .filter((job) => options.only === undefined || options.only.includes(job.name))
    .map(
      (job): Reconciler => ({
        name: job.name,
        shardBy: 'none',
        periodic: [{ key: 'run', every: job.every }],
        async run(context) {
          try {
            const now = options.now?.() ?? context?.clock?.now() ?? Date.now();
            return (await job.run(host, { now, closeGraceHours })) ? 'SYNC_AGAIN' : 'DONE';
          } catch (error) {
            try {
              options.onError?.(error, job.name);
            } catch {
              // Reporting must not fail the job loop.
            }
            return 'DONE';
          }
        },
      }),
    );
}
