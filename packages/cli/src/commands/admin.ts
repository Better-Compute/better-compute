import { readFile } from 'node:fs/promises';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { newIdempotencyKey, tenantFlag } from './capacity.js';
import { writeNewFile } from './catalog.js';

// Pools, join requests, inventory, secrets, site tokens and drivers (PLAN.md §9.3: commands mirror the API
// groups). Each is the API call as BETTER_COMPUTE_TOKEN, in process or with --url. Secret values never come from
// the command line (shell history, the process list): a file or standard input only.

function id(value: string, prefix: string, what: string): string {
  if (!new RegExp(`^${prefix}_[0-9a-z]{26,52}$`).test(value))
    throw usageError(`${value} is not a ${what} id (${prefix}_…)`);
  return value;
}

/** `gpus=64,vcpu=512` → `{ gpus: 64, vcpu: 512 }` (whole, non-negative limits). */
function quota(value: string, flag: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const match = /^([A-Za-z][A-Za-z0-9._-]{0,63})=(\d{1,15})$/.exec(pair);
    if (!match) throw usageError(`--${flag} ${pair}: use RESOURCE=N, e.g. gpus=64`);
    out[match[1]!] = Number(match[2]);
  }
  if (!Object.keys(out).length) throw usageError(`--${flag} needs at least one RESOURCE=N`);
  return out;
}

async function jsonFile(path: string, flag: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw usageError(`--${flag} ${path} is not a readable JSON file`);
  }
}

const poolArg = [{ name: 'pool', description: 'The pool id (pool_…)', required: true }];
const nodeArg = [{ name: 'node', description: 'The node id (node_…)', required: true }];
const poolFlag = { type: 'string', value: 'ID', required: true, description: 'The pool' } as const;

