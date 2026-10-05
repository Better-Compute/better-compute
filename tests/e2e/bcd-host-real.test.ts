import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCertificate, spkiPin } from '@better-compute/pki';
import { createDevStack, type DevStack } from '@better-compute/testing';

// The real daemon on the real host (Round 6): bcd built WITHOUT fakehw, so it reads this machine's
// procfs/sysfs, its GPUs and its cgroups, joins a dev stack over TLS 1.3 + mTLS as an unprivileged
// user, is adopted, reports what the host really is, and answers status and doctor. Opt in with
// BCD_E2E_REAL=1 (Linux, or Windows + WSL). It asserts only what holds on any Linux host and records
// the rest (GPUs, KVM) as facts in the log, so it runs on a laptop, WSL or a GPU server alike.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const daemonDir = join(repo, 'daemon');
const binary = join(daemonDir, 'bin', 'bcd-linux-amd64-host');
const distro = process.env.BCD_WSL_DISTRO ?? 'Ubuntu';
const windows = process.platform === 'win32';
const goBinary = windows ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go';
const hasGo = spawnSync(goBinary, ['version'], { stdio: 'ignore' }).status === 0;
const hasWsl = windows && spawnSync('wsl.exe', ['-d', distro, '-e', 'true'], { stdio: 'ignore' }).status === 0;
const enabled =
  process.env.BCD_E2E_REAL === '1' &&
  (windows ? hasWsl && (hasGo || existsSync(binary)) : process.platform === 'linux' && hasGo);

const toLinux = (path: string) =>
  windows ? `/mnt/${path[0]!.toLowerCase()}${path.slice(2).split('\\').join('/')}` : path;
const linux = (args: string[]) =>
  windows ? { cmd: 'wsl.exe', args: ['-d', distro, '-e', ...args] } : { cmd: args[0]!, args: args.slice(1) };
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

let dev: DevStack;
let api: any;
let poolId: string;
let configDir: string;
let config: string;
let dataDir: string;
let nodeId: string;
let node: ChildProcess | undefined;
let nodeLog = '';

