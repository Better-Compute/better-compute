import { readFile, writeFile } from 'node:fs/promises';
import { parseDuration } from '@better-compute/core';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { newIdempotencyKey, tenantFlag } from './capacity.js';

// Nodes, instances and join tokens (PLAN.md §9.3: commands mirror the API groups): the everyday operator calls,
// each the API call as BETTER_COMPUTE_TOKEN, in process or with --url. Everything else of a group stays one
// `better-compute api GROUP.METHOD` away.

const nodeArg = [{ name: 'node', description: 'The node id (node_…)', required: true }];
const instanceArg = [{ name: 'instance', description: 'The instance id (inst_…)', required: true }];

function nodeId(args: string[]): string {
  const id = args[0]!;
  if (!/^node_[0-9a-z]{26,52}$/.test(id)) throw usageError(`${id} is not a node id (node_…)`);
  return id;
}

function instanceId(args: string[]): string {
  const id = args[0]!;
  if (!/^inst_[0-9a-z]{26,52}$/.test(id)) throw usageError(`${id} is not an instance id (inst_…)`);
  return id;
}

/** A comma-separated list flag (`a,b,c`), without empty items. */
function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The optimistic-concurrency and audit flags every node state change takes. */
const changeFlags = {
  tenant: tenantFlag,
  reason: { type: 'string', value: 'TEXT', description: 'Why (recorded in the node’s events)' },
  'if-version': {
    type: 'integer',
    value: 'N',
    min: 1,
    description: 'Only if the node is still at this version (nodes.get’s version)',
  },
} as const;

/** One node state change (cordon, uncordon, drain) with its optional reason and expected version. */
function nodeChange(name: 'cordon' | 'uncordon' | 'drain', summary: string, description: string) {
  return defineCommand({
    name: `nodes ${name}`,
    group: 'Nodes',
    summary,
    description,
    target: 'token',
    args: nodeArg,
    flags: changeFlags,
    examples: [`better-compute nodes ${name} node_01k5w… --reason "disk replacement"`],
    async run({ flags, args, api }) {
      return (await api()).call(`nodes/${name}`, {
        tenantId: flags.tenant,
        nodeId: nodeId(args),
        ...(flags.reason ? { reason: flags.reason } : {}),
        ...(flags['if-version'] !== undefined ? { version: flags['if-version'] } : {}),
      });
    },
  });
}

