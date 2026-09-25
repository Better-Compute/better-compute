import { describe, expect, it } from 'vitest';
import { createCli as createIamCli, defineCommand as defineIamCommand } from '@better-iam/cli';
import { argvOf, computeCommands } from '@better-compute/cli';

// One binary for IAM and compute (PLAN.md §9.3): better-iam's own CLI program runs compute's commands, built with its
// defineCommand, as `compute <command>`; compute parses, loads its deployment and prints as `better-compute` would.

const memoryEnv = {
  BETTER_COMPUTE_DATABASE_URL: 'pglite:memory',
  BETTER_COMPUTE_SECRET: 'embedded-cli-test-secret-0123456789abcdefgh',
};

function io(env: Record<string, string> = memoryEnv) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env, cwd: process.cwd() },
  };
}

describe('computeCommands', () => {
  it("adds every compute command to better-iam's program, under compute", () => {
    const cli = createIamCli({ commands: computeCommands(defineIamCommand as never) as never });
    const names = cli.manifest().commands.map((command) => command.name);
    // One-word names: better-iam resolves a command by its first argument.
    for (const name of ['compute-api', 'compute-reserve', 'compute-serve', 'compute-support-bundle', 'compute-auth-login'])
      expect(names).toContain(name);
    // better-iam's own commands stay as they are.
    expect(names).toContain('api');
    const reserve = cli.manifest().commands.find((command) => command.name === 'compute-reserve')!;
    expect(reserve.group).toBe('Compute');
    expect(reserve.flags.map((flag) => flag.flag)).toEqual(expect.arrayContaining(['--pool', '--url', '--config']));
    expect(reserve.examples.length).toBeGreaterThan(0);
    expect(reserve.examples.every((line) => line.startsWith('better-iam compute-reserve'))).toBe(true);
  });

  it('runs a compute command through better-iam with compute parsing, environment and output', async () => {
    const cli = createIamCli({ commands: computeCommands(defineIamCommand as never) as never });
    const run = io();
    await cli.run(['compute-api', 'system.version', '--query', 'name'], run.io as never);
    expect(run.out.join('\n')).toBe('better-compute');
    // Excluding commands, and a failure reported by compute.
    const without = createIamCli({
      commands: computeCommands(defineIamCommand as never, { exclude: ['dev', 'serve'] }) as never,
    });
    expect(without.manifest().commands.map((command) => command.name)).not.toContain('compute-serve');
    const failing = io();
    await expect(cli.run(['compute-api', 'system.selfCheck'], failing.io as never)).rejects.toMatchObject({
      code: 'MISSING_ENV',
    });
  });

  it('rebuilds only the flags given on the command line, positionals after --', () => {
    const specs = {
      pool: { type: 'string', description: '' },
      gpus: { type: 'integer', description: '' },
      wait: { type: 'boolean', description: '' },
      quiet: { type: 'boolean', description: '' },
    } as const;
    expect(
      argvOf({ pool: 'h100-eu', gpus: 4, wait: true, quiet: false, extra: 'x' }, new Set(['pool', 'gpus', 'wait', 'quiet']), ['-weird'], specs as never),
    ).toEqual(['--pool=h100-eu', '--gpus=4', '--wait', '--', '-weird']);
    expect(argvOf({ pool: 'from-env' }, new Set(), [], specs as never)).toEqual([]);
  });
});
