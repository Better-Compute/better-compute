import { readFile, writeFile } from 'node:fs/promises';
import { readPkiPins } from '@better-compute/pki';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { renderInstallScript, type BcdArch } from '../install-script.js';
import { defaultPkiPath, pkiFlag } from './pki.js';

/** Parses `amd64=<hex>,arm64=<hex>`. */
export function parseSha256Flag(value: string): Partial<Record<BcdArch, string>> {
  const out: Partial<Record<BcdArch, string>> = {};
  for (const part of value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [arch, hash, extra] = part.split('=');
    if (!arch || !hash || extra !== undefined || (arch !== 'amd64' && arch !== 'arm64'))
      throw usageError(`--sha256 takes amd64=<hex>,arm64=<hex>; got ${JSON.stringify(part)}`);
    if (out[arch]) throw usageError(`--sha256 names ${arch} twice`);
    out[arch] = hash.toLowerCase();
  }
  return out;
}

export const daemonCommands = [
  defineCommand({
    name: 'daemon install-script',
    group: 'Fleet',
    summary: 'Write the POSIX sh script that installs bcd on a server and joins it to a pool',
    description:
      "daemon install-script emits the bcd installer (PLAN.md §3.3, §6). The script reads the join token only from BCD_JOIN_TOKEN or standard input, downloads the pinned bcd for the machine's architecture from {base-url}{base-path}/downloads/bcd/{version}/linux-{arch}, checks it against --sha256, installs /usr/local/bin/bcd, /etc/bcd/config.toml (mode 0600: gateway URL, site and the serving CA, join signing and join encryption key pins, in bcd's sha256/<base64> form), the JoinService encryption key, and a hardened bcd.service, then runs bcd join and starts the service. Run on a configured host without a token, it upgrades bcd in place. The pins come from the PKI bundle's public half (pki init), so no secret is needed. The script holds no secret either: create the join token separately (joinTokens.create) and hand it over out of band.",
    output: 'text',
    flags: {
      pool: {
        type: 'string',
        value: 'ID',
        required: true,
        description: 'The pool the node joins (named in the script)',
      },
      site: {
        type: 'string',
        value: 'ID',
        required: true,
        description: "The pool's site id (config.toml site)",
      },
      'gateway-url': {
        type: 'string',
        value: 'URL',
        required: true,
        env: 'BETTER_COMPUTE_GATEWAY_URL',
        description: 'The regional gateway bcd dials, https://…',
      },
      'base-url': {
        type: 'string',
        value: 'URL',
        required: true,
        env: 'BETTER_COMPUTE_BASE_URL',
        description: 'The control plane serving the bcd downloads, https://…',
      },
      'base-path': {
        type: 'string',
        value: 'PATH',
        default: '/api/compute',
        description: "The API's base path",
      },
      'bcd-version': {
        type: 'string',
        value: 'VERSION',
        required: true,
        env: 'BETTER_COMPUTE_BCD_VERSION',
        description: 'The bcd release to install, e.g. 0.1.0',
      },
      sha256: {
        type: 'string',
        value: 'ARCH=HEX,…',
        required: true,
        description:
          'SHA-256 of each architecture’s binary: amd64=<hex>,arm64=<hex> (from the release .sha256 files)',
      },
      pki: pkiFlag,
      out: {
        type: 'string',
        value: 'PATH',
        description: 'Write the script to a new file (mode 0755) instead of standard output',
      },
    },
    examples: [
      'better-compute daemon install-script --pool pool_h100 --site fsn1 --gateway-url https://gw.eu.example.com --base-url https://compute.example.com --bcd-version 0.1.0 --sha256 amd64=<hex> > install-bcd.sh',
      'BCD_JOIN_TOKEN=bcjt_... sudo -E sh install-bcd.sh',
    ],
    async run({ flags, path, note, program }) {
      const basePath = (flags['base-path'] ?? '/api/compute').replace(/\/+$/, '');
      if (!/^(\/[A-Za-z0-9._~-]+)*$/.test(basePath))
        throw usageError('--base-path must look like /api/compute');
      let pins;
      try {
        pins = readPkiPins(await readFile(path(flags.pki ?? defaultPkiPath), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new CliError(
            'PKI_NOT_FOUND',
            `No PKI bundle at ${path(flags.pki ?? defaultPkiPath)}`,
            'Run better-compute pki init first, or pass --pki PATH.',
          );
        throw error;
      }
      const script = renderInstallScript({
        poolId: flags.pool!,
        siteId: flags.site!,
        gatewayUrl: flags['gateway-url']!,
        downloadsBase: `${flags['base-url']!.replace(/\/+$/, '')}${basePath}/downloads`,
        version: flags['bcd-version']!.replace(/^v/, ''),
        sha256: parseSha256Flag(flags.sha256!),
        servingCaSpkiPin: pins.servingCaSpkiPin,
        joinSigningKeyPin: pins.joinSigningKeyPin,
        joinEncryptionKeyPin: pins.joinEncryptionKeyPin,
        joinEncryptionJwk: pins.joinEncryptionJwk as {
          kty: string;
          crv: string;
          x: string;
          y: string;
        },
        generatedAt: new Date().toISOString(),
        generator: `better-compute ${program.version}`,
      });
      if (!flags.out) return script;
      const target = path(flags.out);
      try {
        await writeFile(target, script, { flag: 'wx', mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new CliError('FILE_EXISTS', `${target} already exists; it was not overwritten`);
        throw error;
      }
      note(
        `Wrote ${target}. Give each server its join token out of band (BCD_JOIN_TOKEN or stdin).`,
      );
      return `Wrote ${target}`;
    },
  }),
];