export const adminCommands = [
  // Pools (pools list is with the capacity commands).
  defineCommand({
    name: 'pools get',
    group: 'Pools',
    summary: 'Show a pool: its class, policy and offers (pools.get)',
    target: 'token',
    args: poolArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute pools get pool_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('pools/get', {
        tenantId: flags.tenant,
        poolId: id(args[0]!, 'pool', 'pool'),
      });
    },
  }),
  defineCommand({
    name: 'pools create',
    group: 'Pools',
    summary: 'Create a pool in a site (pools.create)',
    description:
      'pools create makes a --class pool in --site, owned by the tenant. --policy-file is a PoolPolicy as JSON; --owner-quota sets the owner’s own limits (default: unlimited GPUs). Provider pools name their --provider-account and run no agent. Decided as compute:pools:create.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      site: { type: 'string', value: 'ID', required: true, description: 'The site (site_…)' },
      class: {
        type: 'string',
        value: 'CLASS',
        required: true,
        choices: ['metal-host', 'metal-dedicated', 'vps-host', 'provider'],
        description: 'The pool class',
      },
      'gpu-model': {
        type: 'string',
        value: 'MODEL',
        description: 'The GPU model it holds (H100, …)',
      },
      sharing: {
        type: 'string',
        value: 'MODE',
        choices: ['exclusive', 'mig', 'timeslice', 'mps'],
        description: 'How GPUs are shared (default exclusive)',
      },
      'policy-file': { type: 'string', value: 'PATH', description: 'The PoolPolicy, as JSON' },
      'owner-quota': {
        type: 'string',
        value: 'RES=N,…',
        description: 'The owner’s limits, e.g. gpus=64',
      },
      'provider-account': {
        type: 'string',
        value: 'ID',
        description: 'Provider pools: the account (pacct_…)',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key: a retry returns the same pool',
      },
    },
    examples: [
      'better-compute pools create --site site_01k5w… --class metal-host --gpu-model H100 --owner-quota gpus=64',
    ],
    async run({ flags, path, api }) {
      const provider = flags.class === 'provider';
      if (provider !== Boolean(flags['provider-account']))
        throw usageError(
          provider
            ? 'A provider pool needs --provider-account'
            : '--provider-account is for provider pools',
        );
      return (await api()).call('pools/create', {
        tenantId: flags.tenant,
        siteId: flags.site,
        class: flags.class,
        ...(flags['gpu-model'] ? { gpuModel: flags['gpu-model'] } : {}),
        ...(flags.sharing ? { sharing: flags.sharing } : {}),
        ...(flags['policy-file']
          ? { policy: await jsonFile(path(flags['policy-file']), 'policy-file') }
          : {}),
        ...(flags['owner-quota'] ? { ownerQuota: quota(flags['owner-quota'], 'owner-quota') } : {}),
        ...(provider ? { agent: 'none', providerAccountId: flags['provider-account'] } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'pools update',
    group: 'Pools',
    summary: 'Replace a pool’s policy or change its GPU model (pools.update)',
    target: 'token',
    args: poolArg,
    flags: {
      tenant: tenantFlag,
      'policy-file': {
        type: 'string',
        value: 'PATH',
        description: 'The new PoolPolicy, as JSON (replaces the old one)',
      },
      'gpu-model': { type: 'string', value: 'MODEL', description: 'The new GPU model' },
    },
    examples: ['better-compute pools update pool_01k5w… --policy-file policy.json'],
    async run({ flags, args, path, api }) {
      if (!flags['policy-file'] && !flags['gpu-model'])
        throw usageError('Pass --policy-file or --gpu-model');
      return (await api()).call('pools/update', {
        tenantId: flags.tenant,
        poolId: id(args[0]!, 'pool', 'pool'),
        ...(flags['policy-file']
          ? { policy: await jsonFile(path(flags['policy-file']), 'policy-file') }
          : {}),
        ...(flags['gpu-model'] ? { gpuModel: flags['gpu-model'] } : {}),
      });
    },
  }),
  defineCommand({
    name: 'pools archive',
    group: 'Pools',
    summary: 'Archive a pool (pools.archive)',
    target: 'token',
    args: poolArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute pools archive pool_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('pools/archive', {
        tenantId: flags.tenant,
        poolId: id(args[0]!, 'pool', 'pool'),
      });
    },
  }),
  defineCommand({
    name: 'pools offer',
    group: 'Pools',
    summary: 'Offer a pool to another tenant with a quota (pools.offer)',
    target: 'token',
    args: poolArg,
    flags: {
      tenant: tenantFlag,
      to: {
        type: 'string',
        value: 'TENANT',
        required: true,
        description: 'The tenant it is offered to',
      },
      quota: {
        type: 'string',
        value: 'RES=N,…',
        required: true,
        description: 'That tenant’s limits, e.g. gpus=8',
      },
      'include-descendants': { type: 'boolean', description: 'Also that tenant’s child tenants' },
      priority: {
        type: 'integer',
        value: 'N',
        min: -1000,
        max: 1000,
        description: 'Scheduling priority',
      },
    },
    examples: ['better-compute pools offer pool_01k5w… --to org_research --quota gpus=16'],
    async run({ flags, args, api }) {
      return (await api()).call('pools/offer', {
        tenantId: flags.tenant,
        poolId: id(args[0]!, 'pool', 'pool'),
        toTenantId: flags.to,
        quota: quota(flags.quota!, 'quota'),
        ...(flags['include-descendants'] ? { includeDescendants: true } : {}),
        ...(flags.priority !== undefined ? { priority: flags.priority } : {}),
      });
    },
  }),
  defineCommand({
    name: 'pools unoffer',
    group: 'Pools',
    summary: 'Withdraw a pool’s offer to a tenant (pools.unoffer)',
    target: 'token',
    args: poolArg,
    flags: {
      tenant: tenantFlag,
      to: {
        type: 'string',
        value: 'TENANT',
        required: true,
        description: 'The tenant to withdraw it from',
      },
    },
    examples: ['better-compute pools unoffer pool_01k5w… --to org_research'],
    async run({ flags, args, api }) {
      return (await api()).call('pools/unoffer', {
        tenantId: flags.tenant,
        poolId: id(args[0]!, 'pool', 'pool'),
        toTenantId: flags.to,
      });
    },
  }),
  // Join requests: machines that asked to join without a token (discovery, attestation).
  defineCommand({
    name: 'join-requests list',
    group: 'Nodes',
    summary: 'List a pool’s join requests, pending by default (joinRequests.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      pool: poolFlag,
      state: {
        type: 'string',
        value: 'STATE',
        choices: ['pending', 'approved', 'rejected', 'expired', 'consumed', 'all'],
        description: 'Which requests (default pending)',
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
    examples: ['better-compute join-requests list --pool h100-eu'],
    async run({ flags, api }) {
      return (await api()).call('joinRequests/list', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        ...(flags.state ? { state: flags.state } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  ...(['approve', 'reject'] as const).map((verb) =>
    defineCommand({
      name: `join-requests ${verb}`,
      group: 'Nodes',
      summary:
        verb === 'approve'
          ? 'Let a machine that asked join the pool (joinRequests.approve)'
          : 'Turn a machine’s join request down (joinRequests.reject)',
      description:
        verb === 'approve'
          ? 'join-requests approve admits the machine behind the request into --pool; the approval waits --ttl seconds (default 3600) for the machine to retry. Check its claims (join-requests list) first: approving is what makes an unknown machine a node. Decided as compute:join-tokens:create.'
          : undefined,
      target: 'token',
      args: [{ name: 'request', description: 'The request id (jreq_…)', required: true }],
      flags: {
        tenant: tenantFlag,
        pool: poolFlag,
        reason: { type: 'string', value: 'TEXT', description: 'Recorded on the request' },
        ...(verb === 'approve'
          ? {
              ttl: {
                type: 'integer',
                value: 'SECONDS',
                min: 60,
                max: 86400,
                description: 'How long it may join',
              } as const,
            }
          : {}),
      },
      examples: [`better-compute join-requests ${verb} jreq_01k5w… --pool h100-eu`],
      async run({ flags, args, api }) {
        const ttl = (flags as { ttl?: number }).ttl;
        return (await api()).call(`joinRequests/${verb}`, {
          tenantId: flags.tenant,
          poolId: flags.pool,
          requestId: id(args[0]!, 'jreq', 'join request'),
          ...(flags.reason ? { reason: flags.reason } : {}),
          ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
        });
      },
    }),
  ),
  // Inventory.
  defineCommand({
    name: 'inventory get',
    group: 'Nodes',
    summary: 'Show a node’s current hardware inventory (inventory.get)',
    target: 'token',
    args: nodeArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute inventory get node_01k5w… --query gpus'],
    async run({ flags, args, api }) {
      return (await api()).call('inventory/get', {
        tenantId: flags.tenant,
        nodeId: id(args[0]!, 'node', 'node'),
      });
    },
  }),
  defineCommand({
    name: 'inventory history',
    group: 'Nodes',
    summary: 'List a node’s inventory snapshots, newest first (inventory.history)',
    target: 'token',
    args: nodeArg,
    flags: {
      tenant: tenantFlag,
      limit: {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 100,
        description: 'Page size (at most 100)',
      },
      cursor: {
        type: 'string',
        value: 'CURSOR',
        description: 'The cursor of the previous page (inv_…)',
      },
    },
    examples: ['better-compute inventory history node_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('inventory/history', {
        tenantId: flags.tenant,
        nodeId: id(args[0]!, 'node', 'node'),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'inventory diff',
    group: 'Nodes',
    summary: 'Show what changed in a node’s hardware between two snapshots (inventory.diff)',
    description:
      'inventory diff compares --from and --to (snapshot ids from inventory history, or inventory digests). Without --to it is the latest snapshot, without --from the one before --to.',
    target: 'token',
    args: nodeArg,
    flags: {
      tenant: tenantFlag,
      from: {
        type: 'string',
        value: 'SNAPSHOT',
        description: 'The older snapshot (inv_…) or digest',
      },
      to: {
        type: 'string',
        value: 'SNAPSHOT',
        description: 'The newer snapshot (inv_…) or digest',
      },
    },
    examples: ['better-compute inventory diff node_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('inventory/diff', {
        tenantId: flags.tenant,
        nodeId: id(args[0]!, 'node', 'node'),
        ...(flags.from ? { from: flags.from } : {}),
        ...(flags.to ? { to: flags.to } : {}),
      });
    },
  }),
  // Secrets.
  defineCommand({
    name: 'secrets put',
    group: 'Secrets',
    summary: 'Store a secret for secret:// references (secrets.put)',
    description:
      'secrets put stores the value of --value-file, or of standard input with --stdin, under --name; user data, sandbox environments and plugins name it as secret://<tenant>/<name>. The value never goes on the command line (shell history, the process list). --scope fleet stores a platform secret. Decided as compute:secrets:manage.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      name: { type: 'string', value: 'NAME', required: true, description: 'The secret name' },
      'value-file': { type: 'string', value: 'PATH', description: 'Read the value from this file' },
      stdin: { type: 'boolean', description: 'Read the value from standard input' },
      scope: {
        type: 'string',
        value: 'SCOPE',
        choices: ['tenant', 'fleet'],
        description: 'Default tenant',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry the same request',
      },
    },
    examples: [
      'better-compute secrets put --name hf-token --value-file ./hf-token',
      'vault read -field=token secret/hf | better-compute secrets put --name hf-token --stdin',
    ],
    async run({ flags, path, io, api }) {
      if (Boolean(flags['value-file']) === Boolean(flags.stdin))
        throw usageError('Pass exactly one of --value-file or --stdin');
      let value: string;
      if (flags.stdin) {
        if (!io.stdin)
          throw new CliError(
            'UNSUPPORTED',
            'This program cannot read standard input (CliIO.stdin)',
          );
        value = await io.stdin();
      } else {
        try {
          value = await readFile(path(flags['value-file']!), 'utf8');
        } catch {
          throw usageError(`--value-file ${flags['value-file']}: cannot read it`);
        }
      }
      // One trailing newline is the file's or the pipe's, not the secret's.
      value = value.replace(/\r?\n$/, '');
      if (!value) throw usageError('The secret value is empty');
      return (await api()).call('secrets/put', {
        tenantId: flags.tenant,
        name: flags.name,
        value,
        ...(flags.scope ? { scope: flags.scope } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'secrets delete',
    group: 'Secrets',
    summary: 'Delete a secret (secrets.delete)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      name: { type: 'string', value: 'NAME', required: true, description: 'The secret name' },
      scope: {
        type: 'string',
        value: 'SCOPE',
        choices: ['tenant', 'fleet'],
        description: 'Default tenant',
      },
    },
    examples: ['better-compute secrets delete --name hf-token'],
    async run({ flags, api }) {
      return (await api()).call('secrets/delete', {
        tenantId: flags.tenant,
        name: flags.name,
        ...(flags.scope ? { scope: flags.scope } : {}),
      });
    },
  }),
  // Site tokens: what a site agent (bcd site) joins with.
  defineCommand({
    name: 'site-tokens create',
    group: 'Nodes',
    summary: 'Create a token a site agent joins a site with (siteTokens.create)',
    description:
      'site-tokens create mints a token for up to --max-uses site agents (default 1) to join --site within --ttl seconds. It is printed once: with --out it goes to a new 0600 file instead. Decided as compute:sites:manage.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      site: { type: 'string', value: 'ID', required: true, description: 'The site (site_…)' },
      ttl: {
        type: 'integer',
        value: 'SECONDS',
        required: true,
        min: 60,
        max: 86400,
        description: 'How long it is valid',
      },
      'max-uses': {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 16,
        description: 'Site agents it admits (default 1)',
      },
      out: {
        type: 'string',
        value: 'PATH',
        description: 'Write the token to this new file instead of printing it',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry the same request',
      },
    },
    examples: [
      'better-compute site-tokens create --site site_01k5w… --ttl 3600 --out ./site-token',
    ],
    async run({ flags, path, api, note }) {
      const created = await (
        await api()
      ).call<{ token?: unknown } & Record<string, unknown>>('siteTokens/create', {
        tenantId: flags.tenant,
        siteId: flags.site,
        ttlSeconds: flags.ttl,
        ...(flags['max-uses'] !== undefined ? { maxUses: flags['max-uses'] } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
      if (!flags.out) return created;
      const { token, ...info } = created;
      if (typeof token !== 'string')
        throw new CliError(
          'INVALID_STATE',
          'The answer carries no token: a replayed --key never shows it again',
        );
      const file = path(flags.out);
      await writeNewFile(file, `${token}\n`);
      note(`Wrote the site token to ${file} (0600).`);
      return { ...info, tokenFile: file };
    },
  }),
  defineCommand({
    name: 'site-tokens revoke',
    group: 'Nodes',
    summary: 'Revoke a site token (siteTokens.revoke)',
    target: 'token',
    args: [{ name: 'token', description: 'The token id (jt_…)', required: true }],
    flags: {
      tenant: tenantFlag,
      site: { type: 'string', value: 'ID', required: true, description: 'The site' },
    },
    examples: ['better-compute site-tokens revoke jt_01k5w… --site site_01k5w…'],
    async run({ flags, args, api }) {
      if (args[0]!.includes('.')) throw usageError('Pass the token id, not the token itself');
      return (await api()).call('siteTokens/revoke', {
        tenantId: flags.tenant,
        siteId: flags.site,
        tokenId: id(args[0]!, 'jt', 'token'),
      });
    },
  }),
  defineCommand({
    name: 'drivers list',
    group: 'Pools',
    summary: 'List the drivers this deployment runs (drivers.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      kind: { type: 'string', value: 'KIND', description: 'Only this kind (runtime, bmc, …)' },
    },
    examples: ['better-compute drivers list --kind runtime'],
    async run({ flags, api }) {
      return (await api()).call('drivers/list', {
        tenantId: flags.tenant,
        ...(flags.kind ? { kind: flags.kind } : {}),
      });
    },
  }),
];
