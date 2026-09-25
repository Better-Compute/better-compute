import type { RunsOn, StepDefinition, StepInput } from '@better-compute/core';
import {
  checkDottedId,
  checkRetries,
  checkRunsOn,
  checkTimeout,
  checkVersion,
  failFor,
  isStandardSchema,
  onlyKeys,
  type Fail,
} from './check.js';
import { checkProfileSteps } from './profile.js';

const stepKeys = [
  'id',
  'version',
  'runsOn',
  'timeout',
  'retries',
  'retrySafe',
  'await',
  'input',
  'command',
  'run',
  'cleanup',
  'relays',
  'sends',
] as const;

/**
 * A step as `defineStep` takes it: core's `StepInput`, plus `relays` for control-plane steps that
 * build a command and send it to an agent themselves (`awaitCommand`). Profiles may then write the
 * step with `on:` one of those places, as §11.4 writes `{ use: 'power.setPower', on: 'site' }`.
 */
export type StepInputWithRelays<I> = StepInput<I> & { relays?: readonly Exclude<RunsOn, 'control-plane'>[] };
/** A step definition, with the places it relays to. */
export type RelayingStepDefinition<I> = StepDefinition<I> & { readonly relays?: readonly Exclude<RunsOn, 'control-plane'>[] };

/** The places a step relays to (empty for most steps). */
export const stepRelays = (step: StepDefinition): readonly RunsOn[] =>
  (step as RelayingStepDefinition<unknown>).relays ?? [];

/**
 * Declares a workflow step (§5.4, §11.2) that profiles `use` by id. A `control-plane` step runs
 * `run(input, context)` in the worker that owns the target's shard. A step on a `site`, `node` or
 * `ramdisk` agent is exactly one command of kind `command` (`driver.invoke` for driver
 * operations), and may `await: 'rejoin'` when that command is self-terminating. Shapes are checked
 * up front (`INVALID_CONFIG`); the definition is returned frozen with `extension: 'step'`.
 *
 * ```ts
 * const agentJoined = defineStep({ id: 'wait.agentJoined', runsOn: 'control-plane',
 *   timeout: '15m', retrySafe: true, input: manifest({ role: field.option(['node', 'ramdisk']) }),
 *   run: async (input, context) => { … } });
 * ```
 */
export function defineStep<I>(step: StepInputWithRelays<I>): RelayingStepDefinition<I> {
  const candidate = step as unknown as Record<string, unknown>;
  const fail: Fail = failFor(
    typeof candidate?.id === 'string' ? `Step ${candidate.id.slice(0, 128)}` : 'Step',
  );
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
    fail('', 'must be an object');
  onlyKeys(candidate, stepKeys, '', fail);
  checkDottedId(candidate.id, 'id', fail);
  if (candidate.version !== undefined) checkVersion(candidate.version, 'version', fail);
  checkRunsOn(candidate.runsOn, 'runsOn', fail);
  checkTimeout(candidate.timeout, 'timeout', fail);
  if (candidate.retries !== undefined) checkRetries(candidate.retries, 'retries', fail);
  if (typeof candidate.retrySafe !== 'boolean') fail('retrySafe', 'must be true or false');
  if (!isStandardSchema(candidate.input))
    fail('input', 'must be a manifest or another Standard Schema');
  if (candidate.runsOn === 'control-plane') {
    if (typeof candidate.run !== 'function') fail('run', 'is required on a control-plane step');
    if (candidate.command !== undefined)
      fail('command', 'is not available on a control-plane step, which runs in the worker');
    if (candidate.await !== undefined)
      fail('await', 'needs a step that runs on an agent, which is what rejoins');
    if (candidate.relays !== undefined) {
      if (!Array.isArray(candidate.relays)) fail('relays', 'must be a list of site, node or ramdisk');
      for (const [i, place] of (candidate.relays as unknown[]).entries())
        if (place !== 'site' && place !== 'node' && place !== 'ramdisk') fail(`relays[${i}]`, 'must be site, node or ramdisk');
    }
    if (candidate.sends !== undefined) {
      if (!Array.isArray(candidate.sends)) fail('sends', 'must be a list of command kinds');
      for (const [i, kind] of (candidate.sends as unknown[]).entries()) checkDottedId(kind, `sends[${i}]`, fail);
    }
  } else {
    if (candidate.relays !== undefined) fail('relays', 'is only for control-plane steps');
    if (candidate.sends !== undefined) fail('sends', `is only for control-plane steps; a step on ${candidate.runsOn} sends its command`);
    if (candidate.command === undefined)
      fail('command', `is required: a step on ${candidate.runsOn} is exactly one command`);
    checkDottedId(candidate.command, 'command', fail);
    if (candidate.run !== undefined)
      fail('run', `is not available on a step that runs on ${candidate.runsOn}`);
    if (candidate.await !== undefined && candidate.await !== 'rejoin')
      fail('await', "must be 'rejoin'");
  }
  if (candidate.cleanup !== undefined) checkProfileSteps(candidate.cleanup, 'cleanup', fail);
  return Object.freeze({ ...step, extension: 'step' as const });
}
