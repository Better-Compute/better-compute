import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// `better-compute sim` (PLAN.md §9.3, §15): the deterministic fleet simulator from the command line.

async function sim(argv: string[]) {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), env: {} };
  try {
    await createCli().run(['sim', ...argv, '--format', 'json'], io);
    return { ok: true as const, report: JSON.parse(out.join('\n')) };
  } catch (error) {
    return { ok: false as const, code: (error as { code?: string }).code };
  }
}

describe('sim', () => {
  it('runs a chaotic fleet, keeps the invariants, and reproduces by seed', async () => {
    const argv = ['--seed', 'cli-sim', '--nodes', '12', '--duration', '3m', '--chaos', 'heavy'];
    const first = await sim(argv);
    expect(first).toMatchObject({
      ok: true,
      report: { seed: 'cli-sim', nodes: 12, chaos: 'heavy', violations: 0, commands: { open: 0 } },
    });
    expect(first.ok && first.report.commands.total).toBeGreaterThan(50);
    expect(first.ok && first.report.faults.crashes).toBeGreaterThan(0);
    const again = await sim(argv);
    expect(again.ok && again.report.digest).toBe(first.ok && first.report.digest);
    const other = await sim(['--seed', 'cli-sim-2', ...argv.slice(2)]);
    expect(other.ok && other.report.digest).not.toBe(first.ok && first.report.digest);
  }, 120_000);

  it('runs without chaos and refuses unknown levels', async () => {
    expect(await sim(['--nodes', '3', '--duration', '1m', '--chaos', 'none'])).toMatchObject({
      ok: true,
      report: { violations: 0, faults: { crashes: 0 } },
    });
    expect(await sim(['--chaos', 'extreme'])).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
    expect(await sim(['--duration', 'forever'])).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
  }, 60_000);
});
