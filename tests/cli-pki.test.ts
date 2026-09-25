import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bcdServiceUnit,
  createCli,
  renderBcdConfig,
  renderInstallScript,
  type CliIO,
} from '@better-compute/cli';
import { manualClock } from '@better-compute/core';
import { pkiFindings } from '../packages/cli/src/commands/pki.js';
import {
  buildReleaseManifest,
  createPkiBundle,
  createReleaseSigningKey,
  exportPkiBundle,
  fromPem,
  importPkiBundle,
  parseCertificate,
  pkiPins,
  readPkiPins,
  releaseArtifact,
  signReleaseManifest,
  spkiPin,
} from '@better-compute/pki';

// The W5c PKI and daemon commands (PLAN.md §3.3, §6, §7.1, §13): pki init/show/issue-gateway and
// daemon install-script, run in process against a scratch directory.

const SECRET = 'better-compute-cli-pki-secret-0123456789';
const sha = 'a'.repeat(64);
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'bc-cli-pki-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(argv: string[], env: NodeJS.ProcessEnv = {}, cwd = scratch) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => err.push(line), env, cwd };
  try {
    await createCli().run(argv, io);
    return { ok: true as const, stdout: out.join('\n'), stderr: err.join('\n') };
  } catch (error) {
    return {
      ok: false as const,
      code: (error as { code?: string }).code,
      message: (error as Error).message,
      stdout: out.join('\n'),
    };
  }
}

/** A POSIX shell for syntax checks: sh on Linux CI, GitHub Desktop's dash on this Windows box. */
function posixShell(): string | undefined {
  const candidates = [
    '/bin/sh',
    process.env.LOCALAPPDATA &&
      join(
        process.env.LOCALAPPDATA,
        'GitHubDesktop',
        'app-3.6.5',
        'resources',
        'app',
        'git',
        'usr',
        'bin',
        'dash.exe',
      ),
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path));
}

