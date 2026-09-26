import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectTunnel, tunnelUrl } from '@better-compute/client';
import { parseDuration } from '@better-compute/core';
import { formatSshPublicKey, parseSshCertificate } from '@better-compute/pki';
import { CliError, RemoteExitError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { newIdempotencyKey, parseTime, tenantFlag } from './capacity.js';
import { bridgeSocket, tunnelEndpoint } from './tunnel.js';

/** What sandboxes.exec returns (the tunnels module's `SandboxExec`, as far as the CLI uses it). */
interface SandboxExecGrant {
  instanceId: string;
  path: string;
  certificate: string;
  account: string;
  /** The name the guest's host certificate carries (the instance, or the original one after a memory restore). */
  hostPrincipal?: string;
  /** The guest presents a host key certified by the sandbox CA. */
  hostCertified?: boolean;
}

// Sandboxes (PLAN.md §3.7, the vps module's `sandboxes` and `sandboxTemplates` groups): short-lived instances
// from a tenant's templates, claimed warm when the template keeps a pool, deleted at their expiry unless
// extended, snapshotted and restored. Each command is the API call as BETTER_COMPUTE_TOKEN, in process or --url.

const sandboxArg = [{ name: 'sandbox', description: 'The sandbox id (sbx_…)', required: true }];

function sandboxId(args: string[]): string {
  const id = args[0]!;
  if (!/^sbx_[0-9a-z]{26,52}$/.test(id)) throw usageError(`${id} is not a sandbox id (sbx_…)`);
  return id;
}

/** A duration flag in whole seconds (`30m` → 1800). */
function seconds(value: string, flag: string): number {
  let ms: number;
  try {
    ms = parseDuration(value);
  } catch {
    throw usageError(`--${flag} ${value}: a duration looks like 15m, 2h or 1d`);
  }
  if (ms < 1000 || ms % 1000 !== 0) throw usageError(`--${flag} ${value}: whole seconds, at least 1s`);
  return ms / 1000;
}

const templateArg = [{ name: 'template', description: 'The template id (sbxt_…)', required: true }];

function templateId(args: string[]): string {
  const id = args[0]!;
  if (!/^sbxt_[0-9a-z]{26,52}$/.test(id)) throw usageError(`${id} is not a sandbox template id (sbxt_…)`);
  return id;
}

/** The template fields both create and update take, from flags (only those given). */
async function templateFields(
  given: object,
  path: (value: string) => string,
): Promise<Record<string, unknown>> {
  const flags = given as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  if (flags.flavor) fields.flavor = flags.flavor;
  if (flags.image) fields.imageId = flags.image;
  if (flags['user-data']) fields.userData = await readFile(path(String(flags['user-data'])), 'utf8');
  if (flags['default-ttl']) fields.defaultTtlSeconds = seconds(String(flags['default-ttl']), 'default-ttl');
  if (flags['max-ttl']) fields.maxTtlSeconds = seconds(String(flags['max-ttl']), 'max-ttl');
  if (flags['warm-min'] !== undefined || flags['warm-max'] !== undefined) {
    if (flags['warm-min'] === undefined) throw usageError('--warm-max needs --warm-min');
    fields.warm = {
      min: flags['warm-min'],
      ...(flags['warm-max'] !== undefined ? { max: flags['warm-max'] } : {}),
    };
  }
  if (flags.env) {
    // NAME=secret://<tenant>/<id>, comma-separated: the values are secret references, never secrets.
    const env: Record<string, string> = {};
    for (const pair of String(flags.env).split(',').map((item) => item.trim()).filter(Boolean)) {
      const at = pair.indexOf('=');
      if (at <= 0) throw usageError(`--env ${pair}: use NAME=secret://<tenant>/<id>`);
      env[pair.slice(0, at)] = pair.slice(at + 1);
    }
    fields.env = env;
  }
  if (flags.network) fields.network = flags.network;
  if (flags.volumes !== undefined) fields.volumes = parseVolumes(String(flags.volumes));
  return fields;
}

/**
 * `--volumes NAME:/mount[:ro],…` (agent memory): the persistent volumes every sandbox mounts, in
 * order, by volume name (or id, vol_…); an empty value removes them all.
 */
function parseVolumes(value: string): { name?: string; volumeId?: string; mountPath: string; readOnly: boolean }[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [volume, mountPath, mode, ...rest] = item.split(':');
      if (!volume || !mountPath?.startsWith('/') || rest.length || (mode !== undefined && mode !== 'ro'))
        throw usageError(`--volumes ${item}: use NAME:/mount/path or NAME:/mount/path:ro`);
      return {
        ...(/^vol_[0-9a-z]{26,52}$/.test(volume) ? { volumeId: volume } : { name: volume }),
        mountPath,
        readOnly: mode === 'ro',
      };
    });
}

