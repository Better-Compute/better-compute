import { readFile, writeFile } from 'node:fs/promises';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type CommandContext, type FlagSpec } from '../framework.js';
import { tenantFlag } from './capacity.js';

// FleetConfig as code (PLAN.md §9.2 `fleet`): export a tenant's sites, provider accounts, pools,
// offers, quotas and flavors as a document, diff a document against them, and apply it. The server
// validates the document; the CLI only reads it and reports.

interface Change {
  kind: string;
  name: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  fields?: string[];
  blocked?: string;
  note?: string;
}

interface Plan {
  summary: Record<Change['action'], number>;
  changes: Change[];
  calls: unknown[];
  blocked: boolean;
  planHash: string;
}

const fileArg = [
  {
    name: 'file',
    description: 'The FleetConfig document (JSON), or - for standard input',
    required: true,
  },
];

const pruneFlag = {
  type: 'boolean',
  description: 'Also delete what the document no longer lists (pools are archived)',
} satisfies FlagSpec;

async function readDocument(context: Pick<CommandContext, 'io' | 'path'>, source: string) {
  let text: string;
  if (source === '-') {
    if (!context.io.stdin) throw usageError('Reading - needs standard input');
    text = await context.io.stdin();
  } else text = await readFile(context.path(source), 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usageError(
      `${source} is not JSON`,
      'Write FleetConfig as JSON (fleet export prints one).',
    );
  }
}

/** One line per change that does something, e.g. `~ pool vps-fra (policy, gpuModel)`. */
export function describePlan(plan: Pick<Plan, 'changes' | 'summary'>): string[] {
  const mark = { create: '+', update: '~', delete: '-', unchanged: '=' } as const;
  const lines = plan.changes
    .filter((change) => change.action !== 'unchanged' || change.blocked || change.note)
    .map((change) => {
      let line = `${mark[change.action]} ${change.kind} ${change.name}`;
      if (change.fields?.length) line += ` (${change.fields.join(', ')})`;
      if (change.blocked) line += `  BLOCKED: ${change.blocked}`;
      else if (change.note) line += `  (${change.note})`;
      return line;
    });
  const { create, update, delete: deleted, unchanged } = plan.summary;
  lines.push(
    `${create} to create, ${update} to update, ${deleted} to delete, ${unchanged} unchanged.`,
  );
  return lines;
}

/** The server's `CONFIG_DRIFT`, with a hint saying what to do. */
function mapDrift(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === 'CONFIG_DRIFT')
    throw new CliError(
      'CONFIG_DRIFT',
      (error as Error).message,
      'Run fleet plan again and review the new plan.',
    );
  throw error;
}

