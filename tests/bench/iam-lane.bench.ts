import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import type { IamStore } from '@better-iam/core';
import { betterIam } from '@better-iam/server';
import { sqliteAdapter } from '@better-iam/adapter-sqlite';
import type { Credential, SqlExecutor } from '@better-compute/core';
import { createComputeIamBridge, type EmbeddedIam, type ProjectionRow } from '@better-compute/iam';
import { totp } from '../support/iam.js';

// The v0.1 IAM-lane gate (PLAN.md §16, bench/REFERENCE.md "iam-lane"): embedded better-iam on
// adapter-postgres must sustain ≥50 admissions/s (authenticate + require ≈ 3 lock acquisitions each) with
// lock wait <50%, and the measured ceiling is recorded. Every better-iam transaction takes
// pg_advisory_xact_lock(1647206759, 1), so admissions serialize on one lane whatever the concurrency.
//
//   BETTER_COMPUTE_IAM_POSTGRES_URL=postgres://… pnpm bench:scale      the gate (needs @better-iam/adapter-postgres)
//   pnpm bench:scale                                                    SQLite, indicative only (not the gate adapter)
//
// Knobs: BENCH_IAM_DURATION_MS (per step), BENCH_IAM_CONCURRENCY ("1,4,16,32"), BENCH_IAM_DENY_SHARE (0.1),
// BENCH_IAM_GATE=1 to fail the run when the gate is missed on Postgres.

const postgresUrl =
  process.env.BETTER_COMPUTE_IAM_POSTGRES_URL ?? process.env.BETTER_COMPUTE_POSTGRES_URL;
const durationMs = Number(process.env.BENCH_IAM_DURATION_MS ?? (postgresUrl ? 30_000 : 5_000));
const concurrencies = (process.env.BENCH_IAM_CONCURRENCY ?? '1,4,16,32')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const denyShare = Number(process.env.BENCH_IAM_DENY_SHARE ?? 0.1);
const members = 32;
/** Acquisitions per admission: authenticate (1) + require (authenticate + decide, 2). */
const acquisitionsPerAdmission = 3;