describe.skipIf(!enabled)('bcd on the real host (non-fakehw build)', () => {
  beforeAll(async () => {
    if (hasGo) {
      const built = spawnSync(goBinary, ['build', '-tags', 'nonvml', '-o', 'bin/bcd-linux-amd64-host', './cmd/bcd'], {
        cwd: daemonDir,
        env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
        encoding: 'utf8',
      });
      if (built.status !== 0) throw new Error(`go build failed: ${built.stderr}`);
    }
    const host = windows ? sh("ip route show default | awk '{print $3}'") : '127.0.0.1';
    if (!host) throw new Error('no route from WSL to the host');
    dev = await createDevStack({ externalTls: { host: '0.0.0.0' } });
    api = dev.compute.api;
    ({ poolId } = await dev.createPool({ key: 'real-host', gpuModel: null }));
    // A host without DMI identity (WSL, many VMs: no product UUID or serial) has no trusted hardware key,
    // and JoinService refuses it unless the token is bound to an identifier it does have: its MAC.
    const dmi = sh('cat /sys/class/dmi/id/product_uuid 2>/dev/null');
    const mac = sh("cat /sys/class/net/$(ip route show default | awk '{print $5; exit}')/address");
    const token = (
      await api.joinTokens.create(dev.root, {
        tenantId: dev.rootTenantId,
        poolId,
        ttlSeconds: 3600,
        maxUses: 1,
        ...(dmi ? {} : { expect: { mac } }),
        idempotencyKey: `bcd-real-${Date.now()}`,
      })
    ).token;
    const url = new URL(dev.externalGatewayUrl!);
    url.hostname = host;
    configDir = mkdtempSync(join(tmpdir(), 'bcd-real-'));
    config = join(configDir, 'config.toml');
    dataDir = `/tmp/bcd-real-${randomBytes(6).toString('hex')}`;
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
    const joined = await runLinux([toLinux(binary), 'join', '--config', toLinux(config)], `${token}\n`);
    if (joined.status !== 0) throw new Error(`bcd join failed:\n${joined.stdout}\n${joined.stderr}`);
    nodeId = /joined as (\S+)/.exec(joined.stdout)?.[1] ?? '';
  }, 300_000);

  afterAll(async () => {
    if (config) sh(`pkill -f '${toLinux(config)}' ; true`);
    node?.kill();
    if (process.env.BCD_E2E_LOG) process.stderr.write(nodeLog);
    if (dataDir) sh(`rm -rf '${dataDir}'`);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    await dev?.close();
  }, 60_000);

  it('joins, is adopted and reports the real host', async () => {
    expect(nodeId).toMatch(/^node_/);
    const { cmd, args } = linux([toLinux(binary), 'node', '--config', toLinux(config)]);
    node = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    node.stderr!.on('data', (chunk: Buffer) => (nodeLog += chunk.toString()));
    await dev.waitFor([nodeId], { timeoutMs: 180_000 }).catch((error) => {
      throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-6000)}`);
    });

    // What the kernel says about this machine, and what bcd reported.
    const cpus = Number(sh('nproc --all'));
    const memKiB = Number(sh("awk '/MemTotal/ {print $2}' /proc/meminfo"));
    const inventory = await api.inventory.get(dev.root, { tenantId: dev.rootTenantId, nodeId });
    const text = JSON.stringify(inventory);
    expect(text).toContain(sh('uname -r'));
    const reportedCpus = JSON.stringify(inventory).match(/"(?:logicalCpus|threads|cpuCount)":(\d+)/)?.[1];
    if (reportedCpus) expect(Number(reportedCpus)).toBe(cpus);
    const reportedMem = text.match(/"(?:totalBytes|memoryBytes)":"?(\d+)/)?.[1];
    if (reportedMem) expect(Math.abs(Number(reportedMem) / 1024 - memKiB) / memKiB).toBeLessThan(0.05);
    process.stderr.write(
      `[real host] ${cpus} CPUs, ${Math.round(memKiB / 1048576)} GiB; GPUs in inventory: ${(text.match(/"uuid":"GPU-/g) ?? []).length}\n`,
    );
  }, 300_000);

  it('binds and releases a reservation of the real GPU', async (context) => {
    const inventory = JSON.stringify(
      await api.inventory.get(dev.root, { tenantId: dev.rootTenantId, nodeId }),
    );
    if (!/"uuid":"GPU-/.test(inventory)) return context.skip();
    // A GPU the control plane's model table does not know (consumer cards, new SKUs) is NoSchedule
    // GpuModelUnknown: nothing places on it, so say so instead of waiting for a placement.
    const info = await api.nodes.get(dev.root, { tenantId: dev.rootTenantId, nodeId });
    const unknown = (info.conditions ?? []).find(
      (c: { type: string; status: string }) => c.type === 'GpuModelUnknown' && c.status === 'true',
    );
    if (unknown) {
      process.stderr.write(`[real host] GPU not schedulable: ${unknown.message ?? 'GpuModelUnknown'}\n`);
      return context.skip();
    }
    await api.pools.offer(dev.root, {
      tenantId: dev.rootTenantId,
      poolId,
      toTenantId: dev.rootTenantId,
      quota: { gpu: 8 },
    });
    // bcd runs here as an ordinary user without [helper] (no sudo in CI or this WSL box): it cannot
    // write /etc/cdi or create hold slices, so it must not claim it can, and nothing may bind on it.
    const unprivileged = sh('id -u') !== '0';
    const hasCap = (info.labels ?? []).some((l: { key: string }) => l.key === 'bc.dev/cap.devices.limits');
    if (unprivileged) {
      expect(hasCap, 'an unprivileged bcd advertised devices.limits').toBe(false);
      const pending = await api.reservations.create(dev.root, {
        tenantId: dev.rootTenantId,
        poolId,
        devices: [{ class: 'gpu', count: 1 }],
        duration: '1h',
        idempotencyKey: `bcd-real-unprivileged-${Date.now()}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const after = await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId: pending.id });
      process.stderr.write(`[real host] unprivileged bcd: reservation stays ${after.state} (no node may enforce it)\n`);
      expect(after.state).not.toBe('binding');
      expect(after.state).not.toBe('active');
      await api.reservations.cancel?.(dev.root, { tenantId: dev.rootTenantId, reservationId: pending.id }).catch(() => {});
      return;
    }
    const created = await api.reservations.create(dev.root, {
      tenantId: dev.rootTenantId,
      poolId,
      devices: [{ class: 'gpu', count: 1 }],
      duration: '1h',
      idempotencyKey: `bcd-real-reserve-${Date.now()}`,
    });
    const deadline = Date.now() + 120_000;
    let current: any;
    for (;;) {
      current = await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
      if (current.state === 'active' || current.state === 'failed' || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.stderr.write(`[real host] reservation ${created.id}: ${current.state} ${current.reason ?? ''}\n`);
    expect(current.state, `${JSON.stringify(current)}\n--- bcd log ---\n${nodeLog.slice(-4000)}`).toBe('active');
    const files = sh(`find '${dataDir}' /etc/cdi -name 'bcd-*.json' 2>/dev/null`);
    process.stderr.write(`[real host] CDI holds: ${files || '(none)'}\n`);
    await api.reservations.release(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
  }, 240_000);

  it('answers status on its socket and doctor about the host', async () => {
    const status = await runLinux([toLinux(binary), 'status', '--socket', `${dataDir}/bcd.sock`, '--json']);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ nodeId, connected: true, role: 'node' });
    const doctor = await runLinux([toLinux(binary), 'doctor', '--config', toLinux(config)]);
    process.stderr.write(`[real host] doctor exit ${doctor.status}\n${doctor.stdout}${doctor.stderr}\n`);
    // Doctor's verdict depends on the host (KVM group, IOMMU); it must run and say something.
    expect(doctor.stdout + doctor.stderr).not.toBe('');
  }, 120_000);
});
