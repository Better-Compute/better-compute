// Deletes what AWS live-suite runs left in the sandbox account: every resource tagged
// better-compute:test-run whose run started more than two hours ago (tests/live/aws/support/sweep.ts).
// It lists only, unless --apply. It runs only with the live suite's gate: BETTER_COMPUTE_AWS_LIVE=1,
// BETTER_COMPUTE_AWS_LIVE_ACCOUNT (the credentials must belong to it), BETTER_COMPUTE_AWS_LIVE_BUDGET_USD
// and the sandbox credentials in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.
//
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/aws-live-sweep.mjs [--apply] [--older-than-minutes N]
//
// Exit codes: 0 swept (or listed), 2 not enabled or misconfigured, 3 some deletes are pending (run again later).
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { apply: { type: 'boolean', default: false }, 'older-than-minutes': { type: 'string' } },
  allowPositionals: false,
});
const { liveGate } = await import('../tests/live/aws/support/live.ts');
const { sweepTestRuns } = await import('../tests/live/aws/support/sweep.ts');

let gate;
try {
  gate = liveGate(process.env);
} catch (error) {
  console.error(`aws-live-sweep: ${error.message}`);
  process.exit(2);
}
if (!gate.enabled) {
  console.error(`aws-live-sweep: ${gate.reason}; nothing to do`);
  process.exit(2);
}
let olderThanMs;
if (values['older-than-minutes'] !== undefined) {
  const minutes = Number(values['older-than-minutes']);
  // Never younger than an hour: a running suite's resources must not be swept from under it.
  if (!Number.isInteger(minutes) || minutes < 60) {
    console.error('aws-live-sweep: --older-than-minutes must be an integer of at least 60');
    process.exit(2);
  }
  olderThanMs = minutes * 60_000;
}

const report = await sweepTestRuns({ config: gate.config, apply: values.apply, ...(olderThanMs ? { olderThanMs } : {}) });
console.log(`${report.found} tagged resource(s) in ${gate.config.account} (${gate.config.region})`);
for (const arn of report.wouldDelete) console.log(`would delete ${arn}`);
for (const arn of report.deleted) console.log(`deleted ${arn}`);
for (const { arn, reason } of report.pending) console.log(`pending ${arn}: ${reason}`);
for (const { arn, reason } of report.skipped) console.log(`skipped ${arn}: ${reason}`);
if (!values.apply && report.wouldDelete.length > 0) console.log('Dry run: pass --apply to delete.');
process.exit(report.pending.length > 0 ? 3 : 0);
