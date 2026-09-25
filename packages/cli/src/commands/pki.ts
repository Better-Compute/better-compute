import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createPkiBundle,
  exportPkiBundle,
  exportRootKey,
  generateP256KeyPair,
  importPkiBundle,
  pkiPins,
  privateKeyPem,
  parseCertificate,
  readPkiPins,
  renewBundleCa,
  rotateCommandSigningRoot,
  toPem,
  type BundleCa,
  type CommandRootRotationStage,
  type PkiBundle,
} from '@better-compute/pki';
import type { Finding } from '@better-compute/core';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type FlagSpec } from '../framework.js';

/** Where the PKI bundle lives unless `--pki` or `BETTER_COMPUTE_PKI` says otherwise. */
export const defaultPkiPath = '.better-compute/pki.json';

export const pkiFlag: FlagSpec = {
  type: 'string',
  value: 'PATH',
  env: 'BETTER_COMPUTE_PKI',
  default: defaultPkiPath,
  description: 'The PKI bundle written by pki init',
};

const minSecret = 32;

/** Writes a file readable only by its owner, never replacing one that exists. */
export async function writeNew(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new CliError('FILE_EXISTS', `${path} already exists; it was not overwritten`);
    throw error;
  }
}

/** Replaces a file atomically (write beside it, then rename), owner-only. */
export async function replace(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
}

async function readBundleText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new CliError(
        'PKI_NOT_FOUND',
        `No PKI bundle at ${path}`,
        'Run better-compute pki init first.',
      );
    throw error;
  }
}

/** Loads the bundle, unsealing it with BETTER_COMPUTE_SECRET when it is sealed. */
export async function loadPkiBundle(path: string, env: NodeJS.ProcessEnv): Promise<PkiBundle> {
  const secret = env.BETTER_COMPUTE_SECRET;
  return importPkiBundle(await readBundleText(path), secret ? { secret } : {});
}

const iso = (ms: number) => new Date(ms).toISOString();

/** What to run for an expiring certificate of `readPkiPins().expires`. */
function renewalFor(name: string): string {
  if (name === 'nodeCa' || name === 'servingCa' || name === 'internalCa')
    return `renew it from the root: better-compute pki renew-ca --ca ${name.slice(0, -2)}`;
  if (name === 'commandSigningRoot')
    return 'rotate it: better-compute pki rotate-command-root --stage add, then switch and drop';
  return 'replace the root: a new PKI (pki init), and every node rejoins';
}

/** CAs expiring within this window are reported by `doctor`. */
export const caExpiryWarningMs = 30 * 86_400_000;

/**
 * `doctor`'s machine-PKI checks: nothing when there is no bundle at `path`; otherwise an error for
 * an unreadable bundle, an expired CA or a bundle that does not unseal with the deployment secret,
 * and a warning for a CA expiring within 30 days.
 */
export async function pkiFindings(
  path: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): Promise<Finding[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const findings: Finding[] = [];
  let pins: ReturnType<typeof readPkiPins>;
  try {
    pins = readPkiPins(text);
  } catch (error) {
    return [
      {
        check: 'pki.unreadable',
        severity: 'error',
        message: `The PKI bundle at ${path} cannot be read: ${(error as Error).message}`,
        fix: 'Restore it from backup, or create a new PKI with better-compute pki init (every node rejoins)',
      },
    ];
  }
  for (const [name, notAfter] of Object.entries(pins.expires)) {
    if (notAfter <= now)
      findings.push({
        check: 'pki.ca-expired',
        severity: 'error',
        message: `The ${name} certificate expired at ${iso(notAfter)}`,
        fix: `Nothing it signs is trusted until you ${renewalFor(name)}`,
      });
    else if (notAfter - now <= caExpiryWarningMs)
      findings.push({
        check: 'pki.ca-expiring',
        severity: 'warning',
        message: `The ${name} certificate expires at ${iso(notAfter)}`,
        fix: `Before it expires, ${renewalFor(name)}, and roll the bundle out`,
      });
  }
  try {
    importPkiBundle(text, env.BETTER_COMPUTE_SECRET ? { secret: env.BETTER_COMPUTE_SECRET } : {});
  } catch (error) {
    findings.push({
      check: 'pki.unseal',
      severity: 'error',
      message: `The PKI bundle does not load with this deployment's secret: ${(error as Error).message}`,
      fix: 'Set BETTER_COMPUTE_SECRET to the secret the bundle was sealed with',
    });
  }
  return findings;
}