const volumeArg = [{ name: 'volume', description: 'The volume id (vol_…)', required: true }];

function volumeId(args: string[]): string {
  const id = args[0]!;
  if (!/^vol_[0-9a-z]{26,52}$/.test(id)) throw usageError(`${id} is not a volume id (vol_…)`);
  return id;
}

const templateFlags = {
  flavor: { type: 'string', value: 'NAME', description: 'The instance flavor (the pool offers it)' },
  image: { type: 'string', value: 'ID', description: 'The image' },
  'user-data': { type: 'string', value: 'FILE', description: 'cloud-init user data for every sandbox, from a file' },
  'default-ttl': { type: 'string', value: 'DURATION', description: 'Default lifetime: 30m, 2h' },
  'max-ttl': { type: 'string', value: 'DURATION', description: 'Longest lifetime a sandbox may be given or extended to' },
  'warm-min': { type: 'integer', value: 'N', min: 0, max: 100, description: 'Warm instances kept ready' },
  'warm-max': { type: 'integer', value: 'N', min: 0, max: 100, description: 'At most this many warm instances' },
  env: {
    type: 'string',
    value: 'NAME=REF,…',
    description: 'Environment from secret references: NAME=secret://<tenant>/<id>, comma-separated',
  },
  network: {
    type: 'string',
    value: 'MODE',
    choices: ['egress', 'private', 'none'],
    description: 'What sandboxes may reach (default egress)',
  },
  volumes: {
    type: 'string',
    value: 'NAME:/PATH[:ro],…',
    description: 'Persistent volumes (agent memory) every sandbox mounts, in order; "" removes them',
  },
} as const;

