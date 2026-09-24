import type { StepDefinition, StepInput } from '@better-compute/core';
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
] as const;

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
export function defineStep<I>(step: StepInput<I>): StepDefinition<I> {
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
  } else {
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
