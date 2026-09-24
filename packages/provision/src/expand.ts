import {
  ComputeError,
  parseDuration,
  type Json,
  type ProfileDocument,
  type ProfileStep,
  type RunsOn,
  type StepDefinition,
} from '@better-compute/core';
import { stepRelays } from './step.js';

// Expanding a profile into the persisted steps of one workflow (PLAN.md §11.2, §11.4).
//
// Each `use:` resolves to either a registered step (`defineStep`) or, when the profile says where
// it runs (`on:`), to a driver operation `<concern>.<operation>` sent as one `driver.invoke`
// command. `fallback:` names the step to use when `use:` does not resolve. Acceptance steps run
// after the main steps; cleanup runs last, whatever the outcome.

/** Where a step sits in the workflow; phases run in this order. */
export type StepPhase = 'main' | 'on-failure' | 'cleanup';

/** One step as the engine persists it. */
export interface PlannedStep {
  /** Unique within the workflow: `main.3`, `main.3.on-failure`, `cleanup.1`. */
  id: string;
  index: number;
  phase: StepPhase;
  /** on-failure: the step whose failure runs it. cleanup from a step definition: the step it cleans up after. */
  parentId?: string;
  /** What the step does: the step id or driver operation, e.g. `power.setPower`. */
  action: string;
  /** The driver id for driver operations, from the profile's `drivers`. */
  driver?: string;
  runsOn: RunsOn;
  /** Agent steps: the command kind sent (`driver.invoke` for driver operations). */
  commandKind?: string;
  args: Record<string, Json>;
  retries: number;
  timeoutMs: number;
  await?: 'rejoin';
  /** How a failure (after retries) continues; an on-failure step is its own row. */
  onFailure: 'fail' | 'rescue' | 'continue' | 'step';
  when?: string;
}

/** Looks up registered steps by id. */
export interface StepRegistry {
  get(id: string): StepDefinition | undefined;
}

/** A step registry over a list of definitions; a duplicate id is `INVALID_CONFIG`. */
export function stepRegistry(steps: readonly StepDefinition[]): StepRegistry & { list(): StepDefinition[] } {
  const byId = new Map<string, StepDefinition>();
  for (const step of steps) {
    if (byId.has(step.id)) throw new ComputeError('INVALID_CONFIG', `Step ${step.id} is registered twice`);
    byId.set(step.id, step);
  }
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
}

/** The command kind of driver operations (§5.1). */
export const driverInvokeKind = 'driver.invoke';
/** Timeout of a driver operation whose profile step names none. */
export const defaultDriverTimeoutMs = 10 * 60_000;
/** A workflow holds at most this many steps, all phases together. */
export const maxWorkflowSteps = 512;

/** Driver concerns a profile step may address directly as `<concern>.<operation>` (§11.3). */
export const driverConcerns: readonly string[] = [
  'power',
  'management',
  'boot',
  'deploy',
  'inspect',
  'virtual-media',
  'console',
  'bios',
  'raid',
  'firmware',
  'config',
];

/** A problem found while expanding, with the profile path it concerns. */
export interface ExpansionIssue {
  path: string;
  message: string;
}

async function validateArgs(
  step: StepDefinition,
  args: Record<string, Json>,
  path: string,
  issues: ExpansionIssue[],
): Promise<Record<string, Json>> {
  const result = await step.input['~standard'].validate(args);
  if ('issues' in result && result.issues) {
    for (const issue of result.issues) {
      const where = (issue.path ?? [])
        .map((segment) => (typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment)))
        .join('.');
      issues.push({ path: where ? `${path}.with.${where}` : `${path}.with`, message: issue.message });
    }
    return args;
  }
  return ((result as { value: unknown }).value ?? {}) as Record<string, Json>;
}

interface Resolved {
  action: string;
  runsOn: RunsOn;
  commandKind?: string;
  driver?: string;
  args: Record<string, Json>;
  retries: number;
  timeoutMs: number;
  await?: 'rejoin';
  definition?: StepDefinition;
}

