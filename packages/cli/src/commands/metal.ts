import { readFile } from 'node:fs/promises';
import { usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { newIdempotencyKey, tenantFlag } from './capacity.js';

// Bare metal, provision profiles, provider accounts and sandbox snapshots (PLAN.md §9.3: commands mirror the API
// groups). Each is the API call as BETTER_COMPUTE_TOKEN, in process or with --url. Credentials never come from the
// command line: a secret:// (vault://, env://) reference, or a password file.

const nodeArg = [{ name: 'node', description: 'The node id (node_…)', required: true }];

function id(value: string, prefix: string, what: string): string {
  if (!new RegExp(`^${prefix}_[0-9a-z]{26,52}$`).test(value)) throw usageError(`${value} is not a ${what} id (${prefix}_…)`);
  return value;
}

async function jsonFile(path: string, flag: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw usageError(`--${flag} ${path} is not a readable JSON file`);
  }
}

/** One lifecycle verb on one node, with the API's own summary. */
function metalVerb(verb: 'manage' | 'inspect' | 'provide' | 'rescue' | 'unrescue' | 'recover' | 'retire', summary: string) {
  return defineCommand({
    name: `metal ${verb}`,
    group: 'Metal',
    summary: `${summary} (metal.${verb})`,
    target: 'token',
    args: nodeArg,
    flags: { tenant: tenantFlag },
    examples: [`better-compute metal ${verb} node_01k5w…`],
    async run({ flags, args, api }) {
      return (await api()).call(`metal/${verb}`, { tenantId: flags.tenant, nodeId: id(args[0]!, 'node', 'node') });
    },
  });
}

const wipeFlag = {
  type: 'string',
  value: 'MODE',
  choices: ['none', 'quick', 'secure-erase', 'crypto-erase'],
  description: 'How the disks are wiped (default quick)',
} as const;

