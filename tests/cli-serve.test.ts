import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import { parseRoles } from '../packages/cli/src/commands/serve.js';

// `better-compute serve` and `dev` (PLAN.md §9.3): a real listener over PGlite, stopped through
// CliIO.signal instead of SIGINT.

const SECRET = 'better-compute-cli-serve-secret-0123456789';

async function start(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const controller = new AbortController();
  const notes: string[] = [];
  const out: string[] = [];
  const io: CliIO = {
    out: (line) => out.push(line),
    err: (line) => notes.push(line),
    env,
    cwd,
    signal: controller.signal,
  };
  let failure: unknown;
  const done = createCli()
    .run(argv, io)
    .catch((error) => {
      failure = error;
    });
  let url: string | undefined;
  for (let i = 0; i < 600 && !url && failure === undefined; i++) {
    url = notes.map((line) => /listening on (\S+)/.exec(line)?.[1]).find(Boolean);
    if (!url) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (failure) throw failure;
  return {
    url: url!,
    notes,
    out,
    async stop() {
      controller.abort();
      await done;
      if (failure) throw failure;
    },
  };
}

const version = (url: string) =>
  fetch(`${url}/system/version`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-better-compute': '1' },
    body: '{}',
  });

describe('serve and dev', () => {
  it('parses --roles', () => {
    expect(parseRoles('all')).toEqual({
      api: true,
      roles: ['controllers', 'scheduler', 'sinks', 'iam'],
    });
    expect(parseRoles('api')).toEqual({ api: true, roles: [] });
    expect(parseRoles('controllers, sinks,controllers')).toEqual({
      api: false,
      roles: ['controllers', 'sinks'],
    });
    expect(() => parseRoles('api,web')).toThrow(/unknown role/);
  });

  it('serve migrates, answers on the API, and stops on the signal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-serve-'));
    const server = await start(
      ['serve', '--port', '0', '--host', '127.0.0.1', '--roles', 'api,controllers'],
      { BETTER_COMPUTE_DATABASE_URL: 'pglite:memory', BETTER_COMPUTE_SECRET: SECRET },
      cwd,
    );
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/compute$/);
    const response = await version(server.url);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ version: expect.any(String) });
    expect(server.notes.join('\n')).toContain('Workers running: controllers');
    await server.stop();
    expect(server.out.join('\n')).toMatch(/^Stopped http:/);
    await expect(version(server.url)).rejects.toThrow();
  });

  it('dev needs no setup and keeps its generated secret', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-dev-'));
    const first = await start(['dev', '--port', '0'], {}, cwd);
    expect((await version(first.url)).status).toBe(200);
    await first.stop();
    const secretFile = join(cwd, '.better-compute', 'dev-secret');
    const secret = await readFile(secretFile, 'utf8');
    expect(secret.trim().length).toBeGreaterThanOrEqual(32);
    expect((await stat(join(cwd, '.better-compute', 'dev-db'))).isDirectory()).toBe(true);

    const second = await start(['dev', '--port', '0'], {}, cwd);
    expect((await version(second.url)).status).toBe(200);
    await second.stop();
    expect(await readFile(secretFile, 'utf8')).toBe(secret);
  });

  it(
    'dev --sim joins simulated machines through a loopback gateway',
    { timeout: 120_000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'bc-dev-sim-'));
      const server = await start(['dev', '--memory', '--port', '0', '--sim', '2'], {}, cwd);
      const noted = async (pattern: RegExp) => {
        for (let i = 0; i < 1200; i++) {
          const line = server.notes.find((note) => pattern.test(note));
          if (line) return line;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`no note matching ${pattern}: ${server.notes.join('\n')}`);
      };
      expect(await noted(/Dev gateway \(h2c.*\): http:\/\/127\.0\.0\.1:\d+$/)).toBeTruthy();
      const token = /root token \(dev only\): (\S+)/.exec(await noted(/root token/))![1]!;
      const tenantId = /root tenant (\S+);/.exec(await noted(/root tenant/))![1]!;
      await noted(/2 simulated node\(s\) adopted/);
      const response = await fetch(`${server.url}/nodes/list`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-better-compute': '1',
        },
        body: JSON.stringify({ tenantId }),
      });
      expect(response.status).toBe(200);
      const { data } = (await response.json()) as { data: { items: { provisionState: string }[] } };
      expect(data.items.map((node) => node.provisionState)).toEqual(['adopted', 'adopted']);
      await server.stop();
    },
  );

  it('dev refuses an unknown --sim-variant', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-dev-sim-'));
    await expect(
      createCli().run(['dev', '--memory', '--sim', '1', '--sim-variant', 'tpu'], {
        out() {},
        env: {},
        cwd,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses bad roles before loading anything', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-serve-'));
    await expect(
      createCli().run(['serve', '--roles', 'web'], {
        out() {},
        env: { BETTER_COMPUTE_DATABASE_URL: 'pglite:memory', BETTER_COMPUTE_SECRET: SECRET },
        cwd,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
