import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// The examples/ configurations (PLAN.md §4 layout): each loads, migrates and passes `doctor` with every
// module registered; examples/dev also runs `dev --sim` and serves its host routes.

const SECRET = 'better-compute-examples-smoke-secret-0123456789';
const config = (name: string) =>
  fileURLToPath(new URL(`../examples/${name}/better-compute.config.ts`, import.meta.url));

async function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: () => undefined, env, cwd };
  await createCli().run(argv, io);
  return out.join('\n');
}

describe('examples', () => {
  for (const name of ['dev', 'postgres', 'emulated-site'])
    it(`${name}: the configuration migrates and passes doctor`, { timeout: 120_000 }, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `bc-example-${name}-`));
      const env = {
        BETTER_COMPUTE_DATABASE_URL: `pglite:${join(cwd, 'db')}`,
        BETTER_COMPUTE_SECRET: SECRET,
        // examples/postgres refuses PGlite outside this smoke test.
        EXAMPLES_ALLOW_PGLITE: '1',
      };
      expect(await run(['migrate', '--config', config(name)], env, cwd)).toContain('applied');
      const report = JSON.parse(await run(['doctor', '--config', config(name)], env, cwd)) as {
        ok: boolean;
        findings: { check: string; severity: string }[];
      };
      expect(report.ok).toBe(true);
      // Only the expected gaps of an unconfigured laptop: no IAM wired yet.
      expect(report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
      expect(report.findings.map((finding) => finding.check)).toContain('iam.not-configured');
    });

  it('dev: approver keys from batch keygen turn the destructive-batch quorum on', { timeout: 120_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-example-quorum-'));
    const env = { BETTER_COMPUTE_DATABASE_URL: `pglite:${join(cwd, 'db')}`, BETTER_COMPUTE_SECRET: SECRET };
    await run(['pki', 'init', '--trust-domain', 'compute.test'], env, cwd);
    await run(['batch', 'keygen', '--out', 'alice.pem'], env, cwd);
    await run(['batch', 'keygen', '--out', 'bob.pem'], env, cwd);
    const quorum = { ...env, BETTER_COMPUTE_APPROVER_KEYS: 'alice.pem.pub, bob.pem.pub', BETTER_COMPUTE_APPROVER_THRESHOLD: '2' };
    expect(await run(['migrate', '--config', config('dev')], quorum, cwd)).toContain('applied');
    const report = JSON.parse(await run(['doctor', '--config', config('dev')], quorum, cwd)) as { ok: boolean };
    expect(report.ok).toBe(true);
    const { exampleOptions } = await import('../examples/shared/compose.ts');
    const options = await exampleOptions({ env: quorum, cwd });
    expect(options.pki?.approvers).toMatchObject({ threshold: 2, unbatchedDestructivePerHour: 0 });
    expect(options.pki?.approvers?.keys).toHaveLength(2);
    await options.database.close?.();
    // k must be within the keys given; a private key file is not a public key.
    await expect(
      run(['doctor', '--config', config('dev')], { ...quorum, BETTER_COMPUTE_APPROVER_THRESHOLD: '3' }, cwd),
    ).rejects.toThrow(/APPROVER_THRESHOLD/);
    await expect(
      run(['doctor', '--config', config('dev')], { ...quorum, BETTER_COMPUTE_APPROVER_KEYS: 'alice.pem' }, cwd),
    ).rejects.toThrow();
  });

  it('postgres refuses to run on PGlite', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-example-pg-'));
    await expect(
      run(
        ['doctor', '--config', config('postgres')],
        { BETTER_COMPUTE_DATABASE_URL: 'pglite:memory', BETTER_COMPUTE_SECRET: SECRET },
        cwd,
      ),
    ).rejects.toThrow(/PostgreSQL/);
  });

  it(
    'dev: dev --sim adopts simulated machines and serves /watch',
    { timeout: 120_000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'bc-example-dev-sim-'));
      const controller = new AbortController();
      const notes: string[] = [];
      const done = createCli()
        .run(['dev', '--config', config('dev'), '--memory', '--sim', '2', '--port', '0'], {
          out: () => undefined,
          err: (line) => notes.push(line),
          env: {},
          cwd,
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      const noted = async (pattern: RegExp) => {
        for (let i = 0; i < 1800; i++) {
          const line = notes.find((note) => pattern.test(note));
          if (line) return line;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`no note matching ${pattern}: ${notes.join('\n')}`);
      };
      try {
        const api = /listening on (\S+)/.exec(await noted(/listening on/))![1]!;
        const token = /root token \(dev only\): (\S+)/.exec(await noted(/root token/))![1]!;
        await noted(/2 simulated node\(s\) adopted/);
        const watch = await fetch(`${new URL(api).origin}/watch?types=node.*`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(watch.status).toBe(200);
        expect(watch.headers.get('content-type')).toContain('text/event-stream');
        await watch.body?.cancel();
      } finally {
        controller.abort();
        const result = await done;
        if (result) throw result;
      }
    },
  );
});