export const nodeCommands = [
  defineCommand({
    name: 'nodes list',
    group: 'Nodes',
    summary: 'List the tenant’s nodes (nodes.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', description: 'Only this pool’s' },
      site: { type: 'string', value: 'ID', description: 'Only this site’s (site_…)' },
      cordoned: { type: 'boolean', description: 'Only cordoned nodes' },
      state: {
        type: 'string',
        value: 'STATE',
        choices: [
          'adopting',
          'adopted',
          'enrolling',
          'inspecting',
          'commissioning',
          'ready',
          'deploying',
          'deployed',
          'releasing',
          'rescue',
          'failed',
          'retiring',
          'retired',
        ],
        description: 'Only nodes in this provisioning state',
      },
      limit: {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 50,
        description: 'Page size (at most 50)',
      },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: [
      'better-compute nodes list --pool h100-eu',
      'better-compute nodes list --cordoned --format json',
    ],
    async run({ flags, api }) {
      return (await api()).call('nodes/list', {
        tenantId: flags.tenant,
        ...(flags.pool ? { poolId: flags.pool } : {}),
        ...(flags.site ? { siteId: flags.site } : {}),
        ...(flags.cordoned ? { cordoned: true } : {}),
        ...(flags.state ? { provisionState: flags.state } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'nodes get',
    group: 'Nodes',
    summary: 'Show one node: its state, labels, conditions and session (nodes.get)',
    target: 'token',
    args: nodeArg,
    flags: { tenant: tenantFlag },
    examples: [
      'better-compute nodes get node_01k5w…',
      'better-compute nodes get node_01k5w… --query conditions',
    ],
    async run({ flags, args, api }) {
      return (await api()).call('nodes/get', { tenantId: flags.tenant, nodeId: nodeId(args) });
    },
  }),
  defineCommand({
    name: 'nodes events',
    group: 'Nodes',
    summary: 'List a node’s events, newest first (nodes.events)',
    target: 'token',
    args: nodeArg,
    flags: {
      tenant: tenantFlag,
      type: {
        type: 'string',
        value: 'TYPE',
        description: 'Only events of this type (node.cordoned, gpu.xid, …)',
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
    examples: ['better-compute nodes events node_01k5w… --type gpu.xid'],
    async run({ flags, args, api }) {
      return (await api()).call('nodes/events', {
        tenantId: flags.tenant,
        nodeId: nodeId(args),
        ...(flags.type ? { type: flags.type } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  nodeChange(
    'cordon',
    'Stop placing new work on a node (nodes.cordon)',
    'nodes cordon keeps the scheduler from placing anything new on the node; what runs there keeps running. Decided as compute:nodes:cordon. --if-version makes it conditional on the version nodes get printed.',
  ),
  nodeChange(
    'uncordon',
    'Let the scheduler place work on a node again (nodes.uncordon)',
    'nodes uncordon undoes nodes cordon. Decided as compute:nodes:cordon.',
  ),
  nodeChange(
    'drain',
    'Cordon a node and move its work off (nodes.drain)',
    'nodes drain cordons the node and hands its allocations to the Drain controller, which releases them within the pool’s disruption budget. Decided as compute:nodes:drain; follow it with nodes events (node.draining, then the releases).',
  ),
  defineCommand({
    name: 'nodes label',
    group: 'Nodes',
    summary: 'Set or remove a node’s labels (nodes.label)',
    description:
      'nodes label sets labels from --set KEY=VALUE,… and removes the keys in --remove KEY,…; selectors (reservations, pools) match on them. Decided as compute:nodes:update.',
    target: 'token',
    args: nodeArg,
    flags: {
      tenant: tenantFlag,
      set: { type: 'string', value: 'KEY=VALUE,…', description: 'Labels to set' },
      remove: { type: 'string', value: 'KEY,…', description: 'Label keys to remove' },
      'if-version': changeFlags['if-version'],
    },
    examples: ['better-compute nodes label node_01k5w… --set rack=r12,fabric=ib-a --remove old'],
    async run({ flags, args, api }) {
      const set: Record<string, string> = {};
      for (const pair of list(flags.set)) {
        const at = pair.indexOf('=');
        if (at <= 0) throw usageError(`--set ${pair}: use KEY=VALUE`);
        set[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const remove = list(flags.remove);
      if (!Object.keys(set).length && !remove.length) throw usageError('Pass --set or --remove');
      return (await api()).call('nodes/label', {
        tenantId: flags.tenant,
        nodeId: nodeId(args),
        ...(Object.keys(set).length ? { set } : {}),
        ...(remove.length ? { remove } : {}),
        ...(flags['if-version'] !== undefined ? { version: flags['if-version'] } : {}),
      });
    },
  }),
  defineCommand({
    name: 'nodes taint',
    group: 'Nodes',
    summary: 'Add or remove a node’s taints (nodes.taint)',
    description:
      'nodes taint adds the taints in --add and removes those in --remove (comma-separated). A taint joins the node’s NoSchedule reasons as taint:<taint>, so the scheduler places nothing new there until it is removed. Decided as compute:nodes:update.',
    target: 'token',
    args: nodeArg,
    flags: {
      tenant: tenantFlag,
      add: { type: 'string', value: 'TAINT,…', description: 'Taints to add' },
      remove: { type: 'string', value: 'TAINT,…', description: 'Taints to remove' },
      'if-version': changeFlags['if-version'],
    },
    examples: ['better-compute nodes taint node_01k5w… --add gpu=degraded:NoSchedule'],
    async run({ flags, args, api }) {
      const add = list(flags.add);
      const remove = list(flags.remove);
      if (!add.length && !remove.length) throw usageError('Pass --add or --remove');
      return (await api()).call('nodes/taint', {
        tenantId: flags.tenant,
        nodeId: nodeId(args),
        ...(add.length ? { add } : {}),
        ...(remove.length ? { remove } : {}),
        ...(flags['if-version'] !== undefined ? { version: flags['if-version'] } : {}),
      });
    },
  }),
  defineCommand({
    name: 'nodes delete',
    group: 'Nodes',
    summary: 'Remove a retired or cordoned adopted node for good (nodes.delete)',
    description:
      'nodes delete tombstones a node that is retired, a cordoned adopted node (cordon it first), or one that never got past adoption or enrollment, once it holds no allocation. Its certificates are revoked and its hardware key and attestor bindings (e.g. a TPM) are freed, so the machine can join again as a new node: after a TPM swap, cordon, delete, then run `bcd join --reset --yes` and `bcd join` on the machine. It cannot be undone, so it needs --yes. Decided as compute:nodes:delete.',
    target: 'token',
    args: nodeArg,
    flags: {
      ...changeFlags,
      yes: { type: 'boolean', description: 'Confirm: the node is removed for good' },
    },
    examples: ['better-compute nodes delete node_01k5w… --reason "TPM replaced" --yes'],
    async run({ flags, args, api }) {
      const id = nodeId(args);
      if (!flags.yes) throw usageError(`nodes delete removes ${id} for good; re-run with --yes`);
      return (await api()).call('nodes/delete', {
        tenantId: flags.tenant,
        nodeId: id,
        ...(flags.reason ? { reason: flags.reason } : {}),
        ...(flags['if-version'] !== undefined ? { version: flags['if-version'] } : {}),
      });
    },
  }),
  defineCommand({
    name: 'join-tokens create',
    group: 'Nodes',
    summary: 'Create a join token for a pool: what bcd join presents (joinTokens.create)',
    description:
      "join-tokens create mints a token that lets up to --max-uses machines (default 1) join --pool for --ttl (60s to 24h). --expect-* bind it to one machine's identity (product UUID, serial, MAC or GPU UUID). --hosted kubernetes marks it for bcd as a DaemonSet (deploy/kubernetes): the cluster's admins have root on its machines, so they join tenant-controlled unless the pool's policy.kubernetes.platformOperated is true. The token is printed once and never again: with --out it goes to a new file (0600, never overwritten) instead of the output, to hand to the server out of band (the install script reads BCD_JOIN_TOKEN or stdin). Decided as compute:join-tokens:create.",
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool machines join' },
      ttl: {
        type: 'string',
        value: 'DURATION',
        required: true,
        description: 'How long it is valid: 30m, 2h (at most 24h)',
      },
      'max-uses': {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 10000,
        description: 'Machines it admits (default 1)',
      },
      'allow-reclaim': {
        type: 'boolean',
        description: 'May re-admit a machine the pool already knew',
      },
      hosted: {
        type: 'string',
        value: 'WHERE',
        choices: ['kubernetes'],
        description:
          'For bcd as a DaemonSet on a Kubernetes cluster: its nodes join tenant-controlled unless the pool says the platform operates the cluster',
      },
      'expect-product-uuid': {
        type: 'string',
        value: 'UUID',
        description: 'Only the machine with this SMBIOS product UUID',
      },
      'expect-serial': {
        type: 'string',
        value: 'SERIAL',
        description: 'Only the machine with this serial number',
      },
      'expect-mac': {
        type: 'string',
        value: 'MAC',
        description: 'Only the machine with this MAC address',
      },
      'expect-gpu-uuid': {
        type: 'string',
        value: 'GPU-…',
        description: 'Only the machine with this GPU',
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
      'better-compute join-tokens create --pool h100-eu --ttl 2h --max-uses 8 --out ./join-token',
      'better-compute join-tokens create --pool h100-eu --ttl 30m --expect-serial SN12345',
      'better-compute join-tokens create --pool k8s-gpu --ttl 2h --max-uses 16 --hosted kubernetes --out ./join-token',
    ],
    async run({ flags, path, api, note }) {
      let ttlMs: number;
      try {
        ttlMs = parseDuration(flags.ttl!);
      } catch {
        throw usageError(`--ttl ${flags.ttl}: a duration like 30m or 2h`);
      }
      if (ttlMs < 60_000 || ttlMs > 86_400_000 || ttlMs % 1000 !== 0)
        throw usageError('--ttl must be whole seconds from 1m to 24h');
      const ttlSeconds = ttlMs / 1000;
      const expect = {
        ...(flags['expect-product-uuid'] ? { productUuid: flags['expect-product-uuid'] } : {}),
        ...(flags['expect-serial'] ? { serial: flags['expect-serial'] } : {}),
        ...(flags['expect-mac'] ? { mac: flags['expect-mac'] } : {}),
        ...(flags['expect-gpu-uuid'] ? { gpuUuid: flags['expect-gpu-uuid'] } : {}),
      };
      const created = await (
        await api()
      ).call<Record<string, unknown> & { token?: string }>('joinTokens/create', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        ttlSeconds,
        ...(flags['max-uses'] !== undefined ? { maxUses: flags['max-uses'] } : {}),
        ...(flags['allow-reclaim'] ? { allowReclaim: true } : {}),
        ...(flags.hosted ? { hosted: flags.hosted } : {}),
        ...(Object.keys(expect).length ? { expect } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
      if (!flags.out) return created;
      const { token, ...info } = created;
      if (typeof token !== 'string')
        throw new CliError(
          'INVALID_STATE',
          'The answer carries no token: this --key replays an earlier request, and a token is shown only once',
          'Revoke that token (join-tokens revoke) and create a new one without --key.',
        );
      const file = path(flags.out);
      try {
        await writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new CliError(
            'ALREADY_EXISTS',
            `${file} exists; the token is never written over a file`,
          );
        throw error;
      }
      note(`Wrote the join token to ${file} (0600).`);
      return { ...info, tokenFile: file };
    },
  }),
  defineCommand({
    name: 'join-tokens list',
    group: 'Nodes',
    summary: 'List a pool’s join tokens, never their secrets (joinTokens.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool' },
      all: { type: 'boolean', description: 'Also revoked, expired and used-up tokens' },
      limit: {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 200,
        description: 'Page size (at most 200)',
      },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: ['better-compute join-tokens list --pool h100-eu'],
    async run({ flags, api }) {
      return (await api()).call('joinTokens/list', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        ...(flags.all ? { includeInactive: true } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'join-tokens revoke',
    group: 'Nodes',
    summary: 'Revoke a join token before it expires (joinTokens.revoke)',
    target: 'token',
    args: [
      { name: 'token', description: 'The token id (as join-tokens list shows it)', required: true },
    ],
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool' },
    },
    examples: ['better-compute join-tokens revoke jt_01k5w… --pool h100-eu'],
    async run({ flags, args, api }) {
      // An id, never the secret: `bcjt_<id>.<secret>` pasted here would be sent (and logged) as an id.
      if (args[0]!.includes('.')) throw usageError('Pass the token id, not the token itself');
      return (await api()).call('joinTokens/revoke', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        tokenId: args[0],
      });
    },
  }),
];

export const instanceCommands = [
  defineCommand({
    name: 'instances list',
    group: 'Instances',
    summary: 'List instances: yours, or the tenant’s with --all (instances.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      all: { type: 'boolean', description: 'Every instance of the tenant, not only yours' },
      state: {
        type: 'string',
        value: 'STATE',
        choices: [
          'pending',
          'scheduling',
          'provisioning',
          'starting',
          'running',
          'stopped',
          'rebooting',
          'resizing',
          'deleting',
          'deleted',
          'error',
          'lost',
          'paused',
        ],
        description: 'Only instances in this state',
      },
      pool: { type: 'string', value: 'ID', description: 'Only this pool’s' },
      limit: {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 200,
        description: 'Page size (at most 200)',
      },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: [
      'better-compute instances list',
      'better-compute instances list --all --state running',
    ],
    async run({ flags, api }) {
      return (await api()).call('instances/list', {
        tenantId: flags.tenant,
        ...(flags.all ? { scope: 'all' } : {}),
        ...(flags.state ? { state: flags.state } : {}),
        ...(flags.pool ? { poolId: flags.pool } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'instances get',
    group: 'Instances',
    summary: 'Show one instance (instances.get)',
    target: 'token',
    args: instanceArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute instances get inst_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('instances/get', {
        tenantId: flags.tenant,
        instanceId: instanceId(args),
      });
    },
  }),
  defineCommand({
    name: 'instances create',
    group: 'Instances',
    summary: 'Create an instance in a pool (instances.create)',
    description:
      'instances create boots --image with --flavor in --pool, decided as compute:instances:create. --ssh-key reads OpenSSH public keys from files (comma-separated paths; every non-empty line is a key), --user-data cloud-init from a file, or a secret://<tenant>/<id> reference. --stopped creates it without starting it. It waits up to --wait seconds (default 30) for the instance to settle. Every run sends a new idempotency key unless --key is given: repeat with the same --key to retry safely.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool' },
      flavor: {
        type: 'string',
        value: 'NAME',
        required: true,
        description: 'The flavor (the pool offers it)',
      },
      image: { type: 'string', value: 'ID', required: true, description: 'The image to boot' },
      project: { type: 'string', value: 'ID', description: 'The project it belongs to' },
      'ssh-key': {
        type: 'string',
        value: 'PATH,…',
        description: 'Files of OpenSSH public keys to authorize',
      },
      'user-data': {
        type: 'string',
        value: 'FILE|secret://…',
        description: 'cloud-init user data (at most 32 KiB)',
      },
      stopped: { type: 'boolean', description: 'Create it stopped' },
      wait: {
        type: 'integer',
        value: 'SECONDS',
        default: 30,
        min: 0,
        max: 30,
        description: 'Wait this long for it to settle',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry the same request',
      },
    },
    examples: [
      'better-compute instances create --pool vps-eu --flavor g1.small --image img_01k5w… --ssh-key ~/.ssh/id_ed25519.pub',
    ],
    async run({ flags, path, api }) {
      const sshKeys: string[] = [];
      for (const file of list(flags['ssh-key'])) {
        let text: string;
        try {
          text = await readFile(path(file), 'utf8');
        } catch {
          throw usageError(`--ssh-key ${file}: cannot read it`);
        }
        if (text.includes('PRIVATE KEY'))
          throw usageError(`--ssh-key ${file} holds a private key; pass the .pub`);
        sshKeys.push(
          ...text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#')),
        );
      }
      let userData: string | undefined;
      if (flags['user-data'])
        userData = flags['user-data'].startsWith('secret://')
          ? flags['user-data']
          : await readFile(path(flags['user-data']), 'utf8');
      const wait = flags.wait ?? 30;
      return (await api()).call('instances/create', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        flavor: flags.flavor,
        imageId: flags.image,
        ...(flags.project ? { projectId: flags.project } : {}),
        ...(sshKeys.length ? { sshKeys } : {}),
        ...(userData !== undefined ? { userData } : {}),
        ...(flags.stopped ? { desiredState: 'stopped' } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
        ...(wait > 0 ? { wait: { timeoutMs: wait * 1000 } } : {}),
      });
    },
  }),
  ...(['start', 'stop', 'delete'] as const).map((name) =>
    defineCommand({
      name: `instances ${name}`,
      group: 'Instances',
      summary: {
        start: 'Start a stopped instance (instances.start)',
        stop: 'Stop a running instance (instances.stop)',
        delete: 'Delete an instance and its disks (instances.delete)',
      }[name],
      target: 'token',
      args: instanceArg,
      flags: { tenant: tenantFlag },
      examples: [`better-compute instances ${name} inst_01k5w…`],
      async run({ flags, args, api }) {
        return (await api()).call(`instances/${name}`, {
          tenantId: flags.tenant,
          instanceId: instanceId(args),
        });
      },
    }),
  ),
  defineCommand({
    name: 'instances resize',
    group: 'Instances',
    summary: 'Move an instance to another flavor (instances.resize)',
    target: 'token',
    args: instanceArg,
    flags: {
      tenant: tenantFlag,
      flavor: { type: 'string', value: 'NAME', required: true, description: 'The new flavor' },
    },
    examples: ['better-compute instances resize inst_01k5w… --flavor g1.large'],
    async run({ flags, args, api }) {
      return (await api()).call('instances/resize', {
        tenantId: flags.tenant,
        instanceId: instanceId(args),
        flavor: flags.flavor,
      });
    },
  }),
];