export const sandboxCommands = [
  defineCommand({
    name: 'sandbox create',
    group: 'Sandboxes',
    summary: 'Create a sandbox from a template (sandboxes.create)',
    description:
      "sandbox create starts a sandbox from --template (sbxt_…), claimed from the template's warm pool when it keeps one, decided by better-iam as compute:sandboxes:create. It lives --ttl (default: the template's default, at most its maximum) and is deleted then unless extended. --from-snapshot restores a snapshot of yours instead of booting the image. It waits up to --wait seconds (default 30) for the sandbox to leave `starting` and prints it. Every run sends a new idempotency key unless --key is given: repeat with the same --key to retry safely.",
    target: 'token',
    flags: {
      tenant: tenantFlag,
      template: { type: 'string', value: 'ID', required: true, description: 'The template (sbxt_…)' },
      ttl: { type: 'string', value: 'DURATION', description: 'How long it lives: 15m, 2h' },
      'from-snapshot': { type: 'string', value: 'ID', description: 'Restore this snapshot (snap_…)' },
      wait: {
        type: 'integer',
        value: 'SECONDS',
        default: 30,
        min: 0,
        max: 30,
        description: 'Wait this long for it to start',
      },
      key: { type: 'string', value: 'KEY', description: 'Idempotency key, to retry the same request' },
    },
    examples: [
      'better-compute sandbox create --template sbxt_01k5w… --ttl 30m',
      'better-compute sandbox create --template sbxt_01k5w… --from-snapshot snap_01k5w…',
    ],
    async run({ flags, api }) {
      const wait = flags.wait ?? 30;
      return (await api()).call('sandboxes/create', {
        tenantId: flags.tenant,
        templateId: flags.template,
        ...(flags.ttl ? { ttlSeconds: seconds(flags.ttl, 'ttl') } : {}),
        ...(flags['from-snapshot'] ? { fromSnapshot: flags['from-snapshot'] } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
        ...(wait > 0 ? { wait: { timeoutMs: wait * 1000 } } : {}),
      });
    },
  }),
  defineCommand({
    name: 'sandbox list',
    group: 'Sandboxes',
    summary: 'List sandboxes: yours, or the tenant’s with --all (sandboxes.list)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      all: { type: 'boolean', description: 'Every sandbox of the tenant, not only yours' },
      deleted: { type: 'boolean', description: 'Include deleted sandboxes' },
      template: { type: 'string', value: 'ID', description: 'Only this template’s (sbxt_…)' },
      limit: { type: 'integer', value: 'N', min: 1, max: 200, description: 'Page size (at most 200)' },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: ['better-compute sandbox list', 'better-compute sandbox list --all --query "items[*].id"'],
    async run({ flags, api }) {
      return (await api()).call('sandboxes/list', {
        tenantId: flags.tenant,
        scope: flags.all ? 'all' : 'mine',
        ...(flags.deleted ? { deleted: true } : {}),
        ...(flags.template ? { templateId: flags.template } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'sandbox get',
    group: 'Sandboxes',
    summary: 'Show a sandbox, its expiry and its snapshots (sandboxes.get)',
    target: 'token',
    args: sandboxArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute sandbox get sbx_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('sandboxes/get', { tenantId: flags.tenant, sandboxId: sandboxId(args) });
    },
  }),
  defineCommand({
    name: 'sandbox extend',
    group: 'Sandboxes',
    summary: 'Move a sandbox’s expiry (sandboxes.extend)',
    description:
      "sandbox extend adds --by to the current expiry, or sets it to --until (ISO 8601, epoch ms or +DURATION from now), within the template's maximum lifetime. Decided as compute:sandboxes:update on the sandbox.",
    target: 'token',
    args: sandboxArg,
    flags: {
      tenant: tenantFlag,
      by: { type: 'string', value: 'DURATION', description: 'Add this to the expiry: 30m, 2h' },
      until: { type: 'string', value: 'TIME', description: 'The new expiry' },
    },
    examples: ['better-compute sandbox extend sbx_01k5w… --by 30m', 'better-compute sandbox extend sbx_01k5w… --until +2h'],
    async run({ flags, args, api }) {
      if (Boolean(flags.by) === Boolean(flags.until)) throw usageError('Pass exactly one of --by or --until');
      return (await api()).call('sandboxes/extend', {
        tenantId: flags.tenant,
        sandboxId: sandboxId(args),
        ...(flags.by ? { by: seconds(flags.by, 'by') * 1000 } : {}),
        ...(flags.until ? { until: parseTime(flags.until, Date.now(), 'until') } : {}),
      });
    },
  }),
  defineCommand({
    name: 'sandbox snapshot',
    group: 'Sandboxes',
    summary: 'Snapshot a sandbox, memory included unless --no-memory (sandboxes.snapshot)',
    description:
      "sandbox snapshot asks the sandbox's host for its instance's state; the snapshot is pending until the host reports it. Snapshots go with the sandbox unless --keep. Restore one with sandbox create --from-snapshot.",
    target: 'token',
    args: sandboxArg,
    flags: {
      tenant: tenantFlag,
      'no-memory': { type: 'boolean', description: 'Disk only (not a running state)' },
      keep: { type: 'boolean', description: 'Keep it after the sandbox is deleted' },
      key: { type: 'string', value: 'KEY', description: 'Idempotency key, to retry the same request' },
    },
    examples: ['better-compute sandbox snapshot sbx_01k5w… --keep'],
    async run({ flags, args, api }) {
      return (await api()).call('sandboxes/snapshot', {
        tenantId: flags.tenant,
        sandboxId: sandboxId(args),
        includeMemory: !flags['no-memory'],
        keep: Boolean(flags.keep),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'sandbox delete',
    group: 'Sandboxes',
    summary: 'Delete a sandbox now (sandboxes.delete)',
    target: 'token',
    args: sandboxArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute sandbox delete sbx_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('sandboxes/delete', { tenantId: flags.tenant, sandboxId: sandboxId(args) });
    },
  }),
  defineCommand({
    name: 'sandbox exec',
    group: 'Sandboxes',
    summary: 'Run a command (or a shell) in a sandbox over SSH through a tunnel (sandboxes.exec)',
    description:
      "sandbox exec asks sandboxes.exec for a short-lived SSH certificate for your own key (--key, default ~/.ssh/id_ed25519; its .pub is sent, the private key never leaves this machine) and a single-use tunnel ticket to the sandbox's instance, then runs your OpenSSH client (--ssh, default ssh) through that tunnel: the command after --, or a login shell. There is no agent in the guest; its sshd trusts the sandbox CA for <account>@<instance>. The certificate and a known_hosts file for this one connection live in a temporary directory that is removed afterwards. It exits with ssh's status. Needs --url (tunnels run over the server's WebSocket) and a signed-in session.",
    target: 'token',
    output: 'text',
    args: [
      ...sandboxArg,
      { name: 'command', variadic: true, description: 'The command to run, after -- (default: a login shell)' },
    ],
    flags: {
      tenant: tenantFlag,
      key: { type: 'string', value: 'PATH', description: 'Your private key (its .pub beside it is sent)' },
      minutes: {
        type: 'integer',
        value: 'N',
        default: 10,
        min: 1,
        max: 15,
        description: 'Certificate lifetime in minutes',
      },
      ssh: { type: 'string', value: 'PROGRAM', default: 'ssh', description: 'The OpenSSH client to run' },
      'accept-host-key': {
        type: 'boolean',
        description:
          "Connect although the guest's host key is not certified (older guests, or an expired host certificate): accepted on first use",
      },
    },
    examples: ['better-compute sandbox exec sbx_01k5w… -- uname -a', 'better-compute sandbox exec sbx_01k5w…'],
    async run(context) {
      const { flags, args, env, path, io } = context;
      const id = sandboxId(args);
      const { origin, basePath } = tunnelEndpoint(context);
      const home = env.HOME ?? env.USERPROFILE;
      const keyPath = flags.key ? path(flags.key) : home ? join(home, '.ssh', 'id_ed25519') : undefined;
      if (!keyPath) throw usageError('Pass --key PATH: no HOME to find ~/.ssh/id_ed25519 in');
      let publicKey: string;
      try {
        publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
      } catch {
        throw usageError(`No public key at ${keyPath}.pub: pass --key with the private key whose .pub is beside it`);
      }
      if (publicKey.includes('PRIVATE KEY'))
        throw new CliError('INVALID_INPUT', `${keyPath}.pub holds a private key; it must be the public key`);
      const granted = await (await context.api())
        .call<SandboxExecGrant>('sandboxes/exec', {
          tenantId: flags.tenant,
          sandboxId: id,
          publicKey,
          ttlSeconds: (flags.minutes ?? 10) * 60,
        })
        .catch((error: unknown) => {
          // A memory restore still answering to its source's SSH identity: say what unblocks it.
          const failure = error as { code?: string; message?: string; details?: { reason?: unknown } };
          if (failure?.details?.reason === 'restore-shares-identity')
            throw new CliError(
              'INVALID_STATE',
              failure.message ?? `${id} shares its SSH identity with another running guest`,
              `Delete the sandbox it was restored from (or its sibling restores), or wait until the host gives it its own identity: better-compute sandbox get ${id} shows identityRebound: true then.`,
            );
          throw error;
        });
      // The account comes from the server: a Unix name only (it reaches ssh's %r/%u expansions).
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(granted.account))
        throw new CliError('INVALID_RESPONSE', 'The server named an invalid guest account');
      const run =
        io.spawn ?? (() => Promise.reject(new CliError('UNSUPPORTED', 'This program cannot run ssh (CliIO.spawn)')));
      const dir = await mkdtemp(join(tmpdir(), 'bc-sandbox-'));
      let tunnel: ReturnType<typeof connectTunnel> | undefined;
      const server = createServer((socket) => {
        // One connection, one single-use ticket: the listener closes after the first accept.
        server.close();
        const opened = connectTunnel({ url: tunnelUrl(origin, basePath, granted.path) });
        tunnel = opened;
        let ended = false;
        bridgeSocket(socket, opened, () => ended);
        void opened.exited.then(() => {
          ended = true;
          socket.end();
        });
        socket.on('close', () => opened.close());
        socket.on('error', () => opened.close());
      });
      // The guest's host key: pinned to the sandbox CA when the guest has a host certificate (the CA that signed our
      // user certificate, over the authenticated API call). Without one (an older guest, or a host certificate that
      // expired) trust on first use happens only when asked for with --accept-host-key.
      const pinned = granted.hostCertified === true;
      if (pinned && !(typeof granted.hostPrincipal === 'string' && /^[A-Za-z0-9._-]{1,253}$/.test(granted.hostPrincipal)))
        throw new CliError('INVALID_RESPONSE', "The server named an invalid host principal for the guest's certificate");
      if (!pinned && !flags['accept-host-key'])
        throw new CliError(
          'INVALID_STATE',
          `${id}'s host key is not certified (a guest from before host certificates, or one whose certificate expired): it cannot be verified`,
          'Recreate the sandbox, or pass --accept-host-key to trust its key on first use for this connection.',
        );
      const alias = pinned ? granted.hostPrincipal! : id;
      if (!pinned) context.note(`Trusting ${id}'s host key on first use (--accept-host-key).`);
      let status: number;
      try {
        const certificate = join(dir, 'key-cert.pub');
        await writeFile(certificate, `${granted.certificate.trim()}\n`, { mode: 0o600 });
        if (pinned) {
          const ca = formatSshPublicKey(parseSshCertificate(granted.certificate).signatureKey);
          await writeFile(join(dir, 'known_hosts'), `@cert-authority ${alias} ${ca}\n`, { mode: 0o600 });
        }
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve());
        });
        const port = (server.address() as AddressInfo).port;
        // ssh splits -o values on whitespace: quote the paths (a temporary directory may contain spaces).
        const quoted = (value: string) => `"${value.replace(/"/g, '')}"`;
        status = await run(flags.ssh ?? 'ssh', [
          // No ssh_config at all, the user's or the system's (SendEnv, other IdentityFiles, global known hosts):
          // everything this connection needs is given here.
          '-F',
          'none',
          '-i',
          keyPath,
          '-o',
          `CertificateFile=${quoted(certificate)}`,
          '-o',
          'IdentitiesOnly=yes',
          // The guest is untrusted: none of the user's ssh config that would hand it anything (the agent, X11,
          // forwardings, a proxy that sends the connection elsewhere, a shared master, local commands).
          '-a',
          '-x',
          '-o',
          'ForwardAgent=no',
          '-o',
          'ForwardX11=no',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ProxyCommand=none',
          '-o',
          'ProxyJump=none',
          '-o',
          'ControlMaster=no',
          '-o',
          'ControlPath=none',
          '-o',
          'PermitLocalCommand=no',
          // A per-connection known_hosts: the sandbox CA for a certified guest (nothing else is trusted), else empty.
          '-o',
          `UserKnownHostsFile=${quoted(join(dir, 'known_hosts'))}`,
          '-o',
          `GlobalKnownHostsFile=${quoted(join(dir, 'known_hosts'))}`,
          '-o',
          `StrictHostKeyChecking=${pinned ? 'yes' : 'accept-new'}`,
          '-o',
          `HostKeyAlias=${alias}`,
          '-p',
          String(port),
          '-l',
          granted.account,
          // Everything after the host is the remote command, never an ssh option.
          '--',
          '127.0.0.1',
          ...args.slice(1),
        ]);
      } finally {
        server.close();
        tunnel?.terminate();
        await rm(dir, { recursive: true, force: true });
      }
      if (status !== 0) throw new RemoteExitError(status, 'ssh');
    },
  }),
  defineCommand({
    name: 'sandbox-template create',
    group: 'Sandboxes',
    summary: 'Create a sandbox template for the tenant (sandboxTemplates.create)',
    description:
      "sandbox-template create defines what `sandbox create --template` starts: --pool, --flavor and --image (and the pool's --runtime), the default and longest lifetimes, a warm pool kept ready (--warm-min/--warm-max), user data from a file, environment variables from secret references and the network mode. Decided as compute:sandboxes:manage on the tenant.",
    target: 'token',
    flags: {
      tenant: tenantFlag,
      name: { type: 'string', value: 'NAME', required: true, description: 'The template name' },
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool its instances run in (pool_…)' },
      runtime: { type: 'string', value: 'ID', description: "The pool's runtime driver (checked against it)" },
      ...templateFlags,
    },
    examples: [
      'better-compute sandbox-template create --name python --pool pool_01k5w… --flavor small --image img_01k5w… --warm-min 2 --max-ttl 4h',
    ],
    async run({ flags, path, api }) {
      if (!flags.flavor || !flags.image) throw usageError('Pass --flavor and --image');
      return (await api()).call('sandboxTemplates/create', {
        tenantId: flags.tenant,
        name: flags.name,
        poolId: flags.pool,
        ...(flags.runtime ? { runtime: flags.runtime } : {}),
        ...(await templateFields(flags, path)),
      });
    },
  }),
  defineCommand({
    name: 'sandbox-template update',
    group: 'Sandboxes',
    summary: 'Change a sandbox template (sandboxTemplates.update)',
    description:
      'sandbox-template update changes only the fields given; --no-user-data removes the user data. Sandboxes already running keep what they started with; the warm pool is refilled from the new definition.',
    target: 'token',
    args: templateArg,
    flags: {
      tenant: tenantFlag,
      ...templateFlags,
      'no-user-data': { type: 'boolean', description: 'Remove the user data' },
    },
    examples: ['better-compute sandbox-template update sbxt_01k5w… --warm-min 4 --image img_01k5w…'],
    async run({ flags, args, path, api }) {
      if (flags['no-user-data'] && flags['user-data']) throw usageError('Pass --user-data or --no-user-data, not both');
      const fields = await templateFields(flags, path);
      if (flags['no-user-data']) fields.userData = null;
      if (!Object.keys(fields).length) throw usageError('Nothing to change: pass at least one field flag');
      return (await api()).call('sandboxTemplates/update', {
        tenantId: flags.tenant,
        templateId: templateId(args),
        ...fields,
      });
    },
  }),
  defineCommand({
    name: 'sandbox-template delete',
    group: 'Sandboxes',
    summary: 'Delete a sandbox template (sandboxTemplates.delete)',
    target: 'token',
    args: templateArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute sandbox-template delete sbxt_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('sandboxTemplates/delete', { tenantId: flags.tenant, templateId: templateId(args) });
    },
  }),
  defineCommand({
    name: 'sandbox templates',
    group: 'Sandboxes',
    summary: 'List the tenant’s sandbox templates and their warm pools (sandboxTemplates.list)',
    target: 'token',
    flags: { tenant: tenantFlag },
    examples: ['better-compute sandbox templates --format table'],
    async run({ flags, api }) {
      return (await api()).call('sandboxTemplates/list', { tenantId: flags.tenant });
    },
  }),
  // Agent memory (v1.1): persistent volumes that outlive sandboxes (sandboxVolumes).
  defineCommand({
    name: 'sandbox-volume create',
    group: 'Sandboxes',
    summary: 'Create a persistent volume (agent memory) on a pool (sandboxVolumes.create)',
    description:
      'sandbox-volume create books --size GiB of disk on one host of --pool; sandboxes of templates that mount it (sandbox-template --volumes) run on that host and keep its data across runs. It is billed until deleted. Repeat with the same --key to retry safely.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool (pool_…)' },
      name: { type: 'string', value: 'NAME', required: true, description: 'A name unique in the tenant' },
      size: { type: 'integer', value: 'GIB', required: true, min: 1, max: 16_384, description: 'Size in GiB' },
      key: { type: 'string', value: 'KEY', description: 'Idempotency key, to retry the same request' },
    },
    examples: ['better-compute sandbox-volume create --pool pool_01k5w… --name agent-notes --size 20'],
    async run({ flags, api }) {
      return (await api()).call('sandboxVolumes/create', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        name: flags.name,
        sizeGiB: flags.size,
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'sandbox-volume list',
    group: 'Sandboxes',
    summary: 'List the tenant’s persistent volumes (sandboxVolumes.list)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', description: 'Only this pool’s (pool_…)' },
      deleted: { type: 'boolean', description: 'Include deleted volumes' },
      all: { type: 'boolean', description: 'Every volume of the tenant you may see, not only yours' },
    },
    examples: ['better-compute sandbox-volume list --format table'],
    async run({ flags, api }) {
      return (await api()).call('sandboxVolumes/list', {
        tenantId: flags.tenant,
        ...(flags.all ? { scope: 'all' } : {}),
        ...(flags.pool ? { poolId: flags.pool } : {}),
        ...(flags.deleted ? { includeDeleted: true } : {}),
      });
    },
  }),
  defineCommand({
    name: 'sandbox-volume get',
    group: 'Sandboxes',
    summary: 'Show a persistent volume (sandboxVolumes.get)',
    target: 'token',
    args: volumeArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute sandbox-volume get vol_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('sandboxVolumes/get', { tenantId: flags.tenant, volumeId: volumeId(args) });
    },
  }),
  defineCommand({
    name: 'sandbox-volume resize',
    group: 'Sandboxes',
    summary: 'Grow a persistent volume (sandboxVolumes.resize)',
    description: 'sandbox-volume resize grows the volume to --size GiB; volumes never shrink.',
    target: 'token',
    args: volumeArg,
    flags: {
      tenant: tenantFlag,
      size: { type: 'integer', value: 'GIB', required: true, min: 1, max: 16_384, description: 'The new size in GiB' },
    },
    examples: ['better-compute sandbox-volume resize vol_01k5w… --size 40'],
    async run({ flags, args, api }) {
      return (await api()).call('sandboxVolumes/resize', {
        tenantId: flags.tenant,
        volumeId: volumeId(args),
        sizeGiB: flags.size,
      });
    },
  }),
  defineCommand({
    name: 'sandbox-volume delete',
    group: 'Sandboxes',
    summary: 'Delete a persistent volume and wipe its data (sandboxVolumes.delete)',
    target: 'token',
    args: volumeArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute sandbox-volume delete vol_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('sandboxVolumes/delete', { tenantId: flags.tenant, volumeId: volumeId(args) });
    },
  }),
];