async function resolve(
  step: ProfileStep,
  profile: ProfileDocument,
  registry: StepRegistry,
  path: string,
  issues: ExpansionIssue[],
): Promise<Resolved | undefined> {
  const candidates = step.fallback ? [step.use, step.fallback] : [step.use];
  const args = (step.with ?? {}) as Record<string, Json>;
  for (const use of candidates) {
    const definition = registry.get(use);
    if (definition) {
      if (step.on !== undefined && step.on !== definition.runsOn && !stepRelays(definition).includes(step.on)) {
        issues.push({ path: `${path}.on`, message: `${use} runs on ${definition.runsOn}, not ${step.on}` });
        return undefined;
      }
      const resolved: Resolved = {
        action: use,
        runsOn: definition.runsOn,
        args: await validateArgs(definition, args, path, issues),
        retries: step.retries ?? definition.retries ?? 0,
        timeoutMs: parseDuration(step.timeout ?? definition.timeout),
        definition,
      };
      if (definition.command) resolved.commandKind = definition.command;
      const awaits = step.await ?? definition.await;
      if (awaits) resolved.await = awaits;
      return resolved;
    }
    const dot = use.indexOf('.');
    const concern = use.slice(0, dot);
    if (dot > 0 && step.on !== undefined && step.on !== 'control-plane' && driverConcerns.includes(concern)) {
      const binding = profile.drivers?.[concern];
      const driver = typeof binding === 'string' ? binding : binding?.driver;
      const config = typeof binding === 'object' ? binding.config : undefined;
      const payload: Record<string, Json> = { concern, operation: use.slice(dot + 1), args };
      if (driver) payload.driver = driver;
      if (config) payload.config = config as Json;
      const resolved: Resolved = {
        action: use,
        runsOn: step.on,
        commandKind: driverInvokeKind,
        args: payload,
        retries: step.retries ?? 0,
        timeoutMs: step.timeout !== undefined ? parseDuration(step.timeout) : defaultDriverTimeoutMs,
      };
      if (driver) resolved.driver = driver;
      if (step.await) resolved.await = step.await;
      return resolved;
    }
  }
  issues.push({
    path: `${path}.use`,
    message: step.on
      ? `${candidates.join(' / ')} is neither a registered step nor a driver operation (<concern>.<operation>)`
      : `${candidates.join(' / ')} is not a registered step (driver operations need on:)`,
  });
  return undefined;
}

/** The result of expanding a profile. */
export interface Expansion {
  steps: PlannedStep[];
  issues: ExpansionIssue[];
}

/**
 * Expands a profile into its workflow steps without throwing: `issues` lists every step that does
 * not resolve or whose `with:` its step's input manifest rejects (what `profiles.validate`
 * reports). `steps` is only complete when `issues` is empty.
 */