describe('pki commands', () => {
  it('refuses to write private keys in the clear unless asked', async () => {
    const result = await run([
      'pki',
      'init',
      '--trust-domain',
      'compute.test',
      '--pki',
      'refused.json',
    ]);
    expect(result).toMatchObject({ ok: false, code: 'MISSING_ENV' });
    expect(existsSync(join(scratch, 'refused.json'))).toBe(false);
    expect(
      await run(['pki', 'init', '--trust-domain', 'compute.test'], {
        BETTER_COMPUTE_SECRET: 'short',
      }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_CONFIG',
    });
  });

  it('pki init seals the bundle, prints pins and never overwrites', async () => {
    const env = { BETTER_COMPUTE_SECRET: SECRET };
    const result = await run(['pki', 'init', '--trust-domain', 'compute.test'], env);
    expect(result.ok).toBe(true);
    const pins = JSON.parse(result.stdout);
    expect(pins).toMatchObject({ trustDomain: 'compute.test' });
    expect(pins.servingCaSpkiPin).toMatch(/^sha256\//);
    const text = await readFile(join(scratch, '.better-compute', 'pki.json'), 'utf8');
    expect(text).not.toContain('PRIVATE KEY');
    expect(pkiPinsOf(importPkiBundle(text, { secret: SECRET }))).toEqual({
      servingCaSpkiPin: pins.servingCaSpkiPin,
      joinSigningKeyPin: pins.joinSigningKeyPin,
      joinEncryptionKeyPin: pins.joinEncryptionKeyPin,
    });
    expect(await run(['pki', 'init', '--trust-domain', 'compute.test'], env)).toMatchObject({
      ok: false,
      code: 'FILE_EXISTS',
    });
    const shown = await run(['pki', 'show', '--query', 'servingCaSpkiPin']);
    expect(shown.stdout).toBe(pins.servingCaSpkiPin);
    const expires = JSON.parse((await run(['pki', 'show'])).stdout).expires;
    expect(new Date(expires.nodeCa).getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000);
  });

  it('keeps the root key in its own file with --offline-root', async () => {
    const result = await run(
      [
        'pki',
        'init',
        '--trust-domain',
        'compute.test',
        '--pki',
        'offline/pki.json',
        '--offline-root',
        'offline/root.key',
      ],
      { BETTER_COMPUTE_SECRET: SECRET },
    );
    expect(result.ok).toBe(true);
    const bundle = importPkiBundle(await readFile(join(scratch, 'offline', 'pki.json'), 'utf8'), {
      secret: SECRET,
    });
    expect(bundle.root).toBeUndefined();
    const rootKey = await readFile(join(scratch, 'offline', 'root.key'), 'utf8');
    expect(rootKey).not.toContain('PRIVATE KEY');
  });

  it('pki issue-gateway writes a key and a chain that the serving CA verifies, replacing old files', async () => {
    const env = { BETTER_COMPUTE_SECRET: SECRET };
    const first = await run(
      ['pki', 'issue-gateway', '--san', 'GW.compute.test, gw2.compute.test', '--days', '14'],
      env,
    );
    expect(first.ok).toBe(true);
    const issued = JSON.parse(first.stdout);
    expect(issued.dnsSans).toEqual(['gw.compute.test', 'gw2.compute.test']);
    const chain = fromPem(
      await readFile(join(scratch, '.better-compute', 'gateway', 'gateway.crt'), 'utf8'),
    );
    expect(chain).toHaveLength(2);
    const bundle = importPkiBundle(
      await readFile(join(scratch, '.better-compute', 'pki.json'), 'utf8'),
      { secret: SECRET },
    );
    expect(bundle.servingCa.verify(chain, { usage: 'server' })[0]!.dnsSans).toEqual(issued.dnsSans);
    expect(parseCertificate(chain[1]!).subjectCommonName).toMatch(/serving CA/);
    expect(issued.servingCaSpkiPin).toBe(spkiPin(bundle.servingCa.publicKey));
    const key = await readFile(join(scratch, '.better-compute', 'gateway', 'gateway.key'), 'utf8');
    expect(key).toContain('PRIVATE KEY');

    const second = await run(['pki', 'issue-gateway', '--san', 'gw.compute.test'], env);
    expect(JSON.parse(second.stdout).serial).not.toBe(issued.serial);
    expect(
      await run(['pki', 'issue-gateway', '--san', 'gw.compute.test', '--days', '31'], env),
    ).toMatchObject({ ok: false });
    expect(await run(['pki', 'issue-gateway', '--san', 'gw.compute.test'])).toMatchObject({
      ok: false,
      code: 'INVALID_CONFIG',
    });
    expect(
      await run(['pki', 'issue-gateway', '--san', 'gw.compute.test', '--name', '../x'], env),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
  });

  it('routes two-word commands and helps with the group', async () => {
    const group = await run(['help', 'pki']);
    expect(group.stdout).toContain('pki init');
    expect(group.stdout).toContain('pki issue-gateway');
    expect((await run(['help', 'pki', 'show'])).stdout).toContain('public half');
    expect(await run(['pki'])).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    expect((await run(['pki'])).message).toContain('init, show, add-sandbox-ca, reseal, rotate-command-root, renew-ca, issue-gateway');
  });
});

function pkiPinsOf(bundle: ReturnType<typeof importPkiBundle>) {
  const pins = pkiPins(bundle);
  return {
    servingCaSpkiPin: pins.servingCaSpkiPin,
    joinSigningKeyPin: pins.joinSigningKeyPin,
    joinEncryptionKeyPin: pins.joinEncryptionKeyPin,
  };
}

describe('doctor PKI findings', () => {
  it('reports nothing without a bundle, and expiry and unseal problems with one', async () => {
    expect(await pkiFindings(join(scratch, 'none.json'), {})).toEqual([]);
    const clock = manualClock(Date.UTC(2026, 8, 24));
    const bundle = createPkiBundle({
      trustDomain: 'compute.test',
      clock,
      caValiditySeconds: 20 * 86_400,
    });
    const file = join(scratch, 'expiring.json');
    await writeFile(file, exportPkiBundle(bundle, { secret: SECRET }));
    const soon = await pkiFindings(file, { BETTER_COMPUTE_SECRET: SECRET }, clock.now());
    expect(soon.map((finding) => finding.check)).toEqual([
      'pki.ca-expiring',
      'pki.ca-expiring',
      'pki.ca-expiring',
    ]);
    const later = await pkiFindings(file, {}, clock.now() + 21 * 86_400_000);
    expect(later.map((finding) => finding.check)).toEqual([
      'pki.ca-expired',
      'pki.ca-expired',
      'pki.ca-expired',
      'pki.unseal',
    ]);
    await writeFile(join(scratch, 'broken.json'), '{"format":"x"}');
    expect((await pkiFindings(join(scratch, 'broken.json'), {}))[0]).toMatchObject({
      check: 'pki.unreadable',
      severity: 'error',
    });
  });

  it('runs as part of doctor', async () => {
    const env = {
      BETTER_COMPUTE_DATABASE_URL: 'pglite:memory',
      BETTER_COMPUTE_SECRET: 'wrong-secret-but-long-enough-0123456789',
    };
    const result = await run(['doctor', '--query', 'findings[].check'], env);
    expect(result.ok && JSON.parse(result.stdout)).toContain('pki.unseal');
    const good = await run(['doctor', '--query', 'findings[].check'], {
      ...env,
      BETTER_COMPUTE_SECRET: SECRET,
    });
    expect(good.ok && JSON.parse(good.stdout)).not.toContain('pki.unseal');
  });
});

describe('daemon install-script', () => {
  const base = [
    'daemon',
    'install-script',
    '--pool',
    'pool_h100',
    '--site',
    'fsn1-dc14',
    '--gateway-url',
    'https://gw.eu.compute.test',
    '--base-url',
    'https://compute.test/',
    '--bcd-version',
    'v0.1.0',
    '--sha256',
    `amd64=${sha}`,
  ];

  it('renders the script with bcd’s exact config and the pinned download', async () => {
    const result = await run(base);
    expect(result.ok).toBe(true);
    const script = result.stdout;
    const pins = readPkiPins(await readFile(join(scratch, '.better-compute', 'pki.json'), 'utf8'));
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain("DOWNLOADS='https://compute.test/api/compute/downloads'");
    expect(script).toContain("BCD_VERSION='0.1.0'");
    expect(script).toContain(`SHA256_amd64='${sha}'`);
    expect(script).toContain("SHA256_arm64=''");
    const config = script.split("<<'BCD_CONFIG'\n")[1]!.split('BCD_CONFIG\n')[0]!;
    // daemon/internal/config: only known keys, basic strings, every required key once.
    const entries = config
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => /^([a-z_]+) = "([^"\\]*)"$/.exec(line));
    expect(entries.every(Boolean)).toBe(true);
    expect(Object.fromEntries(entries.map((match) => [match![1], match![2]]))).toEqual({
      gateway_url: 'https://gw.eu.compute.test',
      site: 'fsn1-dc14',
      serving_ca_spki_pin: pins.servingCaSpkiPin,
      join_signing_key_pin: pins.joinSigningKeyPin,
      join_encryption_key_pin: pins.joinEncryptionKeyPin,
    });
    expect(script).toContain(JSON.stringify(pins.joinEncryptionJwk));
    expect(script).toContain(bcdServiceUnit);
    // The token never reaches a command line.
    expect(script).not.toMatch(/bcd join[^\n]*\$TOKEN/);
    expect(script).toContain('| /usr/local/bin/bcd join --config /etc/bcd/config.toml');
  });

  it('pins the binary digests of a verified release manifest instead of --sha256', async () => {
    const key = createReleaseSigningKey();
    const binary = new TextEncoder().encode('bcd 0.1.0 amd64 binary');
    const manifest = buildReleaseManifest({
      product: 'bcd',
      version: '0.1.0',
      sequence: 3,
      signers: [key],
      artifacts: [
        releaseArtifact('bcd_0.1.0_linux_amd64', binary, 'linux-amd64'),
        releaseArtifact('bcd_0.1.0_linux_amd64.tar.gz', new Uint8Array(9), 'linux-amd64'),
      ],
    });
    await writeFile(
      join(scratch, 'release.json'),
      JSON.stringify(signReleaseManifest(manifest, [key])),
    );
    const withManifest = [...base.slice(0, -2), '--release-manifest', 'release.json'];
    const pins = { BCD_RELEASE_PINS: spkiPin(key.publicKey) };
    const result = await run(withManifest, pins);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(`SHA256_amd64='${manifest.artifacts[0]!.sha256}'`);
    expect(result.stdout).toContain("SHA256_arm64=''");

    const other = createReleaseSigningKey();
    expect(await run(withManifest, { BCD_RELEASE_PINS: spkiPin(other.publicKey) })).toMatchObject({
      ok: false,
      code: 'RELEASE_REJECTED',
    });
    const wrongVersion = withManifest.map((arg) => (arg === 'v0.1.0' ? '0.2.0' : arg));
    expect(await run(wrongVersion, pins)).toMatchObject({ ok: false, code: 'RELEASE_MISMATCH' });
    expect(await run([...base, '--release-manifest', 'release.json'], pins)).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
  });

  it('is valid POSIX sh', async () => {
    const shell = posixShell();
    if (!shell) return;
    const file = join(scratch, 'install-check.sh');
    await writeFile(file, (await run(base)).stdout);
    const checked = spawnSync(shell, ['-n', file], { encoding: 'utf8' });
    expect(checked.stderr).toBe('');
    expect(checked.status).toBe(0);
  });

  it('gives a node with [plugins] the plugin drop-in, keeps the operator’s sections on upgrade', async () => {
    const shell = posixShell();
    if (!shell) return;
    const root = (await mkdtemp(join(tmpdir(), 'bc-install-root-'))).replace(/\\/g, '/');
    // Run the script's config and unit steps against a scratch root (no systemctl).
    const apply = async (extra: string[]) => {
      const script = (await run([...base, ...extra])).stdout;
      const block = script
        .slice(script.indexOf("cat > /etc/bcd/config.toml.new"), script.indexOf('systemctl daemon-reload'))
        .split('/etc/')
        .join(`${root}/etc/`);
      const file = join(scratch, 'plugins-check.sh');
      // (Git for Windows' minimal usr/bin has no chmod or install: shims there, the real ones elsewhere.)
      const shims = [
        'command -v chmod >/dev/null 2>&1 || chmod() { :; }',
        'command -v install >/dev/null 2>&1 || install() { [ "$1" = -d ] || return 1; shift; [ "$1" = -m ] && shift 2; mkdir -p "$@"; }',
      ].join('\n');
      await writeFile(file, `set -eu\n${shims}\nmkdir -p ${root}/etc/bcd ${root}/etc/systemd/system\n${block}`);
      // sed, grep, install… from the shell's own directory (Git's usr/bin on Windows).
      const result = spawnSync(shell, [file], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dirname(shell)}${delimiter}${process.env.PATH ?? ''}` },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const read = async (path: string) => readFile(`${root}${path}`, 'utf8').catch(() => undefined);
      return {
        config: (await read('/etc/bcd/config.toml'))!,
        dropIn: await read('/etc/systemd/system/bcd.service.d/plugins.conf'),
      };
    };
    // A node without plugins keeps the tight unit: no section, no drop-in.
    let node = await apply([]);
    expect(node.config).not.toContain('[plugins]');
    expect(node.dropIn).toBeUndefined();
    expect(bcdServiceUnit).not.toContain('CAP_SETUID');
    // --plugins with a privileged (Kata) plugin: the section and the drop-in, namespaces allowed.
    node = await apply(['--plugins', '--privileged-plugins', 'kata']);
    expect(node.config).toContain('[plugins]\ndir = "/usr/local/lib/bcd/plugins"\n');
    expect(node.config).toContain('privileged = "kata"');
    expect(node.dropIn).toContain('CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL');
    expect(node.dropIn).toContain('Delegate=yes');
    expect(node.dropIn).toContain('RestrictNamespaces=no');
    // An upgrade from a script without --plugins keeps the operator's sections, and so the drop-in.
    await writeFile(`${root}/etc/bcd/config.toml`, `${node.config}[imds]\nlisten = "169.254.169.254:80"\n`);
    node = await apply([]);
    expect(node.config).toContain('privileged = "kata"');
    expect(node.config).toContain('[imds]\nlisten = "169.254.169.254:80"');
    expect(node.config.match(/^\[plugins\]$/gm)).toHaveLength(1);
    expect(node.dropIn).toContain('CAP_SETUID');
    // The operator removes [plugins]: the next run removes the drop-in; without privileged plugins, no namespaces.
    await writeFile(`${root}/etc/bcd/config.toml`, node.config.replace(/\[plugins\][^[]*/, ''));
    node = await apply([]);
    expect(node.dropIn).toBeUndefined();
    node = await apply(['--plugins']);
    expect(node.dropIn).toContain('Delegate=yes');
    expect(node.dropIn).not.toContain('RestrictNamespaces=no');
    expect(await run([...base, '--privileged-plugins', 'kata;rm'])).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('reads the token from the environment or stdin only, and refuses anything else', async () => {
    const shell = posixShell();
    if (!shell) return;
    // Run just the token-reading block of the script with the checks before it stubbed out.
    const script = (await run(base)).stdout;
    const block = script.slice(script.indexOf('TOKEN=\n'), script.indexOf('TMP=$(mktemp -d)'));
    const harness = `fail() { printf 'FAIL:%s\\n' "$1"; exit "\${2:-1}"; }\n${block}printf 'TOKEN:%s\\n' "$TOKEN"\n`;
    const file = join(scratch, 'token-check.sh');
    await writeFile(file, harness);
    const token = 'bcjt_jt_01k5w00000000000000000000a.secret';
    const viaEnv = spawnSync(shell, [file], {
      encoding: 'utf8',
      env: { ...process.env, BCD_JOIN_TOKEN: token },
      input: '',
    });
    expect(viaEnv.stdout.trim()).toBe(`TOKEN:${token}`);
    const viaStdin = spawnSync(shell, [file], {
      encoding: 'utf8',
      env: { ...process.env, BCD_JOIN_TOKEN: '' },
      input: `${token}\n`,
    });
    expect(viaStdin.stdout.trim()).toBe(`TOKEN:${token}`);
    const junk = spawnSync(shell, [file], {
      encoding: 'utf8',
      env: { ...process.env, BCD_JOIN_TOKEN: '' },
      input: 'rm -rf /\n',
    });
    expect(junk.stdout).toContain('FAIL:that is not a join token');
    expect(junk.status).toBe(2);
  });

  it('refuses unsafe or malformed values before rendering anything', async () => {
    const swap = (flag: string, value: string) => {
      const argv = [...base];
      argv[argv.indexOf(flag) + 1] = value;
      return run(argv);
    };
    for (const [flag, value] of [
      ['--site', "x'; rm -rf / #"],
      ['--pool', 'a b'],
      ['--gateway-url', 'http://gw.compute.test'],
      ['--gateway-url', 'https://gw.compute.test/$(id)'],
      ['--bcd-version', 'latest'],
    ] as const)
      expect(await swap(flag, value), `${flag} ${value}`).toMatchObject({
        ok: false,
        code: 'INVALID_INPUT',
      });
    for (const value of ['amd64', 'mips=abc', `amd64=${sha},amd64=${sha}`])
      expect(await swap('--sha256', value), value).toMatchObject({
        ok: false,
        code: 'INVALID_ARGUMENT',
      });
    expect(await swap('--sha256', 'amd64=xyz')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await run([...base, '--pki', 'missing.json'])).toMatchObject({
      ok: false,
      code: 'PKI_NOT_FOUND',
    });
  });

  it('writes a new executable file with --out and never overwrites it', async () => {
    expect((await run([...base, '--out', 'install-bcd.sh'])).ok).toBe(true);
    expect(await readFile(join(scratch, 'install-bcd.sh'), 'utf8')).toContain('#!/bin/sh');
    expect(await run([...base, '--out', 'install-bcd.sh'])).toMatchObject({
      ok: false,
      code: 'FILE_EXISTS',
    });
  });
});

describe('renderers', () => {
  it('render config.toml without the join token and a hardened unit', () => {
    const config = renderBcdConfig({
      gatewayUrl: 'https://gw.test',
      siteId: 's1',
      servingCaSpkiPin: 'p1',
      joinSigningKeyPin: 'p2',
      joinEncryptionKeyPin: 'p3',
    });
    expect(config).not.toMatch(/token/i);
    for (const setting of [
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'StateDirectory=bcd',
    ])
      expect(bcdServiceUnit).toContain(setting);
    expect(() =>
      renderInstallScript({
        poolId: 'p',
        siteId: 's',
        gatewayUrl: 'https://gw.test',
        downloadsBase: 'https://c.test/api/compute/downloads',
        version: '0.1.0',
        sha256: { amd64: sha },
        servingCaSpkiPin: 'sha256/not-a-pin',
        joinSigningKeyPin: 'sha256/not-a-pin',
        joinEncryptionKeyPin: 'sha256/not-a-pin',
        joinEncryptionJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      }),
    ).toThrow(/serving CA pin/);
  });
});
