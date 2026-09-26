import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    expect((await run(['pki'])).message).toContain('init, show, add-sandbox-ca, reseal, rotate-command-root, trust-version, renew-ca, issue-gateway');
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
      .map((line) => /^([a-z0-9_]+) = "([^"\\]*)"$/.exec(line));
    expect(entries.every(Boolean)).toBe(true);
    expect(Object.fromEntries(entries.map((match) => [match![1], match![2]]))).toEqual({
      gateway_url: 'https://gw.eu.compute.test',
      site: 'fsn1-dc14',
      serving_ca_spki_pin: pins.servingCaSpkiPin,
      join_signing_key_pin: pins.joinSigningKeyPin,
      join_encryption_key_pin: pins.joinEncryptionKeyPin,
      // The bundle's command-signing root, pinned for bcd helper's host units.
      ...(pins.commandSigningRootSha256 ? { command_root_sha256: pins.commandSigningRootSha256 } : {}),
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
    // bcd self-updates only under the release keys that verified this manifest ([update]; none, no self-update).
    expect(result.stdout).toContain(`[update]\nrelease_pins = "${spkiPin(key.publicKey)}"\nrelease_threshold = 1\n`);
    expect((await run(base)).stdout).not.toContain('[update]');
    const shell = posixShell();
    if (shell) {
      const file = join(scratch, 'install-update-check.sh');
      await writeFile(file, result.stdout);
      expect(spawnSync(shell, ['-n', file], { encoding: 'utf8' }).status).toBe(0);
    }
    expect(await run([...withManifest, '--release-threshold', '2'], pins)).toMatchObject({ ok: false });
    // The release floor: a config key beside the pins; a repeated pin is one key.
    const floored = await run([...withManifest, '--release-sequence', '41'], { BCD_RELEASE_PINS: `${pins.BCD_RELEASE_PINS},${pins.BCD_RELEASE_PINS}` });
    expect(floored.stdout).toContain(`release_pins = "${pins.BCD_RELEASE_PINS}"\nrelease_threshold = 1\nrelease_sequence = 41\n`);
    expect(await run([...base, '--release-sequence', '41'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });

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

  it('installs bcx plugins from the release: the signed archive digest, only the plugin’s regular member, its pin', async () => {
    const key = createReleaseSigningKey();
    const pins = { BCD_RELEASE_PINS: spkiPin(key.publicKey) };
    const shell = posixShell();
    const work = (await mkdtemp(join(tmpdir(), 'bc-plugin-'))).replace(/\\/g, '/');
    // Real archives from the shell's own tar: a good one, a symlink as the plugin, a member outside the archive.
    let archives: Record<'good' | 'link' | 'dotdot', Uint8Array> = {
      good: new TextEncoder().encode('good archive'),
      link: new Uint8Array(1),
      dotdot: new Uint8Array(2),
    };
    // GitHub Desktop's minimal git shell has no sha256sum: a node stand-in (sha256sum FILE… and -c -) there.
    const bin = join(work, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'sha256sum.cjs'),
      [
        "const { createHash } = require('node:crypto'); const { readFileSync } = require('node:fs');",
        "const sum = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');",
        "const args = process.argv.slice(2);",
        "if (args[0] === '-c') { let ok = true; for (const line of readFileSync(0, 'utf8').split('\\n').filter(Boolean)) { const [want, file] = line.split(/ [ *]/); try { if (sum(file) !== want) ok = false; } catch { ok = false; } } process.exit(ok ? 0 : 1); }",
        "for (const file of args) process.stdout.write(sum(file) + '  ' + file + '\\n');",
      ].join('\n'),
    );
    await writeFile(join(bin, 'sha256sum'), `#!/bin/sh\nexec node '${join(bin, 'sha256sum.cjs').replace(/\\\\/g, '/')}' "$@"\n`, { mode: 0o755 });
    const shellEnv = {
      ...process.env,
      PATH: [...(process.platform === 'win32' ? [bin] : []), ...(shell ? [dirname(shell)] : []), process.env.PATH ?? ''].join(delimiter),
    };
    if (shell) {
      const build = [
        'set -eu',
        `cd '${work}'`,
        'mkdir good link dotdot',
        "printf 'the bcx-ipmi binary' > good/bcx-ipmi",
        "printf 'readme' > good/README.md",
        'tar -czf good.tar.gz -C good bcx-ipmi README.md',
        // (No ln, or no right to make symlinks, on some Windows shells: that case is then skipped.)
        'if ln -s /etc/passwd link/bcx-ipmi 2>/dev/null; then tar -czf link.tar.gz -C link bcx-ipmi; fi',
        "printf 'x' > dotdot/bcx-ipmi",
        'cd dotdot && tar -czPf ../dotdot.tar.gz bcx-ipmi ../good/README.md && cd ..',
      ].join('\n');
      await writeFile(join(work, 'build.sh'), build);
      const built = spawnSync(shell, [join(work, 'build.sh')], { encoding: 'utf8', env: shellEnv });
      expect(built.status, built.stderr).toBe(0);
      archives = {
        good: await readFile(join(work, 'good.tar.gz')),
        link: await readFile(join(work, 'link.tar.gz')).catch(() => new Uint8Array()),
        dotdot: await readFile(join(work, 'dotdot.tar.gz')),
      };
    }
    const manifest = buildReleaseManifest({
      product: 'bcd',
      version: '0.1.0',
      sequence: 3,
      signers: [key],
      artifacts: [
        releaseArtifact('bcd_0.1.0_linux_amd64', new TextEncoder().encode('bcd'), 'linux-amd64'),
        releaseArtifact('bcx-ipmi_0.1.0_linux_amd64.tar.gz', archives.good, 'linux-amd64'),
      ],
    });
    await writeFile(join(scratch, 'release-plugins.json'), JSON.stringify(signReleaseManifest(manifest, [key])));
    const withManifest = [...base.slice(0, -2), '--release-manifest', 'release-plugins.json'];
    const result = await run([...withManifest, '--install-plugins', 'bcx-ipmi'], pins);
    expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
    const archiveSum = manifest.artifacts[1]!.sha256;
    expect(result.stdout).toContain(`amd64) PLUGIN_SHA256='${archiveSum}' ;;\n  arm64) PLUGIN_SHA256='' ;;`);
    expect(result.stdout).toContain(`install_plugin 'bcx-ipmi' "$PLUGIN_SHA256"`);
    // Installing a plugin prepares the node for plugins.
    expect(result.stdout).toContain('[plugins]\ndir = "/usr/local/lib/bcd/plugins"');
    expect(await run([...withManifest, '--install-plugins', 'bcx-evil'], pins)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await run([...base, '--install-plugins', 'bcx-ipmi'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await run([...withManifest, '--install-plugins', 'bcx-ipmi', '--unprivileged'], pins)).toMatchObject({ ok: false });
    if (!shell) return;
    const checked = join(scratch, 'install-plugins-check.sh');
    await writeFile(checked, result.stdout);
    expect(spawnSync(shell, ['-n', checked], { encoding: 'utf8' }).status).toBe(0);

    // The function itself against a scratch plugins directory, with curl answering from the local archives.
    const fn = result.stdout.slice(result.stdout.indexOf('install_plugin() {'), result.stdout.indexOf('\n}\n', result.stdout.indexOf('install_plugin() {')) + 3);
    const root = `${work}/root`;
    const install = async (archive: 'good' | 'link' | 'dotdot', sum: string) => {
      const script = [
        'set -eu',
        "fail() { printf 'bcd install: %s\\n' \"$1\" >&2; exit 1; }",
        'command -v chmod >/dev/null 2>&1 || chmod() { :; }',
        `curl() { while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out=$2; shift; fi; shift; done; cp '${work}/${archive}.tar.gz' "$out"; }`,
        // A path node understands too (the sha256sum stand-in on Windows), fresh per run.
        `TMP='${work}/tmp-${archive}-${Math.random().toString(36).slice(2)}'; mkdir "$TMP"; DOWNLOADS=https://compute.test/api/compute/downloads; BCD_VERSION=0.1.0; ARCH=amd64`,
        `mkdir -p '${root}/usr/local/lib/bcd/plugins'`,
        fn.split('/usr/local/lib/bcd/plugins').join(`${root}/usr/local/lib/bcd/plugins`),
        `install_plugin bcx-ipmi '${sum}'`,
      ].join('\n');
      await writeFile(join(work, 'install.sh'), script);
      return spawnSync(shell, [join(work, 'install.sh')], { encoding: 'utf8', env: shellEnv });
    };
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    // An operator's own pin line stays; the plugin's line is replaced, never duplicated.
    await mkdir(`${root}/usr/local/lib/bcd/plugins`, { recursive: true });
    await writeFile(`${root}/usr/local/lib/bcd/plugins/pins`, `${'ab'.repeat(32)}  bcx-other\n${'cd'.repeat(32)}  bcx-ipmi\n`);
    let run1 = await install('good', sha(archives.good));
    expect(run1.stderr).toBe('');
    expect(run1.status).toBe(0);
    const binary = await readFile(`${root}/usr/local/lib/bcd/plugins/bcx-ipmi`);
    expect(new TextDecoder().decode(binary)).toBe('the bcx-ipmi binary');
    const pinned = `${sha(binary)}  bcx-ipmi`;
    run1 = await install('good', sha(archives.good));
    expect(run1.status).toBe(0);
    expect(await readFile(`${root}/usr/local/lib/bcd/plugins/pins`, 'utf8')).toBe(`${'ab'.repeat(32)}  bcx-other\n${pinned}\n`);
    // Only the plugin's member: the README stayed in the archive.
    await expect(stat(`${root}/usr/local/lib/bcd/plugins/README.md`)).rejects.toThrow();
    const refused = async (archive: 'good' | 'link' | 'dotdot', sum: string, why: RegExp) => {
      const outcome = await install(archive, sum);
      expect(outcome.status).not.toBe(0);
      expect(outcome.stderr).toMatch(why);
    };
    await refused('good', 'ef'.repeat(32), /does not match its pinned SHA-256/);
    if (archives.link.length) await refused('link', sha(archives.link), /not a regular file/);
    await refused('dotdot', sha(archives.dotdot), /paths outside/);
    // The refused installs left the good plugin and its pin in place.
    expect(await readFile(`${root}/usr/local/lib/bcd/plugins/pins`, 'utf8')).toContain(pinned);
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

  it('configures the WebSocket fallback, with the proxy CA written beside the config', async () => {
    // (Only its form is checked here: PEM certificate blocks and nothing else.)
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2E=\n-----END CERTIFICATE-----\n';
    await writeFile(join(scratch, 'ws-ca.pem'), pem);
    const script = (
      await run([...base, '--websocket-url', 'wss://gw.eu.compute.test:443/v1/session', '--websocket-audience', 'gw.eu.compute.test', '--proxy-ca-file', 'ws-ca.pem'])
    ).stdout;
    expect(script).toContain(
      '[websocket]\nurl = "wss://gw.eu.compute.test:443/v1/session"\nproxy_ca_file = "/etc/bcd/websocket-proxy-ca.pem"\naudience = "gw.eu.compute.test"\n',
    );
    expect(script).toContain(`cat > /etc/bcd/websocket-proxy-ca.pem.new <<'BCD_PROXY_CA'\n${pem}BCD_PROXY_CA`);
    const shell = posixShell();
    if (shell) {
      const file = join(scratch, 'install-ws-check.sh');
      await writeFile(file, script);
      expect(spawnSync(shell, ['-n', file], { encoding: 'utf8' }).status).toBe(0);
    }
    expect(await run([...base, '--websocket-url', 'https://gw/v1/session'])).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    await writeFile(join(scratch, 'not-ca.pem'), `${pem}BCD_PROXY_CA\nrm -rf /\n`);
    expect(await run([...base, '--websocket-url', 'wss://gw/v1/session', '--proxy-ca-file', 'not-ca.pem'])).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await run([...base, '--proxy-ca-file', 'ws-ca.pem'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });

  it('writes a site agent’s BMC networks ([site] bmc_networks) with --bmc-networks', async () => {
    const script = (await run([...base, '--bmc-networks', '10.20.0.0/16, fd00:bmc::/64'.replace('bmc', 'b0c')])).stdout;
    expect(script).toContain('[site]\nbmc_networks = "10.20.0.0/16,fd00:b0c::/64"\n');
    expect((await run(base)).stdout).not.toContain('[site]');
    for (const bad of ['10.20.0.0', '10.20.0.0/33', '"; rm -rf /', ','])
      expect(await run([...base, '--bmc-networks', bad]), bad).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await run([...base, '--bmc-networks', ''])).toMatchObject({ ok: false });
  });

  it('pins the deployment’s approver set in config.toml with --approver-set-sha256', async () => {
    const digest = 'ab'.repeat(32);
    const script = (await run([...base, '--approver-set-sha256', digest])).stdout;
    const config = script.split("<<'BCD_CONFIG'\n")[1]!.split('BCD_CONFIG\n')[0]!;
    expect(config).toContain(`approver_set_sha256 = "${digest}"`);
    expect(await run([...base, '--approver-set-sha256', 'AB'.repeat(32)])).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await run([...base, '--approver-set-sha256', '"; rm -rf /'])).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('pins the command-signing roots for bcd helper’s host units with --command-root-sha256', async () => {
    const config = (script: string) => script.split("<<'BCD_CONFIG'\n")[1]!.split('BCD_CONFIG\n')[0]!;
    const [a, b] = ['ab'.repeat(32), 'cd'.repeat(32)];
    expect(config((await run([...base, '--command-root-sha256', `${a}, ${b},${a}`])).stdout)).toContain(
      `command_root_sha256 = "${a},${b}"`,
    );
    for (const bad of ['AB'.repeat(32), '"; rm -rf /', ',', a.slice(2)])
      expect(await run([...base, '--command-root-sha256', bad]), bad).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    // Without the flag: the bundle's own signing root when it has command signing, and the upgrade keeps a pin.
    const plain = (await run(base)).stdout;
    const own = readPkiPins(await readFile(join(scratch, '.better-compute', 'pki.json'), 'utf8')).commandSigningRootSha256;
    if (own) expect(config(plain)).toContain(`command_root_sha256 = "${own}`);
    else {
      expect(config(plain)).not.toContain('command_root_sha256');
      expect(plain).toContain("/^[[:space:]]*command_root_sha256[[:space:]]*=/p");
    }
  });

  it('writes [helper] instance_bridges with --unprivileged --instance-bridges', async () => {
    const result = await run([...base, '--unprivileged', '--instance-bridges', 'br0, br-priv,br0']);
    expect(result, JSON.stringify(result).slice(0, 400)).toMatchObject({ ok: true });
    const script = result.stdout;
    expect(script).toContain(`sed -i '/^[[:space:]]*\\[[[:space:]]*helper[[:space:]]*\\]/a instance_bridges = "br0,br-priv"'`);
    expect((await run([...base, '--unprivileged'])).stdout).not.toContain('instance_bridges');
    expect(await run([...base, '--instance-bridges', 'br0'])).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    for (const bad of ['br0;rm', 'a-bridge-name-too-long', ','])
      expect(await run([...base, '--unprivileged', '--instance-bridges', bad]), bad).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('joins with the host TPM with --attestor tpm: no token read, bcd join --attestor tpm, the units restarted', async () => {
    const result = await run([...base, '--attestor', 'tpm', '--unprivileged']);
    expect(result, JSON.stringify(result).slice(0, 400)).toMatchObject({ ok: true });
    const script = result.stdout;
    expect(script).toContain('/usr/local/bin/bcd join --config /etc/bcd/config.toml --attestor tpm < /dev/null');
    expect(script).toContain("[ -e /dev/tpmrm0 ] || fail 'this node joins with its TPM");
    expect(script).not.toContain('read -r TOKEN');
    expect(script).not.toContain('printf \'%s\\n\' "$TOKEN"');
    // bcd node (the bcd user) opens the TPM its node key lives in through the tss group.
    expect(script).toContain('usermod -a -G tss bcd');
    expect(script).toContain(`KERNEL=="tpmrm[0-9]*", GROUP="tss", MODE="0660"`);
    // bcd join is run before the units start again, and the helper before the node.
    const joined = script.indexOf('--attestor tpm < /dev/null');
    expect(script.indexOf('systemctl restart bcd-helper.service', joined)).toBeLessThan(script.indexOf('systemctl restart bcd.service', joined));
    expect(await run([...base, '--attestor', 'join-token'])).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    // Without the flag, the token flow is unchanged.
    expect((await run(base)).stdout).toContain('IFS= read -r TOKEN');
    const shell = posixShell();
    if (!shell) return;
    const checked = join(await mkdtemp(join(tmpdir(), 'bc-install-tpm-')), 'install-tpm-check.sh');
    await writeFile(checked, script);
    expect(spawnSync(shell, ['-n', checked], { encoding: 'utf8' }).status).toBe(0);
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
    expect(node.dropIn).toContain('CAP_IPC_LOCK');
    expect(node.dropIn).toContain('RestrictAddressFamilies=AF_VSOCK');
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
    expect(node.dropIn).not.toContain('CAP_IPC_LOCK');
    // An operator's section written with spaces is the same table: no second [plugins], and its privileged plugin counts.
    await writeFile(`${root}/etc/bcd/config.toml`, `${node.config.replace(/\[plugins\][^[]*/, '')}  [ plugins ]\n  privileged = "kata"\n`);
    node = await apply(['--plugins']);
    expect(node.config.match(/^\s*\[\s*plugins\s*\]/gm)).toHaveLength(1);
    expect(node.dropIn).toContain('RestrictNamespaces=no');
    // An upgrade without --approver-set-sha256 keeps the node's pin; an indented section survives too.
    const pin = 'cd'.repeat(32);
    node = await apply(['--approver-set-sha256', pin]);
    expect(node.config).toContain(`approver_set_sha256 = "${pin}"`);
    await writeFile(`${root}/etc/bcd/config.toml`, `${node.config}  [site]\n  bmc_networks = "10.9.0.0/16"\n`);
    node = await apply([]);
    expect(node.config.match(/approver_set_sha256 = /g)).toHaveLength(1);
    expect(node.config).toContain(`approver_set_sha256 = "${pin}"`);
    expect(node.config).toContain('  [site]\n  bmc_networks = "10.9.0.0/16"');
    expect(await run([...base, '--privileged-plugins', 'kata;rm'])).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('runs bcd node unprivileged beside a root bcd helper with --unprivileged, and keeps the mode on upgrade', async () => {
    const shell = posixShell();
    if (!shell) return;
    const root = (await mkdtemp(join(tmpdir(), 'bc-install-helper-'))).replace(/\\/g, '/');
    const calls = `${root}/calls`;
    // The config and unit steps against a scratch root; the account commands only record what they would do.
    const apply = async (extra: string[], { account = false, libvirt = false } = {}) => {
      const script = (await run([...base, ...extra])).stdout;
      const block = script
        .slice(script.indexOf("cat > /etc/bcd/config.toml.new"), script.indexOf('systemctl daemon-reload'))
        .split('/etc/')
        .join(`${root}/etc/`)
        .split('/usr/local/lib/')
        .join(`${root}/usr/local/lib/`);
      const file = join(scratch, 'helper-check.sh');
      const shims = [
        'command -v chmod >/dev/null 2>&1 || chmod() { :; }',
        'command -v install >/dev/null 2>&1 || install() { [ "$1" = -d ] || return 1; shift; [ "$1" = -m ] && shift 2; mkdir -p "$@"; }',
        `id() { ${account ? 'return 0' : 'return 1'}; }`,
        `getent() { ${libvirt ? 'return 0' : 'return 1'}; }`,
        `useradd() { echo "useradd $*" >> ${calls}; }`,
        `usermod() { echo "usermod $*" >> ${calls}; }`,
        `systemctl() { echo "systemctl $*" >> ${calls}; }`,
        `chgrp() { echo "chgrp $*" >> ${calls}; }`,
      ].join('\n');
      await writeFile(file, `set -eu\n${shims}\n: > ${calls}\nmkdir -p ${root}/etc/bcd ${root}/etc/systemd/system\n${block}`);
      const result = spawnSync(shell, [file], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dirname(shell)}${delimiter}${process.env.PATH ?? ''}` },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const read = async (path: string) => readFile(`${root}${path}`, 'utf8').catch(() => undefined);
      return {
        script,
        config: (await read('/etc/bcd/config.toml'))!,
        helperUnit: await read('/etc/systemd/system/bcd-helper.service'),
        dropIn: await read('/etc/systemd/system/bcd.service.d/unprivileged.conf'),
        calls: (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean),
      };
    };
    // By default bcd node stays root: no section, no helper, nothing to create.
    let node = await apply([]);
    expect(node.config).not.toContain('[helper]');
    expect(node.dropIn).toBeUndefined();
    expect(node.calls).toEqual([]);
    // --unprivileged: the section, the account, the helper unit and the node's drop-in.
    node = await apply(['--unprivileged']);
    expect(node.config).toContain('[helper]\nsocket = "/run/bcd-helper/helper.sock"\nuser = "bcd"\n');
    expect(node.calls).toEqual([
      'useradd --system --no-create-home --home-dir /var/lib/bcd --shell /usr/sbin/nologin bcd',
      `chgrp bcd ${root}/etc/bcd ${root}/etc/bcd/config.toml`,
    ]);
    expect(node.helperUnit).toContain(`ExecStart=/usr/local/bin/bcd helper --config ${root}/etc/bcd/config.toml`);
    expect(node.helperUnit).toContain('Before=bcd.service');
    // The helper's socket is in a directory only root writes (root chmods and chowns it by path).
    expect(node.helperUnit).toContain('RuntimeDirectory=bcd-helper');
    expect(node.dropIn).toContain('User=bcd\nGroup=bcd\nSupplementaryGroups=systemd-journal adm\n');
    expect(node.dropIn).toContain('Requires=bcd-helper.service');
    expect(node.dropIn).not.toContain('libvirt');
    // The helper's self-update slots: root's, 0755 (bcd node runs what the entrypoint links to there).
    expect(node.script).toContain('install -d -m 0755 /usr/local/lib/bcd\n  chmod 0755 /usr/local/lib/bcd');
    expect((await stat(`${root}/usr/local/lib/bcd`)).isDirectory()).toBe(true);
    // The first start: the identity bcd join wrote belongs to bcd, and the helper starts before the node.
    const start = node.script.slice(node.script.indexOf('bcd join --config'));
    expect(start.indexOf('chown -R bcd:bcd /var/lib/bcd')).toBeGreaterThan(0);
    expect(start.indexOf('systemctl enable --now bcd-helper.service')).toBeLessThan(start.indexOf('systemctl enable --now bcd.service'));
    // An upgrade without the flag keeps the node unprivileged (one [helper]); an existing account is reused. On a VPS
    // host bcd node is never in libvirt's group (bcd helper runs libvirt): qemu reaches its files through the bcd
    // group, and libvirt chowns nothing.
    await mkdir(`${root}/etc/libvirt`, { recursive: true });
    await writeFile(`${root}/etc/libvirt/qemu.conf`, 'user = "libvirt-qemu"\n#dynamic_ownership = 1\n');
    node = await apply([], { account: true, libvirt: true });
    expect(node.config.match(/^\s*\[\s*helper\s*\]/gm)).toHaveLength(1);
    expect(node.calls.some((c) => c.startsWith('useradd'))).toBe(false);
    expect(node.dropIn).not.toContain('libvirt');
    expect(await readFile(`${root}/etc/libvirt/qemu.conf`, 'utf8')).toBe('user = "libvirt-qemu"\ndynamic_ownership = 0\n');
    expect(node.calls).toEqual(expect.arrayContaining(['usermod -a -G bcd libvirt-qemu']));
    node = await apply(['--unprivileged'], { account: true });
    expect(node.config.match(/^\s*\[\s*helper\s*\]/gm)).toHaveLength(1);
    // The operator removes [helper]: the next run removes the drop-in and bcd node is root again.
    await writeFile(`${root}/etc/bcd/config.toml`, node.config.replace(/\[helper\][^[]*/, ''));
    node = await apply([]);
    expect(node.dropIn).toBeUndefined();
    // bcd node cannot start plugins without root.
    expect(await run([...base, '--unprivileged', '--plugins'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
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
