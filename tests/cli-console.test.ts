import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, main, type CliIO, type CliTerminal } from '@better-compute/cli';

// `better-compute console` / `exec` (PLAN.md §7.6): tunnels.open as the token, then the tunnel's
// WebSocket, with the terminal attached until the remote program exits. Against `dev --sim 1`, whose
// simulated node runs the fake daemon's line shell (`exit` → 0, `false` → 1, Ctrl-D → 0).

async function wait<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 1200; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A scripted terminal: records output and sizes, and types what the test says. */
function scriptedTerminal() {
  let text = '';
  const listeners = new Set<(data: Uint8Array) => void>();
  const modes: string[] = [];
  const terminal: CliTerminal = {
    onInput(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    write: (data) => void (text += new TextDecoder().decode(data)),
    size: () => ({ rows: 40, cols: 132 }),
    raw() {
      modes.push('raw');
      return () => void modes.push('restored');
    },
  };
  return {
    terminal,
    modes,
    output: () => text,
    type: (keys: string) => {
      for (const listener of listeners) listener(new TextEncoder().encode(keys));
    },
    attached: () => listeners.size > 0,
  };
}

describe('console', () => {
  it('attaches a terminal to a node console and exits with the remote status', { timeout: 180_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-console-'));
    const controller = new AbortController();
    const notes: string[] = [];
    const dev = createCli().run(['dev', '--memory', '--port', '0', '--sim', '1'], {
      out() {},
      err: (line) => notes.push(line),
      env: {},
      cwd,
      signal: controller.signal,
    });
    const noted = (pattern: RegExp) =>
      wait(() => notes.find((line) => pattern.test(line)), `${pattern}: ${notes.join('\n')}`);
    try {
      const url = /listening on (\S+)/.exec(await noted(/listening on/))![1]!;
      const token = /root token \(dev only\): (\S+)/.exec(await noted(/root token/))![1]!;
      const tenant = /root tenant (\S+);/.exec(await noted(/root tenant/))![1]!;
      await noted(/1 simulated node\(s\) adopted/);
      const env = { BETTER_COMPUTE_URL: url, BETTER_COMPUTE_TOKEN: token, BETTER_COMPUTE_TENANT: tenant };
      const listed: string[] = [];
      await createCli().run(['api', 'nodes.list', '--data', JSON.stringify({ tenantId: tenant })], {
        out: (line) => listed.push(line),
        env,
        cwd,
      });
      const nodeId = JSON.parse(listed.join('\n')).items[0].id as string;

      // A session that ends with `exit`: status 0, the terminal restored.
      const first = scriptedTerminal();
      const session = createCli().run(['console', '--node', nodeId], { out() {}, env, cwd, terminal: first.terminal });
      await wait(() => (first.output().includes(`fake console on ${nodeId}`) && first.attached()) || undefined, 'the banner');
      first.type('size\r');
      await wait(() => first.output().match(/40.*132|132.*40/)?.[0], `the size in ${first.output()}`);
      first.type('hello\r');
      await wait(() => (first.output().includes('echo: hello') ? true : undefined), 'the echo');
      first.type('exit\r');
      await session;
      expect(first.modes).toEqual(['raw', 'restored']);

      // The remote status becomes the process status, as with ssh.
      const second = scriptedTerminal();
      const errors: string[] = [];
      const status = main(['console', '--node', nodeId], undefined, {
        out() {},
        err: (line) => errors.push(line),
        env,
        cwd,
        terminal: second.terminal,
      });
      await wait(() => (second.attached() && second.output().includes('fake console') ? true : undefined), 'the second banner');
      second.type('false\r');
      expect(await status).toBe(1);
      expect(errors.join('\n')).not.toContain('REMOTE_EXIT');

      // Ctrl-] detaches: the command ends cleanly whatever the remote reports for the hangup.
      const third = scriptedTerminal();
      const detached = createCli().run(['console', '--node', nodeId], { out() {}, env, cwd, terminal: third.terminal });
      await wait(() => (third.attached() && third.output().includes('fake console') ? true : undefined), 'the third banner');
      third.type('\x1d');
      await detached;
      expect(third.modes).toEqual(['raw', 'restored']);
    } finally {
      controller.abort();
      await dev;
    }
  });

  it('needs --url: tunnels run over the server’s WebSocket', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-console-'));
    await expect(
      createCli().run(['exec', '--tenant', 'org_acme', '--instance', 'inst_01k5w00000000000000000000x'], {
        out() {},
        env: { BETTER_COMPUTE_TOKEN: 'biam_ses_x', BETTER_COMPUTE_DATABASE_URL: 'pglite:memory' },
        cwd,
        terminal: scriptedTerminal().terminal,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