export const metalCommands = [
  defineCommand({
    name: 'metal enroll',
    group: 'Metal',
    summary: 'Enroll a machine by its BMC into a pool (metal.enroll)',
    description:
      'metal enroll creates a node in --pool of --site from its BMC (--bmc-address, --bmc-driver) and queues BMC verification, inspection and commissioning. The BMC credentials are a reference (--bmc-credentials secret://…, vault://… or env://…), or --bmc-username with --bmc-password-file, which the server stores in its secret broker at once and never echoes. --bmc-tls-spki pins the BMC certificate. Decided as compute:nodes:provision.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      site: { type: 'string', value: 'ID', required: true, description: 'The site the machine is in' },
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool it joins' },
      'bmc-address': { type: 'string', value: 'HOST|URL', required: true, description: 'The BMC address' },
      'bmc-driver': { type: 'string', value: 'DRIVER', required: true, description: 'The BMC driver, e.g. redfish' },
      'bmc-credentials': { type: 'string', value: 'REF', description: 'secret://, vault:// or env:// reference' },
      'bmc-username': { type: 'string', value: 'USER', description: 'With --bmc-password-file, instead of a reference' },
      'bmc-password-file': { type: 'string', value: 'PATH', description: 'A file holding the BMC password' },
      'bmc-tls-spki': { type: 'string', value: 'HEX', description: 'SHA-256 of the BMC certificate’s public key' },
      macs: { type: 'string', value: 'MAC,…', description: 'Its MAC addresses, for PXE and matching' },
      'product-uuid': { type: 'string', value: 'UUID', description: 'Its SMBIOS product UUID' },
      arch: { type: 'string', value: 'ARCH', choices: ['x86_64', 'arm64'], description: 'Default x86_64' },
      'legacy-bios': { type: 'boolean', description: 'Boots in legacy BIOS mode, not UEFI' },
      'hardware-profile': { type: 'string', value: 'NAME', description: 'Overrides the pool’s hardware profile' },
    },
    examples: [
      'better-compute metal enroll --site site_01k5w… --pool pool_01k5w… --bmc-address 10.20.0.14 --bmc-driver redfish --bmc-credentials secret://org_acme/bmc-r12',
    ],
    async run({ flags, path, api }) {
      const inline = Boolean(flags['bmc-username']) || Boolean(flags['bmc-password-file']);
      if (Boolean(flags['bmc-credentials']) === inline)
        throw usageError('Pass --bmc-credentials, or --bmc-username with --bmc-password-file');
      let credentials: string | { username: string; password: string };
      if (flags['bmc-credentials']) {
        if (!/^(secret|vault|env):\/\/\S+$/.test(flags['bmc-credentials']))
          throw usageError('--bmc-credentials is a secret://, vault:// or env:// reference');
        credentials = flags['bmc-credentials'];
      } else {
        if (!flags['bmc-username'] || !flags['bmc-password-file'])
          throw usageError('--bmc-username and --bmc-password-file go together');
        let password: string;
        try {
          password = (await readFile(path(flags['bmc-password-file']), 'utf8')).replace(/\r?\n$/, '');
        } catch {
          throw usageError(`--bmc-password-file ${flags['bmc-password-file']}: cannot read it`);
        }
        if (!password) throw usageError('The BMC password file is empty');
        credentials = { username: flags['bmc-username'], password };
      }
      const macs = (flags.macs ?? '')
        .split(',')
        .map((mac) => mac.trim())
        .filter(Boolean);
      return (await api()).call('metal/enroll', {
        tenantId: flags.tenant,
        siteId: flags.site,
        poolId: flags.pool,
        bmc: {
          address: flags['bmc-address'],
          driver: flags['bmc-driver'],
          credentials,
          ...(flags['bmc-tls-spki'] ? { tlsSpkiSha256: flags['bmc-tls-spki'] } : {}),
        },
        ...(macs.length ? { macs } : {}),
        ...(flags['product-uuid'] ? { productUuid: flags['product-uuid'] } : {}),
        ...(flags.arch ? { arch: flags.arch } : {}),
        ...(flags['legacy-bios'] ? { uefi: false } : {}),
        ...(flags['hardware-profile'] ? { hardwareProfile: flags['hardware-profile'] } : {}),
      });
    },
  }),
  metalVerb('manage', 'Re-verify a ready node’s BMC access, then re-inspect and re-commission it'),
  metalVerb('inspect', 'Boot a ready node into the ramdisk to report its inventory'),
  metalVerb('provide', 'Commission a ready node: diagnostics, a quick wipe, power off'),
  metalVerb('rescue', 'Boot a deployed node into the rescue ramdisk'),
  metalVerb('unrescue', 'Boot a rescued node back into its installed OS'),
  metalVerb('recover', 'Move a failed node back to the last stable point for the state it failed in'),
  metalVerb('retire', 'Retire a node: its retiring workflow erases its disks and powers it off'),
  defineCommand({
    name: 'metal deploy',
    group: 'Metal',
    summary: 'Deploy a provision profile version on a ready node (metal.deploy)',
    target: 'token',
    args: nodeArg,
    flags: {
      tenant: tenantFlag,
      profile: { type: 'string', value: 'ID', required: true, description: 'The provision profile' },
      'profile-version': { type: 'integer', value: 'N', required: true, min: 1, description: 'Its version' },
    },
    examples: ['better-compute metal deploy node_01k5w… --profile ubuntu-gpu --profile-version 3'],
    async run({ flags, args, api }) {
      return (await api()).call('metal/deploy', {
        tenantId: flags.tenant,
        nodeId: id(args[0]!, 'node', 'node'),
        profileId: flags.profile,
        profileVersion: flags['profile-version'],
      });
    },
  }),
  defineCommand({
    name: 'metal undeploy',
    group: 'Metal',
    summary: 'Release a deployed node: wipe its disks and power it off (metal.undeploy)',
    target: 'token',
    args: nodeArg,
    flags: { tenant: tenantFlag, wipe: wipeFlag },
    examples: ['better-compute metal undeploy node_01k5w… --wipe secure-erase'],
    async run({ flags, args, api }) {
      return (await api()).call('metal/undeploy', {
        tenantId: flags.tenant,
        nodeId: id(args[0]!, 'node', 'node'),
        ...(flags.wipe ? { wipe: flags.wipe } : {}),
      });
    },
  }),
  defineCommand({
    name: 'metal abort',
    group: 'Metal',
    summary: 'Stop a node’s running workflow and mark it failed (metal.abort)',
    target: 'token',
    args: nodeArg,
    flags: { tenant: tenantFlag, reason: { type: 'string', value: 'TEXT', description: 'Recorded as its last error' } },
    examples: ['better-compute metal abort node_01k5w… --reason "wrong profile"'],
    async run({ flags, args, api }) {
      return (await api()).call('metal/abort', {
        tenantId: flags.tenant,
        nodeId: id(args[0]!, 'node', 'node'),
        ...(flags.reason ? { reason: flags.reason } : {}),
      });
    },
  }),
  defineCommand({
    name: 'metal power',
    group: 'Metal',
    summary: 'Send a BMC power action through the site agent (metal.power)',
    target: 'token',
    args: nodeArg,
    flags: {
      tenant: tenantFlag,
      action: {
        type: 'string',
        value: 'ACTION',
        required: true,
        choices: ['on', 'off', 'graceful-off', 'reset', 'graceful-restart', 'cycle', 'nmi'],
        description: 'The power action',
      },
    },
    examples: ['better-compute metal power node_01k5w… --action graceful-restart'],
    async run({ flags, args, api }) {
      return (await api()).call('metal/power', {
        tenantId: flags.tenant,
        nodeId: id(args[0]!, 'node', 'node'),
        action: flags.action,
      });
    },
  }),
  defineCommand({
    name: 'metal bulk',
    group: 'Metal',
    summary: 'Run one lifecycle verb on many nodes of a pool as one batch (metal.bulk)',
    description:
      'metal bulk runs --verb on the nodes in --nodes (comma-separated) or --nodes-file (one per line) of --pool as one batch; destructive verbs wait for the batch quorum’s approvers, who see --reason. Decided as compute:nodes:provision.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool every node is in' },
      verb: {
        type: 'string',
        value: 'VERB',
        required: true,
        choices: ['manage', 'inspect', 'provide', 'undeploy', 'rescue', 'retire'],
        description: 'The verb every node gets',
      },
      nodes: { type: 'string', value: 'ID,…', description: 'The nodes' },
      'nodes-file': { type: 'string', value: 'PATH', description: 'The nodes, one id per line' },
      wipe: wipeFlag,
      reason: { type: 'string', value: 'TEXT', required: true, description: 'What the batch is for' },
    },
    examples: ['better-compute metal bulk --pool pool_01k5w… --verb retire --nodes-file retire.txt --reason "EOL rack r12"'],
    async run({ flags, path, api }) {
      if (Boolean(flags.nodes) === Boolean(flags['nodes-file'])) throw usageError('Pass exactly one of --nodes or --nodes-file');
      let text = flags.nodes ?? '';
      if (flags['nodes-file']) {
        try {
          text = await readFile(path(flags['nodes-file']), 'utf8');
        } catch {
          throw usageError(`--nodes-file ${flags['nodes-file']}: cannot read it`);
        }
      }
      const nodeIds = [...new Set(text.split(/[\s,]+/).filter(Boolean))].map((node) => id(node, 'node', 'node'));
      if (!nodeIds.length) throw usageError('No nodes given');
      if (flags.wipe && flags.verb !== 'undeploy') throw usageError('--wipe is for --verb undeploy');
      return (await api()).call('metal/bulk', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        verb: flags.verb,
        nodeIds,
        reason: flags.reason,
        ...(flags.wipe ? { wipe: flags.wipe } : {}),
      });
    },
  }),
  // Provision profiles.
  defineCommand({
    name: 'profiles list',
    group: 'Metal',
    summary: 'List provision profiles: the tenant’s, public ones and the modules’ (profiles.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      limit: { type: 'integer', value: 'N', min: 1, max: 200, description: 'Page size (at most 200)' },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: ['better-compute profiles list'],
    async run({ flags, api }) {
      return (await api()).call('profiles/list', {
        tenantId: flags.tenant,
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  ...(['get', 'validate', 'render'] as const).map((verb) =>
    defineCommand({
      name: `profiles ${verb}`,
      group: 'Metal',
      summary: {
        get: 'Show a profile version, the latest by default (profiles.get)',
        validate: 'Check a profile version against the registered steps (profiles.validate)',
        render: 'Show the steps a workflow of a profile version would run (profiles.render)',
      }[verb],
      target: 'token',
      args: [{ name: 'profile', description: 'The profile id', required: true }],
      flags: {
        tenant: tenantFlag,
        'profile-version': { type: 'integer', value: 'N', min: 1, description: 'The version (default: the latest)' },
      },
      examples: [`better-compute profiles ${verb} ubuntu-gpu --profile-version 3`],
      async run({ flags, args, api }) {
        return (await api()).call(`profiles/${verb}`, {
          tenantId: flags.tenant,
          profileId: args[0],
          ...(flags['profile-version'] !== undefined ? { profileVersion: flags['profile-version'] } : {}),
        });
      },
    }),
  ),
  defineCommand({
    name: 'profiles create',
    group: 'Metal',
    summary: 'Store a profile version from a JSON document (profiles.create)',
    target: 'token',
    args: [{ name: 'file', description: 'The profile document (JSON: id, version, target, steps…)', required: true }],
    flags: {
      tenant: tenantFlag,
      public: { type: 'boolean', description: 'Let every tenant use it (default private)' },
    },
    examples: ['better-compute profiles create ./ubuntu-gpu.v3.json'],
    async run({ flags, args, path, api }) {
      return (await api()).call('profiles/create', {
        tenantId: flags.tenant,
        document: await jsonFile(path(args[0]!), 'file'),
        ...(flags.public ? { visibility: 'public' } : {}),
      });
    },
  }),
  defineCommand({
    name: 'profiles update',
    group: 'Metal',
    summary: 'Replace a profile version’s document or change its visibility (profiles.update)',
    target: 'token',
    args: [{ name: 'profile', description: 'The profile id', required: true }],
    flags: {
      tenant: tenantFlag,
      'profile-version': { type: 'integer', value: 'N', required: true, min: 1, description: 'The version to change' },
      file: { type: 'string', value: 'PATH', description: 'A replacement document (same id and version)' },
      visibility: { type: 'string', value: 'VIS', choices: ['private', 'public'], description: 'Who may use it' },
      'if-version': { type: 'integer', value: 'N', min: 1, description: 'Only if the row is still at this version' },
    },
    examples: ['better-compute profiles update ubuntu-gpu --profile-version 3 --visibility public'],
    async run({ flags, args, path, api }) {
      if (!flags.file && !flags.visibility) throw usageError('Pass --file or --visibility');
      return (await api()).call('profiles/update', {
        tenantId: flags.tenant,
        profileId: args[0],
        profileVersion: flags['profile-version'],
        ...(flags.file ? { document: await jsonFile(path(flags.file), 'file') } : {}),
        ...(flags.visibility ? { visibility: flags.visibility } : {}),
        ...(flags['if-version'] !== undefined ? { expectedVersion: flags['if-version'] } : {}),
      });
    },
  }),
  defineCommand({
    name: 'profiles delete',
    group: 'Metal',
    summary: 'Hide a profile version, or every version, from new workflows (profiles.delete)',
    target: 'token',
    args: [{ name: 'profile', description: 'The profile id', required: true }],
    flags: {
      tenant: tenantFlag,
      'profile-version': { type: 'integer', value: 'N', min: 1, description: 'Only this version (default: every version)' },
    },
    examples: ['better-compute profiles delete ubuntu-gpu --profile-version 2'],
    async run({ flags, args, api }) {
      return (await api()).call('profiles/delete', {
        tenantId: flags.tenant,
        profileId: args[0],
        ...(flags['profile-version'] !== undefined ? { profileVersion: flags['profile-version'] } : {}),
      });
    },
  }),
  // Provider accounts.
  defineCommand({
    name: 'provider-accounts list',
    group: 'Metal',
    summary: 'List the tenant’s provider accounts (providerAccounts.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: { tenant: tenantFlag },
    examples: ['better-compute provider-accounts list'],
    async run({ flags, api }) {
      return (await api()).call('providerAccounts/list', { tenantId: flags.tenant });
    },
  }),
  ...(['get', 'delete'] as const).map((verb) =>
    defineCommand({
      name: `provider-accounts ${verb}`,
      group: 'Metal',
      summary:
        verb === 'get'
          ? 'Show a provider account (providerAccounts.get)'
          : 'Delete a provider account no pool or instance uses (providerAccounts.delete)',
      target: 'token',
      args: [{ name: 'account', description: 'The account id (pacct_…)', required: true }],
      flags: { tenant: tenantFlag },
      examples: [`better-compute provider-accounts ${verb} pacct_01k5w…`],
      async run({ flags, args, api }) {
        return (await api()).call(`providerAccounts/${verb}`, {
          tenantId: flags.tenant,
          accountId: id(args[0]!, 'pacct', 'provider account'),
        });
      },
    }),
  ),
  defineCommand({
    name: 'provider-accounts create',
    group: 'Metal',
    summary: 'Store a provider account; its config is checked by the provider (providerAccounts.create)',
    description:
      'provider-accounts create names an account of --provider and stores --config-file (JSON), checked against the provider’s manifest. Credentials in it are secret references only (secret://…), never values.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      provider: { type: 'string', value: 'ID', required: true, description: 'The provider, e.g. provider-hetzner' },
      name: { type: 'string', value: 'NAME', required: true, description: 'The account name' },
      'config-file': { type: 'string', value: 'PATH', description: 'The account config, as JSON' },
      key: { type: 'string', value: 'KEY', description: 'Idempotency key: a retry returns the same account' },
    },
    examples: ['better-compute provider-accounts create --provider provider-hetzner --name hetzner-main --config-file hetzner.json'],
    async run({ flags, path, api }) {
      return (await api()).call('providerAccounts/create', {
        tenantId: flags.tenant,
        provider: flags.provider,
        name: flags.name,
        ...(flags['config-file'] ? { config: await jsonFile(path(flags['config-file']), 'config-file') } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'provider-accounts update',
    group: 'Metal',
    summary: 'Replace a provider account’s config (providerAccounts.update)',
    target: 'token',
    args: [{ name: 'account', description: 'The account id (pacct_…)', required: true }],
    flags: {
      tenant: tenantFlag,
      'config-file': { type: 'string', value: 'PATH', required: true, description: 'The new config, as JSON' },
    },
    examples: ['better-compute provider-accounts update pacct_01k5w… --config-file hetzner.json'],
    async run({ flags, args, path, api }) {
      return (await api()).call('providerAccounts/update', {
        tenantId: flags.tenant,
        accountId: id(args[0]!, 'pacct', 'provider account'),
        config: await jsonFile(path(flags['config-file']!), 'config-file'),
      });
    },
  }),
  defineCommand({
    name: 'provider-accounts offers',
    group: 'Metal',
    summary: 'Ask the provider which machine types the account can get (providerAccounts.offers)',
    target: 'token',
    defaultFormat: 'table',
    args: [{ name: 'account', description: 'The account id (pacct_…)', required: true }],
    flags: {
      tenant: tenantFlag,
      kind: { type: 'string', value: 'KIND', choices: ['metal', 'vps'], description: 'Only this kind' },
      region: { type: 'string', value: 'REGION', description: 'Only this provider region' },
      'gpu-model': { type: 'string', value: 'MODEL', description: 'Only this GPU model' },
    },
    examples: ['better-compute provider-accounts offers pacct_01k5w… --kind metal --gpu-model H100'],
    async run({ flags, args, api }) {
      const query = {
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...(flags.region ? { region: flags.region } : {}),
        ...(flags['gpu-model'] ? { gpuModel: flags['gpu-model'] } : {}),
      };
      return (await api()).call('providerAccounts/offers', {
        tenantId: flags.tenant,
        accountId: id(args[0]!, 'pacct', 'provider account'),
        ...(Object.keys(query).length ? { query } : {}),
      });
    },
  }),
  defineCommand({
    name: 'provider-accounts bootstrap',
    group: 'Metal',
    summary: 'Turn a provider machine into a bcd host of a pool (providerAccounts.bootstrap)',
    target: 'token',
    args: [{ name: 'account', description: 'The account id (pacct_…)', required: true }],
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The vps-host or metal-host pool it joins' },
      machine: { type: 'string', value: 'ID', description: 'A machine the account already has' },
      offer: { type: 'string', value: 'ID', description: 'An offer to order a machine from' },
      key: { type: 'string', value: 'KEY', description: 'Idempotency key, to retry the same request' },
    },
    examples: ['better-compute provider-accounts bootstrap pacct_01k5w… --pool pool_01k5w… --offer ax102-h100'],
    async run({ flags, args, api }) {
      if (Boolean(flags.machine) === Boolean(flags.offer)) throw usageError('Pass exactly one of --machine or --offer');
      return (await api()).call('providerAccounts/bootstrap', {
        tenantId: flags.tenant,
        accountId: id(args[0]!, 'pacct', 'provider account'),
        poolId: flags.pool,
        ...(flags.machine ? { machineId: flags.machine } : { offerId: flags.offer }),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  // Sandbox snapshots.
  defineCommand({
    name: 'sandbox-snapshot list',
    group: 'Sandboxes',
    summary: 'List sandbox snapshots, kept ones of deleted sandboxes too (sandboxSnapshots.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      all: { type: 'boolean', description: 'Every snapshot of the tenant, not only yours' },
      sandbox: { type: 'string', value: 'ID', description: 'Only this sandbox’s (sbx_…)' },
      limit: { type: 'integer', value: 'N', min: 1, max: 200, description: 'Page size (at most 200)' },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: ['better-compute sandbox-snapshot list --sandbox sbx_01k5w…'],
    async run({ flags, api }) {
      return (await api()).call('sandboxSnapshots/list', {
        tenantId: flags.tenant,
        ...(flags.all ? { scope: 'all' } : {}),
        ...(flags.sandbox ? { sandboxId: flags.sandbox } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  ...(['get', 'delete'] as const).map((verb) =>
    defineCommand({
      name: `sandbox-snapshot ${verb}`,
      group: 'Sandboxes',
      summary:
        verb === 'get'
          ? 'Show a sandbox snapshot and its state (sandboxSnapshots.get)'
          : 'Delete a sandbox snapshot (sandboxSnapshots.delete)',
      target: 'token',
      args: [{ name: 'snapshot', description: 'The snapshot id (snap_…)', required: true }],
      flags: { tenant: tenantFlag },
      examples: [`better-compute sandbox-snapshot ${verb} snap_01k5w…`],
      async run({ flags, args, api }) {
        return (await api()).call(`sandboxSnapshots/${verb}`, {
          tenantId: flags.tenant,
          snapshotId: id(args[0]!, 'snap', 'snapshot'),
        });
      },
    }),
  ),
];
