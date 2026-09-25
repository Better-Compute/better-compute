import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectTunnel, tunnelUrl } from '@better-compute/client';
import { parseDuration } from '@better-compute/core';
import { CliError, RemoteExitError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { newIdempotencyKey, parseTime, tenantFlag } from './capacity.js';
import { tunnelEndpoint } from './tunnel.js';

/** What sandboxes.exec returns (the tunnels module's `SandboxExec`, as far as the CLI uses it). */
interface SandboxExecGrant {
  instanceId: string;
  path: string;
  certificate: string;
  account: string;
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
      limit: { type: 'integer', value: 'N', min: 1, max: 500, description: 'Page size' },
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
      const granted = await (await context.api()).call<SandboxExecGrant>('sandboxes/exec', {
        tenantId: flags.tenant,
        sandboxId: id,
        publicKey,
        ttlSeconds: (flags.minutes ?? 10) * 60,
      });
      const dir = await mkdtemp(join(tmpdir(), 'bc-sandbox-'));
      const certificate = join(dir, 'key-cert.pub');
      await writeFile(certificate, `${granted.certificate.trim()}\n`, { mode: 0o600 });
      // One connection, one single-use ticket: the listener closes after the first accept.
      let tunnel: ReturnType<typeof connectTunnel> | undefined;
      const server = createServer((socket) => {
        server.close();
        const opened = connectTunnel({ url: tunnelUrl(origin, basePath, granted.path) });
        tunnel = opened;
        opened.onData((data) => void (socket.destroyed || socket.write(data)));
        void opened.exited.then(() => socket.end());
        socket.on('data', (chunk: Buffer) => opened.write(new Uint8Array(chunk)));
        socket.on('close', () => opened.close());
        socket.on('error', () => opened.close());
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      const run = io.spawn ?? (() => Promise.reject(new CliError('UNSUPPORTED', 'This program cannot run ssh (CliIO.spawn)')));
      let status: number;
      try {
        status = await run(flags.ssh ?? 'ssh', [
          '-i',
          keyPath,
          '-o',
          `CertificateFile=${certificate}`,
          '-o',
          'IdentitiesOnly=yes',
          // The tunnel already authenticated the node and the instance; the guest's host key is new every boot.
          '-o',
          `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          `HostKeyAlias=${id}`,
          '-p',
          String(port),
          '-l',
          granted.account,
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
];
