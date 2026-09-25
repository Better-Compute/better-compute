import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, RemoteExitError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { tenantFlag } from './capacity.js';

// Break-glass SSH from a terminal (PLAN.md §13, `nodes.issueSshCert`): the operator's own public key goes to the
// API (the private key never leaves the machine), and the short-lived, node-bound certificate lands beside it as
// `<key>-cert.pub`, where OpenSSH picks it up with `ssh -i <key>`. Needs compute:nodes:ssh-root and an MFA session.

interface IssuedSshCert {
  certificate: string;
  serial: string;
  keyId: string;
  principals: string[];
  account: string;
  validBefore: number;
}

/** The default key: the first of ~/.ssh/id_ed25519.pub and id_ecdsa.pub that exists (from the given environment). */
async function defaultPublicKey(env: NodeJS.ProcessEnv): Promise<string> {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw usageError('Pass --key: no HOME to find ~/.ssh in');
  for (const name of ['id_ed25519.pub', 'id_ecdsa.pub']) {
    const path = join(home, '.ssh', name);
    try {
      await readFile(path, 'utf8');
      return path;
    } catch {
      // Try the next one.
    }
  }
  throw usageError('No ~/.ssh/id_ed25519.pub or id_ecdsa.pub: pass --key PATH (an Ed25519 or ECDSA P-256 key)');
}

export const sshCommands = [
  defineCommand({
    name: 'ssh-cert',
    group: 'Access',
    summary: 'Get a break-glass SSH certificate for one node, next to your key',
    description:
      "ssh-cert asks nodes.issueSshCert for a short-lived OpenSSH user certificate for your own public key (--key, default ~/.ssh/id_ed25519.pub, else id_ecdsa.pub) and writes it beside the key as <key>-cert.pub, where ssh -i <key> finds it. The certificate is bound to the node (principal <account>@<nodeId>): it opens that node only, as --account (default root), for --minutes (default 15, at most 60, and never past your session). It needs compute:nodes:ssh-root and a session verified with MFA. The private key never leaves your machine. Revoke it early with api nodes.revokeSshCert.",
    target: 'token',
    output: 'json',
    flags: {
      tenant: tenantFlag,
      node: { type: 'string', value: 'ID', required: true, description: 'The node' },
      key: { type: 'string', value: 'PATH', description: 'Your OpenSSH public key (.pub)' },
      account: {
        type: 'string',
        value: 'NAME',
        default: 'root',
        description: 'The Unix account on the node',
      },
      minutes: {
        type: 'integer',
        value: 'N',
        default: 15,
        min: 1,
        max: 60,
        description: 'Validity in minutes',
      },
      connect: {
        type: 'string',
        value: 'HOST',
        description: "Then run ssh to the node's address with the new certificate (the command after --, or a shell)",
      },
      ssh: { type: 'string', value: 'PROGRAM', default: 'ssh', description: 'The OpenSSH client for --connect' },
    },
    args: [{ name: 'command', variadic: true, description: 'With --connect: the command to run, after --' }],
    examples: [
      'better-compute ssh-cert --tenant org_acme --node node_01k5w… && ssh -i ~/.ssh/id_ed25519 root@10.0.0.5',
      'better-compute ssh-cert --tenant org_acme --node node_01k5w… --key ./ops.pub --minutes 5',
      'better-compute ssh-cert --node node_01k5w… --connect 10.0.0.5 -- journalctl -u bcd -n 50',
    ],
    async run({ flags, args, env, path, api, note, io }) {
      // A host is never an ssh option (-oProxyCommand=…): a name, IPv4 or IPv6 address only.
      if (flags.connect !== undefined && !/^[A-Za-z0-9_.:\[\]%]([A-Za-z0-9_.:\[\]%-]{0,252})$/.test(flags.connect))
        throw usageError('--connect takes a host name or an IP address');
      if (args.length && flags.connect === undefined) throw usageError('A command needs --connect HOST');
      const keyPath = flags.key ? path(flags.key) : await defaultPublicKey(env);
      if (!keyPath.endsWith('.pub')) throw usageError('--key must be the public key (a .pub file)');
      const publicKey = (await readFile(keyPath, 'utf8')).trim();
      if (publicKey.includes('PRIVATE KEY'))
        throw new CliError('INVALID_INPUT', `${keyPath} holds a private key; pass the .pub file`);
      const issued = await (await api()).call<IssuedSshCert>('nodes/issueSshCert', {
        tenantId: flags.tenant,
        nodeId: flags.node,
        publicKey,
        principal: flags.account ?? 'root',
        ttlSeconds: (flags.minutes ?? 15) * 60,
      });
      const certificatePath = `${keyPath.slice(0, -'.pub'.length)}-cert.pub`;
      await writeFile(certificatePath, `${issued.certificate.trim()}\n`, { mode: 0o644 });
      note(`Wrote ${certificatePath}; it opens ${flags.node} as ${issued.account} until ${new Date(issued.validBefore).toISOString()}.`);
      if (flags.connect !== undefined) {
        const run = io.spawn ?? (() => Promise.reject(new CliError('UNSUPPORTED', 'This program cannot run ssh (CliIO.spawn)')));
        const status = await run(flags.ssh ?? 'ssh', [
          '-i',
          keyPath.slice(0, -'.pub'.length),
          '-o',
          // ssh splits -o values on whitespace (a home directory may contain spaces).
          `CertificateFile="${certificatePath.replace(/"/g, '')}"`,
          '-o',
          'IdentitiesOnly=yes',
          '-l',
          issued.account,
          '--',
          flags.connect,
          ...args,
        ]);
        if (status !== 0) throw new RemoteExitError(status, 'ssh');
        return undefined;
      }
      return {
        certificate: certificatePath,
        serial: issued.serial,
        principals: issued.principals,
        account: issued.account,
        validBefore: new Date(issued.validBefore).toISOString(),
      };
    },
  }),
];
