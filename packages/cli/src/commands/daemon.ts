import { readFile, writeFile } from 'node:fs/promises';
import {
  readPkiPins,
  verifyReleaseManifest,
  type ReleaseManifest,
  type SignedReleaseManifest,
} from '@better-compute/pki';
import type { Finding, SqlExecutor } from '@better-compute/core';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { renderInstallScript, type BcdArch } from '../install-script.js';
import { defaultPkiPath, pkiFlag, pkiUnlockOptions } from './pki.js';

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

const archive = /\.(tar\.gz|tgz|zip|sha256|sig|pem|json|txt|sbom|spdx|intoto\.jsonl)$/;

/**
 * The binary digests an install script pins, from a verified release manifest: per architecture,
 * the one `linux-<arch>` artifact that is the bare binary (archives, checksums and metadata are
 * not what `{downloads}/bcd/{version}/linux-{arch}` serves).
 */
export function binaryDigests(manifest: ReleaseManifest): Partial<Record<BcdArch, string>> {
  const out: Partial<Record<BcdArch, string>> = {};
  for (const arch of ['amd64', 'arm64'] as const) {
    const binaries = manifest.artifacts.filter(
      (artifact) => artifact.platform === `linux-${arch}` && !archive.test(artifact.name),
    );
    if (binaries.length > 1)
      throw new CliError(
        'RELEASE_AMBIGUOUS',
        `The manifest lists ${binaries.length} linux-${arch} binaries: ${binaries.map((item) => item.name).join(', ')}`,
      );
    if (binaries[0]) out[arch] = binaries[0].sha256;
  }
  if (!out.amd64 && !out.arm64)
    throw new CliError(
      'RELEASE_INCOMPLETE',
      'The manifest lists no linux-amd64 or linux-arm64 bcd binary',
    );
  return out;
}

/** Verifies `--release-manifest` under `--release-pins` for bcd at `version`. */
async function digestsFromManifest(
  file: string,
  pins: string | undefined,
  threshold: number | undefined,
  version: string,
): Promise<Partial<Record<BcdArch, string>>> {
  const list = (pins ?? '')
    .split(',')
    .map((pin) => pin.trim())
    .filter(Boolean);
  if (!list.length || !list.every((pin) => /^sha256\/[A-Za-z0-9+/]{43}=$/.test(pin)))
    throw usageError('--release-manifest needs --release-pins sha256/…[,sha256/…]');
  let signed: SignedReleaseManifest;
  try {
    signed = JSON.parse(await readFile(file, 'utf8')) as SignedReleaseManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new CliError('FILE_NOT_FOUND', `No release manifest at ${file}`);
    throw usageError(`${file} is not JSON`);
  }
  let manifest: ReleaseManifest;
  try {
    manifest = verifyReleaseManifest(
      signed,
      { pins: list, ...(threshold !== undefined ? { threshold } : {}) },
      { product: 'bcd' },
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ACCESS_DENIED')
      throw new CliError('RELEASE_REJECTED', (error as Error).message);
    throw error;
  }
  if (manifest.version.replace(/^v/, '') !== version)
    throw new CliError(
      'RELEASE_MISMATCH',
      `The manifest releases bcd ${manifest.version}, not ${version}`,
    );
  return binaryDigests(manifest);
}

/**
 * doctor's daemon checks: connected site agents whose Hello lacks `site.bmc-networks` have no local deny list for
 * site.httpProxy (config.toml [site] bmc_networks; the control plane cannot set it for them).
 */
export async function daemonFindings(sql: Pick<SqlExecutor, 'query'>): Promise<Finding[]> {
  // Before migrations (doctor reports those itself): nothing to check yet.
  const { rows: ready } = await sql.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('node_sessions')
                      AND attname = 'capabilities' AND NOT attisdropped) AS ok`,
  );
  if (!ready[0]?.ok) return [];
  const { rows } = await sql.query<{ node_id: string; total: string | number }>(
    `SELECT s.node_id, count(*) OVER () AS total
       FROM node_sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.role = 'site' AND s.gateway_id IS NOT NULL AND s.disconnected_at IS NULL
        AND NOT ('site.bmc-networks' = ANY (s.capabilities))
      ORDER BY s.node_id LIMIT 5`,
  );
  if (!rows.length) return [];
  const total = Number(rows[0]!.total);
  return [
    {
      check: 'daemon.site-bmc-networks',
      severity: 'warning',
      message: `${total} connected site agent(s) have no BMC network deny list (${rows.map((row) => row.node_id).join(', ')}${total > rows.length ? ', …' : ''}): site.httpProxy only has the control plane's word for which addresses it may reach`,
      fix: 'Set [site] bmc_networks in their /etc/bcd/config.toml (daemon install-script --bmc-networks CIDR,…) and restart bcd',
    },
  ];
}