export const fleetCommands = [
  defineCommand({
    name: 'fleet export',
    group: 'Fleet',
    summary: "Write the tenant's platform objects as a FleetConfig document (fleet.export)",
    description:
      'fleet export prints (or writes with --out) the sites, provider accounts, pools with their owner quotas and offers, and VPS flavors the tenant owns, keyed by name. Objects fleet did not create are named by their id; rename them in the document and the next apply keeps them. Secrets appear only as references.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      out: { type: 'string', value: 'PATH', description: 'Write the document to a new file' },
    },
    examples: ['better-compute fleet export --out fleet.json'],
    async run({ flags, api, path, note }) {
      const result = (await (await api()).call('fleet/export', { tenantId: flags.tenant! })) as {
        config: unknown;
        missing?: string[];
      };
      if (result.missing?.length)
        note(`This deployment does not run: ${result.missing.join(', ')} (left out).`);
      if (!flags.out) return result.config;
      await writeFile(path(flags.out), `${JSON.stringify(result.config, null, 2)}\n`, {
        flag: 'wx',
      });
      note(`Wrote ${path(flags.out)}.`);
      return { written: path(flags.out) };
    },
  }),
  defineCommand({
    name: 'fleet plan',
    group: 'Fleet',
    summary: 'Show what applying a FleetConfig document would change (fleet.plan)',
    description:
      "fleet plan diffs the document against the tenant's current objects and prints each change: + create, ~ update (with the fields), - delete (only with --prune), and BLOCKED for changes the platform cannot make (a site's region, a pool's class or site, dangling names). It changes nothing. The printed planHash, passed to fleet apply --plan-hash, applies exactly this plan. With --fail-on-changes it exits CHANGES_PENDING when anything would change, for drift checks in CI; a blocked plan always exits PLAN_BLOCKED.",
    target: 'token',
    args: fileArg,
    flags: {
      tenant: tenantFlag,
      prune: pruneFlag,
      'fail-on-changes': {
        type: 'boolean',
        description: 'Exit CHANGES_PENDING when the plan is not empty',
      },
      calls: { type: 'boolean', description: 'Also print the API calls apply would make' },
    },
    examples: [
      'better-compute fleet plan fleet.json',
      'better-compute fleet plan fleet.json --prune --fail-on-changes',
    ],
    async run(context) {
      const { flags, args, api, note } = context;
      const config = await readDocument(context, args[0]!);
      const plan = (await (
        await api()
      ).call('fleet/plan', {
        tenantId: flags.tenant!,
        config,
        prune: flags.prune === true,
      })) as Plan;
      for (const line of describePlan(plan)) note(line);
      const { calls, ...shown } = plan;
      const result = flags.calls ? plan : shown;
      if (plan.blocked) {
        context.print(result);
        throw new CliError(
          'PLAN_BLOCKED',
          `${plan.changes.filter((change) => change.blocked).length} change(s) cannot be applied`,
          'Fix the BLOCKED lines in the document (or create new objects instead of changing fixed fields).',
        );
      }
      if (flags['fail-on-changes'] && calls.length) {
        context.print(result);
        throw new CliError('CHANGES_PENDING', `${calls.length} call(s) would change the fleet`);
      }
      return result;
    },
  }),
  defineCommand({
    name: 'fleet status',
    group: 'Fleet',
    summary: 'Show the last applied document and whether the fleet drifted from it (fleet.status)',
    description:
      "fleet status shows the planHash, author and time of the tenant's last fleet apply, and the drift the fleet.drift job found when it last re-planned that document (every 15 minutes by default): changes made outside fleet, listed like fleet plan. With --fail-on-drift it exits FLEET_DRIFTED while there is drift, for monitoring.",
    target: 'token',
    flags: {
      tenant: tenantFlag,
      'fail-on-drift': {
        type: 'boolean',
        description: 'Exit FLEET_DRIFTED while the fleet drifted',
      },
    },
    examples: ['better-compute fleet status', 'better-compute fleet status --fail-on-drift'],
    async run({ flags, api, note, print }) {
      const status = (await (await api()).call('fleet/status', { tenantId: flags.tenant! })) as {
        applied?: { planHash: string };
        drift?: Pick<Plan, 'changes' | 'summary'>;
      };
      if (!status.applied) note('No FleetConfig document was applied for this tenant yet.');
      else if (!status.drift) note('The fleet matches the applied document.');
      else for (const line of describePlan(status.drift)) note(line);
      if (flags['fail-on-drift'] && status.drift) {
        print(status);
        throw new CliError(
          'FLEET_DRIFTED',
          'The fleet differs from the applied document',
          'Run fleet export to see the fleet, then fleet apply the document again (or update it).',
        );
      }
      return status;
    },
  }),
  defineCommand({
    name: 'fleet apply',
    group: 'Fleet',
    summary: 'Apply a FleetConfig document (fleet.plan, then fleet.apply)',
    description:
      'fleet apply plans the document, prints the changes, then applies exactly that plan. Every underlying call (sites.create, pools.*, quotas.set, flavors.*, providerAccounts.*) is decided for you before anything runs, and then all of them run in one transaction, so a denial or failure applies nothing. If the fleet changes between the plan and the apply, nothing is applied and the command exits CONFIG_DRIFT. Pass --plan-hash to apply a plan reviewed earlier with fleet plan; without --yes it only plans.',
    target: 'token',
    args: fileArg,
    flags: {
      tenant: tenantFlag,
      prune: pruneFlag,
      'plan-hash': {
        type: 'string',
        value: 'HASH',
        description: 'Apply only if the plan still has this hash (from fleet plan)',
      },
      yes: { type: 'boolean', description: 'Apply without stopping after the plan' },
    },
    validate(flags) {
      const hash = flags['plan-hash'];
      if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash))
        throw usageError('--plan-hash must be the 64-character planHash that fleet plan printed');
    },
    examples: [
      'better-compute fleet apply fleet.json --yes',
      'better-compute fleet apply fleet.json --prune --plan-hash 3f1c…',
    ],
    async run(context) {
      const { flags, args, api, note } = context;
      const config = await readDocument(context, args[0]!);
      const client = await api();
      const body = { tenantId: flags.tenant!, config, prune: flags.prune === true };
      let planHash = flags['plan-hash'];
      if (planHash === undefined) {
        const plan = (await client.call('fleet/plan', body)) as Plan;
        for (const line of describePlan(plan)) note(line);
        if (plan.blocked)
          throw new CliError(
            'PLAN_BLOCKED',
            `${plan.changes.filter((change) => change.blocked).length} change(s) cannot be applied`,
            'Fix the BLOCKED lines in the document.',
          );
        if (!plan.calls.length) return { applied: 0, planHash: plan.planHash };
        if (!flags.yes) {
          note(`Not applied. Re-run with --yes, or with --plan-hash ${plan.planHash}.`);
          return { applied: 0, planHash: plan.planHash, pending: plan.calls.length };
        }
        planHash = plan.planHash;
      }
      const result = (await client.call('fleet/apply', { ...body, planHash }).catch(mapDrift)) as {
        applied: number;
        plan: Plan;
      };
      note(`Applied ${result.applied} call(s).`);
      return { applied: result.applied, planHash: result.plan.planHash };
    },
  }),
];