interface Step {
  concurrency: number;
  admissions: number;
  denials: number;
  errors: number;
  seconds: number;
  admissionsPerSecond: number;
  acquisitionsPerSecond: number;
  latencyMs: { p50: number; p90: number; p99: number; max: number };
  /** Mean sessions waiting on the IAM advisory lock ÷ concurrency (Postgres only). */
  lockWaitShare?: number;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;

async function openStore(): Promise<{ store: IamStore; adapter: string }> {
  if (!postgresUrl) return { store: sqliteAdapter({ filename: ':memory:' }), adapter: 'sqlite' };
  const specifier = '@better-iam/adapter-postgres';
  let module: {
    postgresAdapter(options: { connectionString: string; poolSize?: number }): IamStore;
  };
  try {
    module = await import(/* @vite-ignore */ specifier);
  } catch {
    throw new Error(
      'The iam-lane gate needs @better-iam/adapter-postgres installed (a root devDependency; vendored)',
    );
  }
  return {
    store: module.postgresAdapter({ connectionString: postgresUrl, poolSize: 64 }),
    adapter: 'postgres',
  };
}

/** Samples sessions waiting on better-iam's advisory lock (classid 1647206759, objid 1). */
async function lockSampler(sql: SqlExecutor) {
  let samples = 0;
  let waiting = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const { rows } = await sql.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 1647206759 AND objid = 1 AND NOT granted`,
      );
      samples++;
      waiting += Number(rows[0]?.waiting ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return samples ? waiting / samples : 0;
    },
  };
}

function commit(): string {
  try {
    const git = `${process.env.LOCALAPPDATA ?? ''}\\GitHubDesktop\\app-3.6.5\\resources\\app\\git\\cmd\\git.exe`;
    for (const bin of ['git', git])
      try {
        return execFileSync(bin, ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        // try the next one
      }
  } catch {
    // fall through
  }
  return 'unknown';
}

const opened: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const item of opened.splice(0)) await item.close();
});

describe('iam-lane', () => {
  it('measures admissions/s through the embedded IamPort and records the ceiling', async () => {
    const { store, adapter } = await openStore();
    opened.push(store);
    let clock = Date.now();
    const invitations: { tenantId: string; token: string }[] = [];
    const bridge = createComputeIamBridge();
    const iam = betterIam({
      database: store,
      secret: 'better-compute-iam-lane-bench-secret-32-chars!!',
      baseURL: 'http://localhost:3000',
      plugins: [bridge.plugin({ inbox: { put: async () => {} } })],
      resolveResource: bridge.resolveResource(),
      authentication: {
        sendEmail: async (message) => {
          if (message.template === 'owner-invitation' && message.payload.token)
            invitations.push({ tenantId: message.tenantId, token: message.payload.token });
        },
        sessionLifetimeMs: 86_400_000,
        sessionIdleTimeoutMs: 86_400_000,
        now: () => clock,
      },
    });
    await iam.initialize();
    const rootEmail = `root-${Date.now()}@bench.test`;
    const root = await iam.bootstrap({
      email: rootEmail,
      name: 'Root',
      password: 'a strong bench root password',
    });
    const rootTenantId = root.tenant.id;
    const challenge = await iam.api.auth.signIn({
      tenantId: rootTenantId,
      email: rootEmail,
      password: 'a strong bench root password',
    });
    if (!('mfaRequired' in challenge)) throw new Error('Root must require MFA');
    const enrollment = await iam.api.auth.beginMfa({
      tenantId: rootTenantId,
      challenge: challenge.challenge,
    });
    const rootSession = await iam.api.auth.confirmMfa({
      credential: { tenantId: rootTenantId, challenge: challenge.challenge },
      code: totp(enrollment.secret, clock),
    });
    const rootCredential: Credential = { token: rootSession.token };
    const tenant = await iam.api.tenants.create(rootCredential, {
      parentId: rootTenantId,
      name: 'Bench',
      type: 'organization',
      ownerEmail: 'owner@bench.test',
    });
    const tenantId = tenant.tenant.id;
    // The organization turns active once its owner accepts the invitation.
    await iam.auth.dispatchOutbox();
    const invitation = invitations.find((item) => item.tenantId === tenantId);
    if (!invitation) throw new Error('No owner invitation was sent');
    await iam.api.tenants.acceptInvitation({
      tenantId,
      token: invitation.token,
      name: 'Owner',
      password: 'a strong bench owner password',
    });
    const port: EmbeddedIam = bridge.embedded(iam, { rootTenantId });

    // The projection a reservation admission resolves: one pool, one draft per member.
    const rows: ProjectionRow[] = [
      { type: 'pool', id: 'pool-1', tenantId, attributes: { gpuModel: 'H100' } },
    ];
    for (let i = 0; i < members; i++)
      rows.push({
        type: 'reservation',
        id: `draft-${i}`,
        tenantId,
        attributes: { gpuModel: 'H100', gpuCount: 4, durationHours: 24 },
        parentType: 'pool',
        parentId: 'pool-1',
      });
    bridge.projection.setSource({
      load: async () => ({ rows, cursor: { txid: '0', seq: '0' } }),
      changes: async (cursor) => ({ changed: [], rows: [], cursor }),
      get: async () => undefined,
    });
    await bridge.projection.load();

    const policy = await iam.api.policies.create(rootCredential, {
      tenantId,
      name: 'bench-reserve',
      document: {
        version: 1,
        statements: [
          {
            effect: 'allow',
            actions: ['compute:reservations:create'],
            resources: ['compute-reservation/*'],
            conditions: { NumericLessThanEquals: { 'resource.gpuCount': 8 } },
          },
        ],
      },
    });
    const role = await iam.api.roles.create(rootCredential, {
      tenantId,
      name: 'bench',
      policyIds: [policy.id],
    });
    const credentials: Credential[] = [];
    for (let i = 0; i < members; i++) {
      const email = `member-${i}@bench.test`;
      const identity = await iam.api.identities.create(rootCredential, {
        tenantId,
        email,
        name: `Member ${i}`,
        password: 'a strong bench member password',
      });
      await iam.api.bindings.create(rootCredential, {
        tenantId,
        roleId: role.id,
        subjectType: 'identity',
        subjectId: identity.id,
      });
      const session = await iam.api.auth.signIn({
        tenantId,
        email,
        password: 'a strong bench member password',
      });
      if (!('token' in session)) throw new Error('Unexpected MFA');
      credentials.push({ token: session.token });
    }
    clock = Date.now();

    const sampler = postgresUrl
      ? (await import('@better-compute/postgres')).postgres({ url: postgresUrl, max: 2 })
      : undefined;
    if (sampler) opened.push(sampler);

    const steps: Step[] = [];
    for (const concurrency of concurrencies) {
      const latencies: number[] = [];
      let admissions = 0;
      let denials = 0;
      let errors = 0;
      let counter = 0;
      const lock = sampler ? await lockSampler(sampler) : undefined;
      const started = performance.now();
      const deadline = started + durationMs;
      await Promise.all(
        Array.from({ length: concurrency }, async (_, worker) => {
          while (performance.now() < deadline) {
            const n = counter++;
            const member = (worker + n) % members;
            const deny = (n % 100) / 100 < denyShare;
            const credential = credentials[member]!;
            const begin = performance.now();
            try {
              await port.authenticate(credential);
              await port.require(credential, {
                tenantId,
                // A denied admission: an action the member lacks (its denial is audited).
                action: deny ? 'compute:reservations:extend' : 'compute:reservations:create',
                resource: { type: 'compute-reservation', id: `draft-${member}` },
              });
              admissions++;
            } catch (error) {
              if ((error as { code?: string }).code === 'ACCESS_DENIED' && deny) {
                admissions++;
                denials++;
              } else errors++;
            }
            latencies.push(performance.now() - begin);
          }
        }),
      );
      const seconds = (performance.now() - started) / 1000;
      const lockWaitShare = lock ? (await lock.stop()) / concurrency : undefined;
      latencies.sort((a, b) => a - b);
      const step: Step = {
        concurrency,
        admissions,
        denials,
        errors,
        seconds: Number(seconds.toFixed(2)),
        admissionsPerSecond: Number((admissions / seconds).toFixed(1)),
        acquisitionsPerSecond: Number(
          ((admissions * acquisitionsPerAdmission) / seconds).toFixed(1),
        ),
        latencyMs: {
          p50: Number(percentile(latencies, 50).toFixed(2)),
          p90: Number(percentile(latencies, 90).toFixed(2)),
          p99: Number(percentile(latencies, 99).toFixed(2)),
          max: Number((latencies.at(-1) ?? 0).toFixed(2)),
        },
      };
      if (lockWaitShare !== undefined) step.lockWaitShare = Number(lockWaitShare.toFixed(3));
      steps.push(step);
      expect(errors, `unexpected errors at concurrency ${concurrency}`).toBe(0);
    }

    const ceiling = steps.reduce((best, step) =>
      step.admissionsPerSecond > best.admissionsPerSecond ? step : best,
    );
    const gateStep = steps.filter((step) => step.admissionsPerSecond >= 50);
    const result = {
      suite: 'iam-lane',
      commit: commit(),
      date: new Date().toISOString(),
      referenceHardware: false,
      machine: {
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        memoryGiB: Math.round(totalmem() / 2 ** 30),
      },
      node: process.version,
      adapter,
      postgres: postgresUrl
        ? (await sampler!.query<{ version: string }>('SHOW server_version')).rows[0]?.version
        : undefined,
      config: { durationMs, concurrencies, denyShare, members, acquisitionsPerAdmission },
      steps,
      ceiling: {
        admissionsPerSecond: ceiling.admissionsPerSecond,
        acquisitionsPerSecond: ceiling.acquisitionsPerSecond,
        concurrency: ceiling.concurrency,
      },
      gate: {
        adapter: 'postgres',
        admissionsPerSecond: 50,
        maxLockWaitShare: 0.5,
        met: adapter === 'postgres' && gateStep.some((step) => (step.lockWaitShare ?? 1) < 0.5),
        belowG5: ceiling.admissionsPerSecond < 200,
      },
    };
    const dir = new URL('../../bench/iam-lane/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    const file = new URL(`${result.date.replace(/[:.]/g, '-')}-${adapter}.json`, dir);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      JSON.stringify({ adapter, ceiling: result.ceiling, gate: result.gate, steps }, null, 2),
    );
    if (adapter === 'postgres' && process.env.BENCH_IAM_GATE === '1')
      expect(result.gate.met).toBe(true);
  });
});
