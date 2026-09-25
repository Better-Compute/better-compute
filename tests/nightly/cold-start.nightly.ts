import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runColdStart } from '@better-compute/testing';

// The v0.4 exit's cold start at full size (PLAN.md §15 "10k cold start ≤3 min"; §16 acceptance at 10k nodes): 10 000
// nodes power on within 30 s behind 3 gateways; every one must be connected, adopted and schedulable within 3
// simulated minutes with no unreachable mark, and again after a full power cycle. Writes a machine-readable report.
//
//   pnpm sim:nightly
//
// Knobs: COLD_START_NODES (10000), COLD_START_GATEWAYS (3), COLD_START_SPREAD_MS (both 30000 and 0), COLD_START_SEED ("1"),
// COLD_START_OUT (bench/cold-start/results). Wall time is dominated by the joins and the one PGlite (about 15 min
// at 10k on a desktop); simulated time is what is measured.

const nodes = Number(process.env.COLD_START_NODES ?? 10_000);
const gateways = Number(process.env.COLD_START_GATEWAYS ?? 3);
// Two power-ons by default: nodes starting over 30 s, and all at the same instant (the herd, which leans on the
// gateways' retry pushback and liveness counting never-connected nodes from their join). COLD_START_SPREAD_MS picks one.
const spreads = process.env.COLD_START_SPREAD_MS
  ? [Number(process.env.COLD_START_SPREAD_MS)]
  : [30_000, 0];
const seed = process.env.COLD_START_SEED ?? '1';
const out = new URL(
  process.env.COLD_START_OUT
    ? `file:///${process.env.COLD_START_OUT.replace(/\\/g, '/')}/`
    : '../../bench/cold-start/results/',
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

describe('sim:nightly cold start', () => {
  it.each(spreads)(
    `boots ${nodes} nodes within 3 minutes, powered on over %i ms`,
    async (startSpreadMs) => {
      const date = new Date().toISOString();
      const report = await runColdStart({ seed, nodes, gateways, startSpreadMs });
      const result = {
        suite: 'cold-start',
        commit: commit(),
        date,
        machine: {
          cpus: cpus().length,
          cpuModel: cpus()[0]?.model ?? 'unknown',
          memoryGiB: Math.round(totalmem() / 2 ** 30),
        },
        node: process.version,
        ...report,
        violations: report.violations.length,
        violationsSample: report.violations.slice(0, 10),
      };
      mkdirSync(out, { recursive: true });
      writeFileSync(
        new URL(
          `${date.replace(/[:.]/g, '-')}-${nodes}${startSpreadMs === 0 ? '-herd' : ''}.json`,
          out,
        ),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      console.log(JSON.stringify(result));
      expect(report.violations).toEqual([]);
      expect(report.boot.unreachableMarks).toBe(0);
      expect(report.ok).toBe(true);
    },
  );
});