export async function expandProfile(profile: ProfileDocument, registry: StepRegistry): Promise<Expansion> {
  const issues: ExpansionIssue[] = [];
  const steps: PlannedStep[] = [];
  const cleanups: PlannedStep[] = [];
  const failureSteps: PlannedStep[] = [];
  let mainCount = 0;

  const main = [
    ...(profile.steps ?? []).map((step, i) => ({ step, path: `steps[${i}]` })),
    ...(profile.acceptance ?? []).map((step, i) => ({ step, path: `acceptance[${i}]` })),
  ];
  for (const { step, path } of main) {
    const resolved = await resolve(step, profile, registry, path, issues);
    if (!resolved) continue;
    const id = `main.${++mainCount}`;
    const planned: PlannedStep = {
      id,
      index: 0,
      phase: 'main',
      action: resolved.action,
      runsOn: resolved.runsOn,
      args: resolved.args,
      retries: resolved.retries,
      timeoutMs: resolved.timeoutMs,
      onFailure: 'fail',
    };
    if (resolved.commandKind) planned.commandKind = resolved.commandKind;
    if (resolved.driver) planned.driver = resolved.driver;
    if (resolved.await) planned.await = resolved.await;
    if (step.when) planned.when = step.when;
    if (typeof step.onFailure === 'string') planned.onFailure = step.onFailure;
    else if (step.onFailure) {
      const handler = await resolve(step.onFailure, profile, registry, `${path}.onFailure`, issues);
      if (handler) {
        planned.onFailure = 'step';
        const failure: PlannedStep = {
          id: `${id}.on-failure`,
          index: 0,
          phase: 'on-failure',
          parentId: id,
          action: handler.action,
          runsOn: handler.runsOn,
          args: handler.args,
          retries: handler.retries,
          timeoutMs: handler.timeoutMs,
          onFailure: 'continue',
        };
        if (handler.commandKind) failure.commandKind = handler.commandKind;
        if (handler.driver) failure.driver = handler.driver;
        if (handler.await) failure.await = handler.await;
        failureSteps.push(failure);
      }
    }
    steps.push(planned);
    // A step definition's own cleanup runs, last in first out, if the step started.
    for (const [i, cleanup] of (resolved.definition?.cleanup ?? []).entries()) {
      const handler = await resolve(cleanup, profile, registry, `${path}(${resolved.action}).cleanup[${i}]`, issues);
      if (!handler) continue;
      const planned: PlannedStep = {
        id: `${id}.cleanup.${i + 1}`,
        index: 0,
        phase: 'cleanup',
        parentId: id,
        action: handler.action,
        runsOn: handler.runsOn,
        args: handler.args,
        retries: handler.retries,
        timeoutMs: handler.timeoutMs,
        onFailure: 'continue',
      };
      if (handler.commandKind) planned.commandKind = handler.commandKind;
      if (handler.driver) planned.driver = handler.driver;
      cleanups.unshift(planned);
    }
  }
  for (const [i, step] of (profile.cleanup ?? []).entries()) {
    const handler = await resolve(step, profile, registry, `cleanup[${i}]`, issues);
    if (!handler) continue;
    const planned: PlannedStep = {
      id: `cleanup.${i + 1}`,
      index: 0,
      phase: 'cleanup',
      action: handler.action,
      runsOn: handler.runsOn,
      args: handler.args,
      retries: handler.retries,
      timeoutMs: handler.timeoutMs,
      // A failed cleanup step never stops the rest of the cleanup.
      onFailure: 'continue',
    };
    if (handler.commandKind) planned.commandKind = handler.commandKind;
    if (handler.driver) planned.driver = handler.driver;
    if (handler.await) planned.await = handler.await;
    if (step.when) planned.when = step.when;
    cleanups.push(planned);
  }
  const all = [...steps, ...failureSteps, ...cleanups];
  if (all.length > maxWorkflowSteps)
    issues.push({ path: '', message: `expands to ${all.length} steps; the limit is ${maxWorkflowSteps}` });
  all.forEach((step, index) => (step.index = index));
  return { steps: all, issues };
}

/** Expands a profile, throwing `INVALID_INPUT` that lists the issues when it does not fully resolve. */
export async function expandProfileOrThrow(profile: ProfileDocument, registry: StepRegistry): Promise<PlannedStep[]> {
  const { steps, issues } = await expandProfile(profile, registry);
  if (issues.length > 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `Profile ${profile.id}@${profile.version} does not resolve: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
      undefined,
      { issues: issues as unknown as Json },
    );
  return steps;
}

/**
 * Evaluates a step's `when:` against the target node's labels. The grammar is deliberately small:
 * `key` (the label is present and not `false`), `!key`, `key=value`, `key!=value`, joined by
 * ` && `. An expression that parses to nothing is false.
 */
export function evaluateWhen(expression: string, labels: Readonly<Record<string, string>>): boolean {
  const terms = expression.split('&&').map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) return false;
  return terms.every((term) => {
    const notEqual = term.indexOf('!=');
    if (notEqual > 0) return labels[term.slice(0, notEqual).trim()] !== term.slice(notEqual + 2).trim();
    const equal = term.indexOf('=');
    if (equal > 0) return labels[term.slice(0, equal).trim()] === term.slice(equal + 1).trim();
    if (term.startsWith('!')) {
      const value = labels[term.slice(1).trim()];
      return value === undefined || value === 'false';
    }
    const value = labels[term];
    return value !== undefined && value !== 'false';
  });
}
