import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCertificate, spkiPin } from '@better-compute/pki';
import { provisionModule } from '@better-compute/provision';
import { createDevStack, type DevStack } from '@better-compute/testing';

// NodeSpec.host end to end (PLAN §3.8, §11.3): a pool's policy (hugepages, kernel modules) becomes
// provision's config units in the node's spec, the gateway sends it, and the Go daemon's host
// converger applies it: here a fakehw bcd under its fake root (<data_dir>/fakehw-root), where the
// test reads what it wrote. Same WSL/Linux gating as bcd.test.ts.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const daemonDir = join(repo, 'daemon');
const binary = join(daemonDir, 'bin', 'bcd-linux-amd64');
const distro = process.env.BCD_WSL_DISTRO ?? 'Ubuntu';
const windows = process.platform === 'win32';
const goBinary = windows ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go';
const hasGo = spawnSync(goBinary, ['version'], { stdio: 'ignore' }).status === 0;
const hasWsl = windows && spawnSync('wsl.exe', ['-d', distro, '-e', 'true'], { stdio: 'ignore' }).status === 0;
const enabled = windows ? process.env.BCD_E2E === '1' && hasWsl && (hasGo || existsSync(binary)) : process.platform === 'linux' && hasGo;

const toLinux = (path: string) => (windows ? `/mnt/${path[0]!.toLowerCase()}${path.slice(2).split('\\').join('/')}` : path);
const linux = (args: string[]) => (windows ? { cmd: 'wsl.exe', args: ['-d', distro, '-e', ...args] } : { cmd: args[0]!, args: args.slice(1) });
function sh(script: string): string {
  const { cmd, args } = linux(['sh', '-c', script]);
  return (spawnSync(cmd, args, { encoding: 'utf8' }).stdout ?? '').trim();
}
function runLinux(argv: string[], input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { cmd, args } = linux(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

let dev: DevStack;
let api: any;
let configDir: string;
let config: string;
let dataDir: string;
let nodeId: string;
let node: ChildProcess | undefined;
let nodeLog = '';

describe.skipIf(!enabled)('bcd host config units (NodeSpec.host)', () => {
  beforeAll(async () => {
    if (hasGo) {
      const built = spawnSync(goBinary, ['build', '-tags', 'nonvml,fakehw', '-o', 'bin/bcd-linux-amd64', './cmd/bcd'], {
        cwd: daemonDir,
        env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
        encoding: 'utf8',
      });
      if (built.status !== 0) throw new Error(`go build failed: ${built.stderr}`);
    }
    const host = windows ? sh("ip route show default | awk '{print $3}'") : '127.0.0.1';
    dev = await createDevStack({ externalTls: { host: '0.0.0.0' }, modules: [provisionModule()] });
    api = dev.compute.api;
    const site = await api.sites.create(dev.root, { tenantId: dev.rootTenantId, kind: 'shared', region: 'dev-1', idempotencyKey: 'bcd-host-site' });
    const pool = await api.pools.create(dev.root, {
      tenantId: dev.rootTenantId,
      siteId: site.id,
      class: 'metal-host',
      sharing: 'exclusive',
      policy: { hugepages: { size: '2Mi', count: 64 }, kernelModules: { load: ['vhost_net', 'tun'] } },
      idempotencyKey: 'bcd-host-pool',
    });
    const token = (
      await api.joinTokens.create(dev.root, { tenantId: dev.rootTenantId, poolId: pool.id, ttlSeconds: 3600, idempotencyKey: `bcd-host-${Date.now()}` })
    ).token;

    const url = new URL(dev.externalGatewayUrl!);
    url.hostname = host;
    configDir = mkdtempSync(join(tmpdir(), 'bcd-host-'));
    config = join(configDir, 'config.toml');
    dataDir = `/tmp/bcd-host-${randomBytes(6).toString('hex')}`;
    const pin = (der: Uint8Array) => spkiPin(parseCertificate(der).publicKey);
    writeFileSync(
      config,
      [
        `gateway_url = "${url.origin}"`,
        `gateway_server_name = "gw.dev.local"`,
        `site = "dev"`,
        `serving_ca_spki_pin = "${pin(dev.servingCaCertificate!)}"`,
        `join_signing_key_pin = "${spkiPin(createPublicKey({ key: dev.pins.joinSigningKey as any, format: 'jwk' }))}"`,
        `join_encryption_key_pin = "${spkiPin(createPublicKey({ key: dev.pins.joinEncryptionJwk as any, format: 'jwk' }))}"`,
        `data_dir = "${dataDir}"`,
        `socket_path = "${dataDir}/bcd.sock"`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(join(configDir, 'join-encryption.jwk'), JSON.stringify(dev.pins.joinEncryptionJwk));
    const joined = await runLinux(['env', 'BCD_FAKEHW_SEED=91', toLinux(binary), 'join', '--config', toLinux(config)], `${token}\n`);
    if (joined.status !== 0) throw new Error(`bcd join: ${joined.stderr}`);
    nodeId = /joined as (\S+)/.exec(joined.stdout)?.[1] ?? '';
    // The fake host's kernel: a 2 MiB hugepage pool of 0.
    sh(`mkdir -p '${dataDir}/fakehw-root/sys/kernel/mm/hugepages/hugepages-2048kB' && echo 0 > '${dataDir}/fakehw-root/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages'`);
    const { cmd, args } = linux(['env', 'BCD_FAKEHW_SEED=91', toLinux(binary), 'node', '--config', toLinux(config)]);
    node = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    node.stderr!.on('data', (chunk: Buffer) => {
      nodeLog += chunk.toString();
      if (process.env.BCD_E2E_LOG) process.stderr.write(chunk);
    });
    await dev.waitFor([nodeId], { timeoutMs: 120_000 }).catch((error) => {
      throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-4000)}`);
    });
  }, 240_000);

  afterAll(async () => {
    if (config) sh(`pkill -f '${toLinux(config)}' ; true`);
    node?.kill();
    if (dataDir) sh(`rm -rf '${dataDir}'`);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    await dev?.close();
  }, 60_000);

  it("applies the pool's hugepages and kernel modules to the host", async () => {
    const spec = (await dev.database.query<{ spec: any }>('SELECT spec FROM nodes WHERE id = $1', [nodeId])).rows[0]!.spec;
    const units = Object.fromEntries((spec.host?.units ?? []).map((u: any) => [u.unit, JSON.parse(u.configJson)]));
    expect(units).toMatchObject({ hugepages: { pages2m: 64 }, 'kernel-modules': { load: ['tun', 'vhost_net'] } });

    const root = `${dataDir}/fakehw-root`;
    await until(
      '64 hugepages on the host',
      async () => sh(`cat '${root}/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages'`) === '64',
      60_000,
    ).catch((error) => {
      throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-4000)}`);
    });
    expect(sh(`cat '${root}/etc/modules-load.d/bcd.conf'`)).toMatch(/\ntun\nvhost_net$/);
    // Under a fake root programs are recorded, not run.
    expect(sh(`cat '${root}/run/bcd/hostconfig-commands.log'`).split('\n')).toEqual(
      expect.arrayContaining(['modprobe -- tun', 'modprobe -- vhost_net']),
    );
  }, 120_000);
});