export const daemonCommands = [
  defineCommand({
    name: 'daemon install-script',
    group: 'Fleet',
    summary: 'Write the POSIX sh script that installs bcd on a server and joins it to a pool',
    description:
      "daemon install-script emits the bcd installer (PLAN.md §3.3, §6). The script reads the join token only from BCD_JOIN_TOKEN or standard input, downloads the pinned bcd for the machine's architecture from {base-url}{base-path}/downloads/bcd/{version}/linux-{arch}, checks it against --sha256 (or the digests of a --release-manifest verified here under --release-pins, product bcd, version --bcd-version), installs /usr/local/bin/bcd, /etc/bcd/config.toml (mode 0600: gateway URL, site and the serving CA, join signing and join encryption key pins, in bcd's sha256/<base64> form), the JoinService encryption key, and a hardened bcd.service, then runs bcd join and starts the service. Run on a configured host without a token, it upgrades bcd in place. The pins come from the PKI bundle's public half (pki init), so no secret is needed. The script holds no secret either: create the join token separately (joinTokens.create) and hand it over out of band. --plugins prepares the node for bcx driver plugins: a [plugins] section (dir /usr/local/lib/bcd/plugins, a child of bcd's delegated cgroup) and a bcd.service.d drop-in that lets bcd run each plugin under its own uid in its own cgroup (CAP_SETUID/CAP_SETGID/CAP_KILL, Delegate=yes); --privileged-plugins names the ones that run as root and make namespaces (Kata). Any node whose config.toml has a [plugins] section gets the drop-in, and an upgrade keeps the sections the operator configured.",
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
        description:
          'SHA-256 of each architecture’s binary: amd64=<hex>,arm64=<hex> (or use --release-manifest)',
      },
      'release-manifest': {
        type: 'string',
        value: 'PATH',
        description: 'A signed bcd release manifest: its verified digests are pinned instead',
      },
      'release-pins': {
        type: 'string',
        value: 'PINS',
        env: 'BCD_RELEASE_PINS',
        description: 'Comma-separated sha256/… pins of the release keys',
      },
      'release-threshold': {
        type: 'integer',
        value: 'N',
        min: 1,
        max: 16,
        description: 'Release keys that must have signed (default 1)',
      },
      plugins: { type: 'boolean', description: 'Prepare the node for bcx driver plugins ([plugins], the systemd drop-in)' },
      'websocket-url': {
        type: 'string',
        value: 'URL',
        description: 'Dial the gateway over WebSocket (wss://…/v1/session) behind TLS-inspecting proxies',
      },
      'websocket-audience': {
        type: 'string',
        value: 'HOST',
        description: "The gateway's public host the WebSocket proof names (default: the URL's host)",
      },
      'proxy-ca-file': {
        type: 'string',
        value: 'PATH',
        description: "The TLS-inspecting proxy's CA (PEM), trusted for the WebSocket's TLS only",
      },
      'bmc-networks': {
        type: 'string',
        value: 'CIDRS',
        description: "A site agent's BMC networks (comma-separated): site.httpProxy never reaches into them",
      },
      'approver-set-sha256': {
        type: 'string',
        value: 'HEX',
        description: "Pin the deployment's approver set (pki trust-version prints it): its first set, or nothing destructive",
      },
      'privileged-plugins': {
        type: 'string',
        value: 'NAMES',
        description: 'Plugins that run as root without the seccomp filter (comma-separated; implies --plugins)',
      },
      'release-sequence': {
        type: 'integer',
        value: 'N',
        min: 1,
        description: "bcd's release floor ([update] release_sequence): it never installs an older release",
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
    validate(flags) {
      if ((flags.sha256 === undefined) === (flags['release-manifest'] === undefined))
        throw usageError('Give exactly one of --sha256 or --release-manifest');
      if ((flags['websocket-audience'] !== undefined || flags['proxy-ca-file'] !== undefined) && !flags['websocket-url'])
        throw usageError('--websocket-audience and --proxy-ca-file need --websocket-url');
      if (flags['release-sequence'] !== undefined && !flags['release-pins'])
        throw usageError('--release-sequence needs --release-pins: bcd self-updates only under release keys');
    },
    async run({ flags, path, note, program, env }) {
      const version = flags['bcd-version']!.replace(/^v/, '');
      const sha256 = flags['release-manifest']
        ? await digestsFromManifest(
            path(flags['release-manifest']),
            flags['release-pins'],
            flags['release-threshold'],
            version,
          )
        : parseSha256Flag(flags.sha256!);
      const basePath = (flags['base-path'] ?? '/api/compute').replace(/\/+$/, '');
      if (!/^(\/[A-Za-z0-9._~-]+)*$/.test(basePath))
        throw usageError('--base-path must look like /api/compute');
      let pins;
      try {
        // The pins every new node trusts: checked against the seal when the secret is here.
        pins = readPkiPins(await readFile(path(flags.pki ?? defaultPkiPath), 'utf8'), pkiUnlockOptions(env));
        if (!pins.authenticated)
          note(
            'Warning: these pins come from a bundle nothing vouches for here (set BETTER_COMPUTE_SECRET to check them against the seal).',
          );
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
        version,
        sha256,
        servingCaSpkiPin: pins.servingCaSpkiPin,
        joinSigningKeyPin: pins.joinSigningKeyPin,
        joinEncryptionKeyPin: pins.joinEncryptionKeyPin,
        joinEncryptionJwk: pins.joinEncryptionJwk as {
          kty: string;
          crv: string;
          x: string;
          y: string;
        },
        ...(flags['approver-set-sha256'] ? { approverSetSha256: flags['approver-set-sha256'] } : {}),
        ...(flags['websocket-url']
          ? {
              websocket: {
                url: flags['websocket-url'],
                ...(flags['websocket-audience'] ? { audience: flags['websocket-audience'] } : {}),
                ...(flags['proxy-ca-file']
                  ? { proxyCaPem: (await readFile(path(flags['proxy-ca-file']), 'utf8')).replace(/\r\n/g, '\n') }
                  : {}),
              },
            }
          : {}),
        ...(flags['bmc-networks'] !== undefined
          ? {
              bmcNetworks: flags['bmc-networks']
                .split(',')
                .map((cidr) => cidr.trim())
                .filter(Boolean),
            }
          : {}),
        // The release keys that verified the manifest are the ones bcd self-updates under.
        ...(flags['release-pins']
          ? {
              update: {
                releasePins: flags['release-pins']
                  .split(',')
                  .map((pin) => pin.trim())
                  .filter(Boolean),
                ...(flags['release-threshold'] === undefined ? {} : { threshold: flags['release-threshold'] }),
                ...(flags['release-sequence'] === undefined ? {} : { sequence: flags['release-sequence'] }),
              },
            }
          : {}),
        ...(flags.plugins || flags['privileged-plugins']
          ? {
              plugins: {
                privileged: (flags['privileged-plugins'] ?? '')
                  .split(',')
                  .map((name) => name.trim())
                  .filter(Boolean),
              },
            }
          : {}),
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
