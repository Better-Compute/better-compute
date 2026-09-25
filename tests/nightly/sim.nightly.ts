import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runNightly, type NightlyChaos, type NightlyReport } from '@better-compute/testing';

// The nightly simulation matrix (PLAN.md §15, v0.4 exit: "all §15 scenarios green on 3 consecutive nights"). Every
// seed × chaos level runs the full scenario mix on the real control plane and gateways under the fleet simulator
// (see `runNightly`) and writes a machine-readable report; the run fails if any seed breaks an invariant.
//
//   pnpm sim:nightly
//
// Knobs: SIM_NIGHTLY_SEEDS (comma-separated, default "1,2,3"), SIM_NIGHTLY_CHAOS ("light,heavy"), SIM_NIGHTLY_NODES
// (16), SIM_NIGHTLY_GATEWAYS (3), SIM_NIGHTLY_MINUTES (60, simulated), SIM_NIGHTLY_OUT (bench/sim-nightly/results).
// Each report carries a workload digest (a function of the seed) and an id-free outcome digest; compare outcome
// digests across nights to spot behaviour changes for the same seed.

const seeds = (process.env.SIM_NIGHTLY_SEEDS ?? '1,2,3')
  .split(',')
  .map((seed) => seed.trim())
  .filter(Boolean);
const chaosLevels = (process.env.SIM_NIGHTLY_CHAOS ?? 'light,heavy')
  .split(',')
  .map((level) => level.trim())
  .filter(
    (level): level is NightlyChaos => level === 'none' || level === 'light' || level === 'heavy',
  );
const nodes = Number(process.env.SIM_NIGHTLY_NODES ?? 16);
const gateways = Number(process.env.SIM_NIGHTLY_GATEWAYS ?? 3);
const minutes = Number(process.env.SIM_NIGHTLY_MINUTES ?? 60);
const out = new URL(
  process.env.SIM_NIGHTLY_OUT
    ? `file:///${process.env.SIM_NIGHTLY_OUT.replace(/\\/g, '/')}/`
    : '../../bench/sim-nightly/results/',
  import.meta.url,
);

function commit(): string {
  const git = `${process.env.LOCALAPPDATA ?? ''}\\GitHubDesktop\\app-3.6.5\\resources\\app\\git\\cmd\\git.exe`;
  for (const bin of ['git', git])
    try {
      return execFileSync(bin, ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // try the next one
    }
  return 'unknown';
}

describe('sim:nightly', () => {
  const reports: NightlyReport[] = [];
  const started = new Date().toISOString();

  for (const chaos of chaosLevels)
    for (const seed of seeds)
      it(`seed ${seed}, ${chaos} chaos`, async () => {
        const report = await runNightly({ seed, nodes, gateways, minutes, chaos });
        reports.push(report);
        console.log(
          JSON.stringify({
            seed,
            chaos,
            ok: report.ok,
            violations: report.violations.length,
            reservations: report.reservations,
            chaosEvents: report.chaos,
            placeToActiveP99Ms: report.placeToActiveMs.p99,
            wallMs: report.wallMs,
          }),
        );
        expect(report.violations).toEqual([]);
      });

  it('writes the night’s report', () => {
    mkdirSync(out, { recursive: true });
    const night = {
      suite: 'sim-nightly',
      commit: commit(),
      date: started,
      machine: {
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        memoryGiB: Math.round(totalmem() / 2 ** 30),
      },
      node: process.version,
      config: { seeds, chaos: chaosLevels, nodes, gateways, minutes },
      ok: reports.every((report) => report.ok),
      runs: reports,
    };
    writeFileSync(
      new URL(`${started.replace(/[:.]/g, '-')}.json`, out),
      `${JSON.stringify(night, null, 2)}\n`,
    );
    expect(reports.length).toBe(seeds.length * chaosLevels.length);
  });
});
