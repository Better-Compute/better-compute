import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCertificate, spkiPin } from '@better-compute/pki';
import { instanceStatusHandler, setIpPool, vps } from '@better-compute/vps';
import { createDevStack, type DevStack } from '@better-compute/testing';

// The Go daemon as a VPS host (v0.3): bcd joins a vps-host pool, advertises its (fakehw) libvirt-kvm
// runtime, and runs the instance the control plane places on it: the instances converger defines and
// starts it, StatusReport.instances reports it, and the vps module's status handler moves it to
// running; deleting it removes the domain from the host. Same WSL/Linux gating as bcd.test.ts.

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

const IMAGE = { url: 'https://images.example/base.qcow2', sha256: 'ab'.repeat(32), format: 'qcow2' as const, verified: true };

let dev: DevStack;
let api: any;
let poolId: string;
let configDir: string;
let config: string;
let dataDir: string;
let nodeId: string;
let node: ChildProcess | undefined;
let nodeLog = '';

describe.skipIf(!enabled)('bcd as a VPS host (v0.3)', () => {
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
    dev = await createDevStack({
      externalTls: { host: '0.0.0.0' },
      modules: [vps({ images: { resolve: async () => IMAGE }, hostSyncEvery: '1s' })],
      reports: { status: instanceStatusHandler({ log: () => {} }) },
    });
    api = dev.compute.api;
    const site = await api.sites.create(dev.root, { tenantId: dev.rootTenantId, kind: 'shared', region: 'dev-1', idempotencyKey: 'bcd-vps-site' });
    const pool = await api.pools.create(dev.root, {
      tenantId: dev.rootTenantId,
      siteId: site.id,
      class: 'vps-host',
      policy: {},
      ownerQuota: { vcpu: 1_000, memoryGiB: 10_000, diskGiB: 100_000 },
      idempotencyKey: 'bcd-vps-pool',
    });
    poolId = pool.id;
    await setIpPool(dev.database, { poolId, cidr: '10.77.0.0/24', gateway: '10.77.0.1' });
    await api.flavors.create(dev.root, { tenantId: dev.rootTenantId, poolId, name: 's', vcpu: 2, memoryGiB: 4, diskGiB: 40 });
    const token = (
      await api.joinTokens.create(dev.root, { tenantId: dev.rootTenantId, poolId, ttlSeconds: 3600, maxUses: 1, idempotencyKey: `bcd-vps-${Date.now()}` })
    ).token;

    const url = new URL(dev.externalGatewayUrl!);
    url.hostname = host;
    configDir = mkdtempSync(join(tmpdir(), 'bcd-vps-'));
    config = join(configDir, 'config.toml');
    dataDir = `/tmp/bcd-vps-${randomBytes(6).toString('hex')}`;
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
        '[log]',
        'level = "debug"',
        'json = false',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(join(configDir, 'join-encryption.jwk'), JSON.stringify(dev.pins.joinEncryptionJwk));
    const joined = await runLinux(['env', 'BCD_FAKEHW_SEED=77', toLinux(binary), 'join', '--config', toLinux(config)], `${token}\n`);
    if (joined.status !== 0) throw new Error(`bcd join: ${joined.stderr}`);
    nodeId = /joined as (\S+)/.exec(joined.stdout)?.[1] ?? '';
    const { cmd, args } = linux(['env', 'BCD_FAKEHW_SEED=77', toLinux(binary), 'node', '--config', toLinux(config)]);
    node = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    node.stderr!.on('data', (chunk: Buffer) => {
      nodeLog += chunk.toString();
      if (process.env.BCD_E2E_LOG) process.stderr.write(chunk);
    });
    await dev.waitFor([nodeId], { timeoutMs: 120_000 }).catch((error) => {
      throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-4000)}`);
    });
    await until('host capacity', async () => {
      const { rows } = await dev.database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM node_resources WHERE node_id = $1 AND resource = 'vcpu'`,
        [nodeId],
      );
      return rows[0]!.count === 1;
    });
  }, 240_000);

  afterAll(async () => {
    if (config) sh(`pkill -f '${toLinux(config)}' ; true`);
    node?.kill();
    if (dataDir) sh(`rm -rf '${dataDir}'`);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    await dev?.close();
  }, 60_000);

  it('runs a placed instance and removes it when deleted', async () => {
    const instance = await api.instances.create(dev.root, {
      tenantId: dev.rootTenantId,
      poolId,
      flavor: 's',
      imageId: 'base',
      idempotencyKey: 'bcd-vps-web',
    });
    expect(instance.nodeId).toBe(nodeId);
    await until(
      `instance ${instance.id} running`,
      async () => (await api.instances.get(dev.root, { tenantId: dev.rootTenantId, instanceId: instance.id })).state === 'running',
      90_000,
    ).catch((error) => {
      throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-4000)}`);
    });
    const domains = JSON.parse(sh(`cat '${dataDir}/fakehw-runtime.json'`)).domains;
    expect(domains[instance.id]).toMatchObject({ managed: true, state: 'running', vcpu: 2 });

    await api.instances.delete(dev.root, { tenantId: dev.rootTenantId, instanceId: instance.id });
    await until(
      'the domain removed from the host',
      async () => !(instance.id in JSON.parse(sh(`cat '${dataDir}/fakehw-runtime.json'`)).domains),
      90_000,
    );
  }, 200_000);
});
