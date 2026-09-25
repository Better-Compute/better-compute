import { readFile } from 'node:fs/promises';
import { parseDuration } from '@better-compute/core';
import { usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { newIdempotencyKey, tenantFlag } from './capacity.js';

// Fleet operations (PLAN.md §9.3: commands mirror the API groups): bcd releases and their wave rollouts, a node's
// workflows (provisioning, drains, metal steps) and its queued commands. Each is the API call as
// BETTER_COMPUTE_TOKEN, in process or with --url.

const rolloutArg = [{ name: 'rollout', description: 'The rollout id (rollout_…)', required: true }];
const workflowArg = [{ name: 'workflow', description: 'The workflow id (wf_…)', required: true }];
const commandArg = [{ name: 'command', description: 'The command id (cmd_…)', required: true }];
const nodeFlag = {
  type: 'string',
  value: 'ID',
  required: true,
  description: 'The node (node_…)',
} as const;

function id(args: string[], prefix: string, what: string): string {
  const value = args[0]!;
  if (!new RegExp(`^${prefix}_[0-9a-z]{26,52}$`).test(value))
    throw usageError(`${value} is not a ${what} id (${prefix}_…)`);
  return value;
}

/** A duration flag in whole seconds within bounds (`10m` → 600). */
function seconds(value: string, flag: string, min: number, max: number): number {
  let ms: number;
  try {
    ms = parseDuration(value);
  } catch {
    throw usageError(`--${flag} ${value}: a duration looks like 30s, 10m or 2h`);
  }
  if (ms % 1000 !== 0 || ms / 1000 < min || ms / 1000 > max)
    throw usageError(`--${flag} must be whole seconds from ${min}s to ${max}s`);
  return ms / 1000;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const workflowChange = (name: 'abort' | 'pause' | 'resume', summary: string) =>
  defineCommand({
    name: `workflows ${name}`,
    group: 'Operations',
    summary,
    target: 'token',
    args: workflowArg,
    flags: {
      tenant: tenantFlag,
      node: nodeFlag,
      ...(name === 'abort'
        ? {
            reason: {
              type: 'string',
              value: 'TEXT',
              description: 'Recorded on the workflow',
            } as const,
          }
        : {}),
    },
    examples: [`better-compute workflows ${name} wf_01k5w… --node node_01k5w…`],
    async run({ flags, args, api }) {
      const reason = (flags as { reason?: string }).reason;
      return (await api()).call(`workflows/${name}`, {
        tenantId: flags.tenant,
        nodeId: flags.node,
        workflowId: id(args, 'wf', 'workflow'),
        ...(reason ? { reason } : {}),
      });
    },
  });

export const operationCommands = [
  defineCommand({
    name: 'releases register',
    group: 'Operations',
    summary: 'Register a signed bcd release manifest for rollouts (releases.register)',
    description:
      'releases register sends a published manifest.json ({ manifest, signatures }) as it is; the server checks the signatures against its release keys. Decided as compute:fleet:admin.',
    target: 'token',
    args: [{ name: 'manifest', description: 'The manifest.json file', required: true }],
    flags: { tenant: tenantFlag },
    examples: ['better-compute releases register ./dist/manifest.json'],
    async run({ flags, args, path, api }) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(await readFile(path(args[0]!), 'utf8'));
      } catch {
        throw usageError(`${args[0]} is not a readable JSON manifest`);
      }
      return (await api()).call('releases/register', { tenantId: flags.tenant, manifest });
    },
  }),
  defineCommand({
    name: 'releases list',
    group: 'Operations',
    summary: 'List the registered bcd releases (releases.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: { tenant: tenantFlag },
    examples: ['better-compute releases list'],
    async run({ flags, api }) {
      return (await api()).call('releases/list', { tenantId: flags.tenant });
    },
  }),
  defineCommand({
    name: 'rollouts create',
    group: 'Operations',
    summary: 'Roll a registered bcd release out in waves (rollouts.create)',
    description:
      'rollouts create upgrades the nodes of --pools (default: every pool the tenant owns) to --version in cumulative --waves of percentages (default 1,10,50,100). Each wave soaks --soak (default 10m) before the next, a node has --upgrade-timeout (default 15m) to come back on the new version, and more than --max-failure-ratio failed nodes (default 0.05) pause the rollout. Decided as compute:fleet:admin.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      version: {
        type: 'string',
        value: 'SEMVER',
        required: true,
        description: 'The registered release',
      },
      pools: { type: 'string', value: 'ID,…', description: 'The pools to upgrade (pool_…)' },
      waves: {
        type: 'string',
        value: 'PCT,…',
        description: 'Cumulative percentages ending at 100',
      },
      'max-failure-ratio': {
        type: 'string',
        value: 'RATIO',
        description: 'The failed share that pauses it (0–1)',
      },
      soak: { type: 'string', value: 'DURATION', description: 'How long each wave soaks' },
      'upgrade-timeout': {
        type: 'string',
        value: 'DURATION',
        description: 'How long a node has to come back',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry the same request',
      },
    },
    examples: ['better-compute rollouts create --version 0.9.1 --waves 5,25,100 --soak 30m'],
    async run({ flags, api }) {
      const waves = list(flags.waves).map(Number);
      if (waves.some((wave) => !Number.isInteger(wave) || wave < 1 || wave > 100))
        throw usageError('--waves takes whole percentages from 1 to 100, like 1,10,50,100');
      if (
        waves.length &&
        (waves.at(-1) !== 100 || waves.some((wave, index) => index && wave <= waves[index - 1]!))
      )
        throw usageError('--waves must increase and end at 100');
      let ratio: number | undefined;
      if (flags['max-failure-ratio'] !== undefined) {
        ratio = Number(flags['max-failure-ratio']);
        if (!(ratio >= 0 && ratio <= 1))
          throw usageError('--max-failure-ratio is a number from 0 to 1');
      }
      const pools = list(flags.pools);
      return (await api()).call('rollouts/create', {
        tenantId: flags.tenant,
        version: flags.version,
        ...(pools.length ? { poolIds: pools } : {}),
        ...(waves.length ? { waves } : {}),
        ...(ratio !== undefined ? { maxFailureRatio: ratio } : {}),
        ...(flags.soak ? { soakSeconds: seconds(flags.soak, 'soak', 0, 604_800) } : {}),
        ...(flags['upgrade-timeout']
          ? {
              upgradeTimeoutSeconds: seconds(
                flags['upgrade-timeout'],
                'upgrade-timeout',
                60,
                86_400,
              ),
            }
          : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'rollouts list',
    group: 'Operations',
    summary: 'List rollouts (rollouts.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: { tenant: tenantFlag },
    examples: ['better-compute rollouts list'],
    async run({ flags, api }) {
      return (await api()).call('rollouts/list', { tenantId: flags.tenant });
    },
  }),
  defineCommand({
    name: 'rollouts get',
    group: 'Operations',
    summary: 'Show a rollout: its waves and per-node progress (rollouts.get)',
    target: 'token',
    args: rolloutArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute rollouts get rollout_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('rollouts/get', {
        tenantId: flags.tenant,
        rolloutId: id(args, 'rollout', 'rollout'),
      });
    },
  }),
  defineCommand({
    name: 'rollouts pause',
    group: 'Operations',
    summary: 'Pause a rollout before its next wave (rollouts.pause)',
    target: 'token',
    args: rolloutArg,
    flags: {
      tenant: tenantFlag,
      reason: { type: 'string', value: 'TEXT', description: 'Recorded on the rollout' },
    },
    examples: ['better-compute rollouts pause rollout_01k5w… --reason "XIDs after wave 2"'],
    async run({ flags, args, api }) {
      return (await api()).call('rollouts/pause', {
        tenantId: flags.tenant,
        rolloutId: id(args, 'rollout', 'rollout'),
        ...(flags.reason ? { reason: flags.reason } : {}),
      });
    },
  }),
  defineCommand({
    name: 'rollouts resume',
    group: 'Operations',
    summary: 'Resume a paused rollout (rollouts.resume)',
    target: 'token',
    args: rolloutArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute rollouts resume rollout_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('rollouts/resume', {
        tenantId: flags.tenant,
        rolloutId: id(args, 'rollout', 'rollout'),
      });
    },
  }),
  defineCommand({
    name: 'rollouts abort',
    group: 'Operations',
    summary: 'Stop a rollout for good, optionally rolling nodes back (rollouts.abort)',
    description:
      'rollouts abort ends the rollout: no further node is upgraded. --rollback also swaps back the nodes whose upgrade is not confirmed yet. A node that confirmed the new release keeps it (it never goes below its release floor), so a bad release is undone by rolling a newer one forward.',
    target: 'token',
    args: rolloutArg,
    flags: {
      tenant: tenantFlag,
      reason: { type: 'string', value: 'TEXT', description: 'Recorded on the rollout' },
      rollback: { type: 'boolean', description: 'Also swap back upgrades not confirmed yet' },
    },
    examples: [
      'better-compute rollouts abort rollout_01k5w… --rollback --reason "boot loop on H100 nodes"',
    ],
    async run({ flags, args, api }) {
      return (await api()).call('rollouts/abort', {
        tenantId: flags.tenant,
        rolloutId: id(args, 'rollout', 'rollout'),
        ...(flags.reason ? { reason: flags.reason } : {}),
        ...(flags.rollback ? { rollback: true } : {}),
      });
    },
  }),
  defineCommand({
    name: 'workflows list',
    group: 'Operations',
    summary: 'List a node’s workflows, newest first (workflows.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      node: nodeFlag,
      limit: {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 100,
        description: 'Page size (at most 100)',
      },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: ['better-compute workflows list --node node_01k5w…'],
    async run({ flags, api }) {
      return (await api()).call('workflows/list', {
        tenantId: flags.tenant,
        nodeId: flags.node,
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'workflows get',
    group: 'Operations',
    summary: 'Show a workflow and its steps (workflows.get)',
    target: 'token',
    args: workflowArg,
    flags: { tenant: tenantFlag, node: nodeFlag },
    examples: ['better-compute workflows get wf_01k5w… --node node_01k5w… --query steps'],
    async run({ flags, args, api }) {
      return (await api()).call('workflows/get', {
        tenantId: flags.tenant,
        nodeId: flags.node,
        workflowId: id(args, 'wf', 'workflow'),
      });
    },
  }),
  workflowChange(
    'abort',
    'Abort a workflow: pending steps are cancelled, its cleanup still runs (workflows.abort)',
  ),
  workflowChange(
    'pause',
    'Pause a workflow: the step in flight finishes, no further one starts (workflows.pause)',
  ),
  workflowChange('resume', 'Resume a paused workflow (workflows.resume)'),
  defineCommand({
    name: 'workflows retry',
    group: 'Operations',
    summary: 'Retry a failed workflow, from a step (workflows.retry)',
    target: 'token',
    args: workflowArg,
    flags: {
      tenant: tenantFlag,
      node: nodeFlag,
      'from-step': {
        type: 'string',
        value: 'STEP',
        description: 'Start here (default: the first main step that did not succeed)',
      },
    },
    examples: ['better-compute workflows retry wf_01k5w… --node node_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('workflows/retry', {
        tenantId: flags.tenant,
        nodeId: flags.node,
        workflowId: id(args, 'wf', 'workflow'),
        ...(flags['from-step'] ? { fromStep: flags['from-step'] } : {}),
      });
    },
  }),
  defineCommand({
    name: 'commands list',
    group: 'Operations',
    summary: 'List the commands queued for a node, newest first (commands.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      node: nodeFlag,
      state: {
        type: 'string',
        value: 'STATE',
        choices: [
          'pending',
          'dispatched',
          'acked',
          'running',
          'succeeded',
          'failed',
          'rejected',
          'expired',
          'cancelled',
        ],
        description: 'Only commands in this state',
      },
      limit: {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 200,
        description: 'Page size (at most 200)',
      },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: ['better-compute commands list --node node_01k5w… --state failed'],
    async run({ flags, api }) {
      return (await api()).call('commands/list', {
        tenantId: flags.tenant,
        nodeId: flags.node,
        ...(flags.state ? { state: flags.state } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'commands get',
    group: 'Operations',
    summary: 'Show one command and its result (commands.get)',
    target: 'token',
    args: commandArg,
    flags: { tenant: tenantFlag, node: nodeFlag },
    examples: ['better-compute commands get cmd_01k5w… --node node_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('commands/get', {
        tenantId: flags.tenant,
        nodeId: flags.node,
        commandId: id(args, 'cmd', 'command'),
      });
    },
  }),
  defineCommand({
    name: 'commands cancel',
    group: 'Operations',
    summary:
      'Cancel a command: a pending one never runs, a running one is asked to stop (commands.cancel)',
    target: 'token',
    args: commandArg,
    flags: { tenant: tenantFlag, node: nodeFlag },
    examples: ['better-compute commands cancel cmd_01k5w… --node node_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('commands/cancel', {
        tenantId: flags.tenant,
        nodeId: flags.node,
        commandId: id(args, 'cmd', 'command'),
      });
    },
  }),
];
