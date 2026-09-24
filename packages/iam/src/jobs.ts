// better-iam's scheduler jobs, run by compute's worker role `iam` (PLAN.md §12.1 supported topology): in
// embedded mode compute's processes are the only IAM hosts on the IAM database, so someone has to dispatch
// audit hooks, the auth outbox, budget alerts, period closes and the retention sweep. Each job is a
// singleton (`shardBy: 'none'`) periodic reconciler, so one worker runs it at a time.

import type { Duration, Reconciler } from '@better-compute/core';

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

export interface IamJob {
  name: string;
  every: Duration;
  /** Resolves true when the job wants to run again right away (a full batch, a truncated sweep). */
  run(host: IamJobsHost): Promise<boolean>;
}

/**
 * The schedule: audit hooks every second (the inbox's latency floor; better-iam's console dispatches at the
 * same rate), the auth outbox every 5 s, budgets hourly, the period close and the sweep daily/hourly. The
 * usage flush (`iam.usage`, hourly) runs before the daily close, so windows land in the right period.
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
    every: '1d',
    run: async (host) => {
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
}

/** The `iamJobs` as singleton periodic reconcilers (key `run`). */
export function iamJobReconcilers(
  host: IamJobsHost,
  options: IamJobReconcilerOptions = {},
): Reconciler[] {
  return iamJobs
    .filter((job) => options.only === undefined || options.only.includes(job.name))
    .map(
      (job): Reconciler => ({
        name: job.name,
        shardBy: 'none',
        periodic: [{ key: 'run', every: job.every }],
        async run() {
          try {
            return (await job.run(host)) ? 'SYNC_AGAIN' : 'DONE';
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
