import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineMethod, definePlugin, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, options } from './support/server.js';

// Async-with-wait (PLAN.md §9.1): a mutation whose method has `poll` and whose input asks
// `wait: { timeoutMs }` answers once its operation is done, or with the pending output at the
// timeout; without `wait` it answers at once. Registration refuses a malformed poll.

const USER = 'token-async-wait-user-0123456789';
let database: SqlExecutor;
let compute: ReturnType<typeof build>;

interface JobInput {
  tenantId: string;
  jobId: string;
  wait?: { timeoutMs: number };
}
interface Job {
  jobId: string;
  state: 'pending' | 'done';
  polls: number;
}

const parse = (raw: unknown): JobInput => {
  const input = raw as JobInput;
  if (typeof input?.tenantId !== 'string' || typeof input.jobId !== 'string')
    throw new Error('bad input');
  return input;
};
const read = async (sql: SqlExecutor, jobId: string) =>
  (
    await sql.query<{ state: Job['state'] }>('SELECT state FROM plg_jobs_jobs WHERE id = $1', [
      jobId,
    ])
  ).rows[0]!.state;

const jobs = definePlugin({
  id: 'jobs',
  catalog: { actions: ['compute:jobs:run'] },
  migrations: [
    {
      name: 'jobs/0001_jobs',
      sql: "CREATE TABLE plg_jobs_jobs (id text PRIMARY KEY, state text NOT NULL DEFAULT 'pending')",
    },
  ],
  api: () => ({
    jobs: {
      start: defineMethod<JobInput, Job>({
        action: 'compute:jobs:run',
        kind: 'mutation',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: parse,
        async handler(context, input) {
          await context.sql.query('INSERT INTO plg_jobs_jobs (id) VALUES ($1)', [input.jobId]);
          return { jobId: input.jobId, state: 'pending', polls: 0 };
        },
        poll: {
          done: (job) => job.state === 'done',
          async refresh(context, input, job) {
            return { ...job, state: await read(context.sql, input.jobId), polls: job.polls + 1 };
          },
        },
      }),
    },
  }),
});

function build() {
  const iam = fakeIam();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-waiter' });
  iam.allow({ token: USER });
  return betterCompute({ ...options(database, iam), plugins: [jobs] });
}

beforeAll(async () => {
  database = pglite();
  compute = build();
  await compute.initialize();
});
afterAll(async () => {
  await compute.stop();
  await database.close();
});

const start = (jobId: string, wait?: number) =>
  (compute.api.plugins as any).jobs.jobs.start(
    { token: USER },
    { tenantId: ACME, jobId, ...(wait !== undefined ? { wait: { timeoutMs: wait } } : {}) },
  ) as Promise<Job>;
const finish = (jobId: string, afterMs: number) =>
  setTimeout(() => {
    void database.query("UPDATE plg_jobs_jobs SET state = 'done' WHERE id = $1", [jobId]);
  }, afterMs);

describe('async-with-wait', () => {
  it('answers at once without wait, with the finished operation when it completes in time', async () => {
    expect(await start('j1')).toEqual({ jobId: 'j1', state: 'pending', polls: 0 });
    finish('j2', 150);
    const waited = await start('j2', 5_000);
    expect(waited.state).toBe('done');
    expect(waited.polls).toBeGreaterThan(0);
  });

  it('answers the pending operation at the timeout, without an error', async () => {
    const started = Date.now();
    const job = await start('j3', 300);
    expect(job.state).toBe('pending');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('refuses a poll on a read, or one without refresh', () => {
    const bad = (method: Record<string, unknown>) =>
      betterCompute({
        ...options(database, fakeIam()),
        plugins: [
          definePlugin({
            id: 'badpoll',
            catalog: { actions: ['compute:badpoll:run'] },
            api: () => ({
              things: {
                go: defineMethod({
                  action: 'compute:badpoll:run',
                  kind: 'mutation',
                  resource: (input: { tenantId: string }) => ({
                    type: 'tenant',
                    id: input.tenantId,
                  }),
                  validate: (input: unknown) => input as { tenantId: string },
                  handler: async () => ({}),
                  ...method,
                } as never),
              },
            }),
          }),
        ],
      });
    expect(() =>
      bad({ kind: 'read', poll: { done: () => true, refresh: async () => ({}) } }),
    ).toThrow(/only mutations take a poll/);
    expect(() => bad({ poll: { done: () => true } })).toThrow(/poll needs done and refresh/);
  });
});