export const pkiCommands = [
  defineCommand({
    name: 'pki init',
    group: 'PKI',
    summary:
      'Create the machine PKI: root, node, serving and internal CAs and the JoinService keys',
    description:
      "pki init creates a deployment's machine PKI (PLAN.md §13) and writes it to one JSON file with mode 0600: an offline root CA, the per-region node CA (agent client certificates), the gateway serving CA, the internal control-plane CA, and the JoinService signing and encryption keys. No key does two jobs. The private keys are sealed with AES-256-GCM under a key derived from BETTER_COMPUTE_SECRET; without the secret, pass --plaintext to store them as PEM instead. --offline-root writes the root key to its own file and leaves it out of the bundle: keep that file off the servers. It prints the pins install scripts need (the same as pki show) and never overwrites an existing file.",
    output: 'json',
    flags: {
      'trust-domain': {
        type: 'string',
        value: 'DOMAIN',
        required: true,
        env: 'BETTER_COMPUTE_TRUST_DOMAIN',
        description: 'SPIFFE trust domain of agent identities, e.g. compute.example.com',
      },
      pki: pkiFlag,
      'offline-root': {
        type: 'string',
        value: 'PATH',
        description:
          'Write the root key here (sealed like the bundle) and leave it out of the bundle',
      },
      organization: {
        type: 'string',
        value: 'NAME',
        default: 'better-compute',
        description: 'Subject organization of the CA certificates',
      },
      plaintext: {
        type: 'boolean',
        description: 'Store private keys as PEM (mode 0600) when BETTER_COMPUTE_SECRET is not set',
      },
    },
    examples: [
      'BETTER_COMPUTE_SECRET=... better-compute pki init --trust-domain compute.example.com',
      'better-compute pki init --trust-domain compute.test --plaintext --pki ./dev/pki.json',
      'better-compute pki init --trust-domain compute.example.com --offline-root /media/usb/root-ca.key',
    ],
    async run({ flags, env, path, note }) {
      const secret = env.BETTER_COMPUTE_SECRET;
      if (secret !== undefined && secret.length < minSecret)
        throw new CliError(
          'INVALID_CONFIG',
          `BETTER_COMPUTE_SECRET must be at least ${minSecret} characters`,
        );
      if (!secret && !flags.plaintext)
        throw new CliError(
          'MISSING_ENV',
          'Set BETTER_COMPUTE_SECRET to seal the private keys, or pass --plaintext',
          'The secret must be the same for every process of the deployment.',
        );
      const target = path(flags.pki ?? defaultPkiPath);
      const bundle = createPkiBundle({
        trustDomain: flags['trust-domain']!,
        organization: flags.organization ?? 'better-compute',
      });
      const sealing = secret ? { secret } : {};
      if (flags['offline-root']) {
        const rootPath = path(flags['offline-root']);
        if (rootPath === target)
          throw usageError('--offline-root must differ from the bundle path');
        await writeNew(rootPath, exportRootKey(bundle, sealing));
        note(
          `Wrote the root key to ${rootPath}. Keep it offline; it is needed only to replace a CA.`,
        );
      }
      await writeNew(
        target,
        exportPkiBundle(bundle, { ...sealing, omitRootKey: Boolean(flags['offline-root']) }),
      );
      note(
        `Wrote the PKI bundle to ${target}${secret ? ' (sealed)' : ' (plaintext PEM, mode 0600)'}.`,
      );
      return readPkiPins(await readFile(target, 'utf8'));
    },
  }),
  defineCommand({
    name: 'pki show',
    group: 'PKI',
    summary: 'Print the pins install scripts and bcd need, and the CA expiry dates',
    description:
      "pki show reads only the public half of the bundle (no secret needed) and prints the trust domain, the gateway serving CA's SPKI pin, the JoinService signing and encryption key pins in bcd's sha256/<base64> form, the encryption key as a JWK, and when each CA expires.",
    flags: { pki: pkiFlag },
    examples: ['better-compute pki show', 'better-compute pki show --query servingCaSpkiPin'],
    async run({ flags, path }) {
      const pins = readPkiPins(await readBundleText(path(flags.pki ?? defaultPkiPath)));
      return {
        ...pins,
        expires: Object.fromEntries(
          Object.entries(pins.expires).map(([name, ms]) => [name, iso(ms)]),
        ),
      };
    },
  }),
  defineCommand({
    name: 'pki rotate-command-root',
    group: 'PKI',
    summary: 'Rotate the command-signing root in three steps: add, switch, drop',
    description:
      "pki rotate-command-root performs one step of a command-signing root rotation (PLAN.md §13) on the bundle and writes it back (sealed with BETTER_COMPUTE_SECRET when set). --stage add creates a new root and publishes it beside the current one (the trust bundle's version goes up); workers keep signing under the current root. Roll the bundle out to every process: daemons receive the new version in Welcome.trust. --stage switch, once every daemon holds that version, makes workers sign under the new root while the old one stays trusted. --stage drop, at least 24 hours later (worker keys live at most 24 h), removes the old root (version up again). Each step prints the roots and version daemons will trust.",
    output: 'json',
    flags: {
      stage: {
        type: 'string',
        value: 'STAGE',
        required: true,
        choices: ['add', 'switch', 'drop'],
        description: 'add a new root, switch signing to it, or drop the old one',
      },
      pki: pkiFlag,
    },
    examples: [
      'better-compute pki rotate-command-root --stage add',
      'better-compute pki rotate-command-root --stage switch',
      'better-compute pki rotate-command-root --stage drop',
    ],
    async run({ flags, env, path, note }) {
      const target = path(flags.pki ?? defaultPkiPath);
      const bundle = await loadPkiBundle(target, env);
      const stage = flags.stage as CommandRootRotationStage;
      let rotated: PkiBundle;
      try {
        rotated = rotateCommandSigningRoot(bundle, stage);
      } catch (error) {
        throw new CliError('INVALID_STATE', (error as Error).message);
      }
      const secret = env.BETTER_COMPUTE_SECRET;
      await replace(target, exportPkiBundle(rotated, secret ? { secret } : {}));
      note(
        stage === 'add'
          ? 'Roll this bundle out to every process; switch once every daemon has the new trust version.'
          : stage === 'switch'
            ? 'Workers now sign under the new root. Drop the old root after 24 hours.'
            : 'The old root is no longer trusted.',
      );
      const pins = pkiPins(rotated);
      return {
        stage,
        trustVersion: pins.trustVersion,
        signingRoot: pins.commandSigningRootSha256,
        ...(pins.commandSigningNextRootSha256 ? { nextRoot: pins.commandSigningNextRootSha256 } : {}),
        ...(pins.commandSigningPreviousRootSha256
          ? { previousRoot: pins.commandSigningPreviousRootSha256 }
          : {}),
      };
    },
  }),
  defineCommand({
    name: 'pki renew-ca',
    group: 'PKI',
    summary: "Renew a CA's certificate under the root, keeping its key",
    description:
      "pki renew-ca issues a new certificate for the node, serving or internal CA from the root CA, for the same key and subject, and writes the bundle back (sealed with BETTER_COMPUTE_SECRET when set). Certificates the CA issued stay valid and the serving CA's SPKI pin does not change, so nothing is re-pinned and no node rejoins; roll the bundle out to every process before the old certificate expires (doctor warns 30 days ahead). The root key comes from the bundle or, for an offline root, from --root-key; it is never written into the bundle then.",
    output: 'json',
    flags: {
      ca: {
        type: 'string',
        value: 'CA',
        required: true,
        choices: ['node', 'serving', 'internal'],
        description: 'Which CA to renew',
      },
      'root-key': {
        type: 'string',
        value: 'PATH',
        description: 'The offline root key (pki init --offline-root), when the bundle has none',
      },
      days: {
        type: 'integer',
        value: 'N',
        default: 365,
        min: 1,
        max: 3650,
        description: 'Lifetime of the new certificate in days (capped by the root)',
      },
      pki: pkiFlag,
    },
    examples: [
      'better-compute pki renew-ca --ca node',
      'better-compute pki renew-ca --ca serving --root-key /media/usb/root-ca.key',
    ],
    async run({ flags, env, path, note }) {
      const target = path(flags.pki ?? defaultPkiPath);
      const secret = env.BETTER_COMPUTE_SECRET;
      const rootKeyPath = flags['root-key'] ? path(flags['root-key']) : undefined;
      const bundle = importPkiBundle(await readBundleText(target), {
        ...(secret ? { secret } : {}),
        ...(rootKeyPath ? { rootKey: await readFile(rootKeyPath, 'utf8') } : {}),
      });
      const which = flags.ca as BundleCa;
      let renewed: PkiBundle;
      try {
        renewed = renewBundleCa(bundle, which, { validitySeconds: (flags.days ?? 365) * 86_400 });
      } catch (error) {
        throw new CliError('INVALID_STATE', (error as Error).message);
      }
      // An offline root stays offline: the key read from --root-key is not written into the bundle.
      await replace(
        target,
        exportPkiBundle(renewed, { ...(secret ? { secret } : {}), omitRootKey: Boolean(rootKeyPath) }),
      );
      const ca = which === 'node' ? renewed.nodeCa : which === 'serving' ? renewed.servingCa : renewed.internalCa;
      note(`Renewed the ${which} CA certificate; roll the bundle out to every process.`);
      return {
        ca: which,
        notAfter: iso(ca.notAfter),
        serial: parseCertificate(ca.certificate).serial,
        ...(which === 'serving' ? { servingCaSpkiPin: pkiPins(renewed).servingCaSpkiPin } : {}),
      };
    },
  }),
  defineCommand({
    name: 'pki issue-gateway',
    group: 'PKI',
    summary: 'Issue a gateway serving certificate and key from the serving CA',
    description:
      "pki issue-gateway generates a P-256 key and issues a serving certificate for it from the bundle's gateway serving CA (PLAN.md §7.1): DNS SANs from --san (comma-separated), serverAuth, 30 days by default. It writes <name>.key (mode 0600) and <name>.crt (the certificate followed by the serving CA's chain) into --out, replacing earlier files atomically so a running gateway can hot-reload them. Daemons trust the certificate through the serving CA pin (pki show).",
    flags: {
      san: {
        type: 'string',
        value: 'NAMES',
        required: true,
        description: 'DNS names, comma-separated, e.g. gw.eu-central.example.com',
      },
      out: {
        type: 'string',
        value: 'DIR',
        default: '.better-compute/gateway',
        description: 'Directory for the key and certificate',
      },
      name: {
        type: 'string',
        value: 'NAME',
        default: 'gateway',
        description: 'File name stem: NAME.key and NAME.crt',
      },
      days: {
        type: 'integer',
        value: 'N',
        default: 30,
        min: 1,
        max: 30,
        description: 'Certificate lifetime in days',
      },
      pki: pkiFlag,
    },
    examples: [
      'better-compute pki issue-gateway --san gw.eu-central.example.com',
      'better-compute pki issue-gateway --san gw1.example.com,gw.example.com --out /etc/better-compute/tls --days 14',
    ],
    validate(flags) {
      if (!/^[a-zA-Z0-9._-]+$/.test(flags.name ?? 'gateway'))
        throw usageError('--name must be a plain file name');
    },
    async run({ flags, env, path, note }) {
      const bundle = await loadPkiBundle(path(flags.pki ?? defaultPkiPath), env);
      const dnsSans = flags
        .san!.split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
      if (dnsSans.length === 0) throw usageError('--san needs at least one DNS name');
      const { privateKey, publicKey } = generateP256KeyPair();
      const issued = await bundle.servingCa.issue(publicKey, {
        usage: 'server',
        dnsSans,
        role: 'gateway',
        ttlSeconds: (flags.days ?? 30) * 86_400,
      });
      const dir = path(flags.out ?? '.better-compute/gateway');
      const stem = flags.name ?? 'gateway';
      const keyPath = join(dir, `${stem}.key`);
      const certPath = join(dir, `${stem}.crt`);
      // The chain stops below the root: clients anchor at the pinned serving CA.
      const chain = [issued.certificate, ...issued.chain.slice(0, -1)];
      await replace(keyPath, privateKeyPem(privateKey));
      await replace(certPath, chain.map((der) => toPem(der)).join(''), 0o644);
      note(`Wrote ${keyPath} and ${certPath}.`);
      return {
        serial: issued.serial,
        dnsSans,
        notBefore: iso(issued.notBefore),
        notAfter: iso(issued.notAfter),
        key: keyPath,
        certificate: certPath,
        servingCaSpkiPin: pkiPins(bundle).servingCaSpkiPin,
      };
    },
  }),
];
