import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { parseCertificate, spkiPin } from '@better-compute/pki';
import { TunnelFrameSchema } from '@better-compute/protocol';
import { pkiAllocationBindingCheck } from '@better-compute/server';
import { createDevStack, type DevStack } from '@better-compute/testing';

// The real Go daemon (daemon/, W1) against the real control plane and gateway: `bcd join` with a
// sealed join token over the gateway's mTLS listener, then `bcd node` with its JoinService-issued
// certificate. The node is adopted after its node-signed diag.nvml, binds a reservation's GPUs with a
// node-signed AllocationBound (checked by pkiAllocationBindingCheck), and completes node.reboot as
// SUCCEEDED{rebooted} after its (fakehw) reboot. bcd is built for linux/amd64 with fakehw; on Windows it
// runs in WSL (opt in with BCD_E2E=1), on Linux when Go is installed.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const daemonDir = join(repo, 'daemon');
const binary = join(daemonDir, 'bin', 'bcd-linux-amd64');
const distro = process.env.BCD_WSL_DISTRO ?? 'Ubuntu';
const windows = process.platform === 'win32';

const goBinary = windows ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go';
const hasGo = spawnSync(goBinary, ['version'], { stdio: 'ignore' }).status === 0;
const hasWsl = windows && spawnSync('wsl.exe', ['-d', distro, '-e', 'true'], { stdio: 'ignore' }).status === 0;
const enabled = windows ? process.env.BCD_E2E === '1' && hasWsl && (hasGo || existsSync(binary)) : process.platform === 'linux' && hasGo;

const toLinux = (path: string) =>
  windows ? `/mnt/${path[0]!.toLowerCase()}${path.slice(2).split('\\').join('/')}` : path;
/** argv for a command on the Linux side. */
const linux = (args: string[]) => (windows ? { cmd: 'wsl.exe', args: ['-d', distro, '-e', ...args] } : { cmd: args[0]!, args: args.slice(1) });
function sh(script: string): string {
  const { cmd, args } = linux(['sh', '-c', script]);
  const run = spawnSync(cmd, args, { encoding: 'utf8' });
  return (run.stdout ?? '').trim();
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
let poolId: string;
let token: string;
let configDir: string;
let config: string;
let dataDir: string;
let nodeId: string;
let node: ChildProcess | undefined;
let nodeLog = '';

/**
 * Runs a Linux command to completion without blocking the event loop: the gateway it talks to runs in
 * this process (spawnSync would stall every handshake).
 */
function runLinux(argv: string[], input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { cmd, args } = linux(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

function startNode() {
  const { cmd, args } = linux(['env', 'BCD_FAKEHW_SEED=41', toLinux(binary), 'node', '--config', toLinux(config)]);
  node = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  node.stderr!.on('data', (chunk: Buffer) => {
    nodeLog += chunk.toString();
    if (process.env.BCD_E2E_LOG) process.stderr.write(chunk);
  });
}

const commandState = async (commandId: string) =>
  (await api.commands.get(dev.root, { tenantId: dev.rootTenantId, nodeId, commandId })).state as string;

describe.skipIf(!enabled)('bcd, the Go daemon, against the control plane (W1)', () => {
  beforeAll(async () => {
    if (hasGo) {
      const built = spawnSync(goBinary, ['build', '-tags', 'nonvml,fakehw', '-o', 'bin/bcd-linux-amd64', './cmd/bcd'], {
        cwd: daemonDir,
        env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
        encoding: 'utf8',
      });
      if (built.status !== 0) throw new Error(`go build failed: ${built.stderr}`);
    }
    // bcd in WSL reaches the Windows host at WSL's default gateway; the listener binds every address.
    const host = windows ? sh("ip route show default | awk '{print $3}'") : '127.0.0.1';
    if (!host) throw new Error('no route from WSL to the host');
    dev = await createDevStack({
      externalTls: { host: '0.0.0.0' },
      tunnels: {},
      capacity: { attestedBindings: pkiAllocationBindingCheck() },
    });
    api = dev.compute.api;
    ({ poolId } = await dev.createPool({ key: 'bcd', expectGpuCount: 8 }));
    token = (
      await api.joinTokens.create(dev.root, {
        tenantId: dev.rootTenantId,
        poolId,
        ttlSeconds: 3600,
        maxUses: 1,
        idempotencyKey: `bcd-e2e-${Date.now()}`,
      })
    ).token;
    await api.pools.offer(dev.root, { tenantId: dev.rootTenantId, poolId, toTenantId: dev.rootTenantId, quota: { gpu: 16 } });

    const url = new URL(dev.externalGatewayUrl!);
    url.hostname = host;
    configDir = mkdtempSync(join(tmpdir(), 'bcd-e2e-'));
    config = join(configDir, 'config.toml');
    dataDir = `/tmp/bcd-e2e-${randomBytes(6).toString('hex')}`;
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
  }, 180_000);

  afterAll(async () => {
    if (config) sh(`pkill -f '${toLinux(config)}' ; true`);
    node?.kill();
    if (dataDir) sh(`rm -rf '${dataDir}'`);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    await dev?.close();
  }, 60_000);

  it('joins with a sealed token, is adopted after its attested diag.nvml, and runs commands', async () => {
    const joined = await runLinux(['env', 'BCD_FAKEHW_SEED=41', toLinux(binary), 'join', '--config', toLinux(config)], `${token}\n`);
    expect(joined.status, joined.stderr).toBe(0);
    expect(joined.stdout + joined.stderr).not.toContain(token);
    nodeId = /joined as (\S+)/.exec(joined.stdout)?.[1] ?? '';
    expect(nodeId).toMatch(/^node_/);

    startNode();
    await dev.waitFor([nodeId], { timeoutMs: 120_000 }).catch((error) => {
      throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-4000)}`);
    });
    const { rows } = await dev.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commands WHERE node_id = $1 AND kind = 'diag.nvml' AND state = 'succeeded'`,
      [nodeId],
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);

    // bcd status answers on the agent's unix socket.
    const status = await runLinux([toLinux(binary), 'status', '--socket', `${dataDir}/bcd.sock`, '--json']);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ nodeId, connected: true, role: 'node' });

    const refresh = await api.commands.run(dev.root, {
      tenantId: dev.rootTenantId,
      nodeId,
      kind: 'inventory.refresh',
      payload: { sections: ['gpus'], rescan: true },
      idempotencyKey: 'bcd-e2e-refresh',
    });
    await until('inventory.refresh to succeed', async () => (await commandState(refresh.id)) === 'succeeded');
  }, 180_000);

  it('binds a reservation with a node-signed AllocationBound and releases it', async () => {
    const created = await api.reservations.create(dev.root, {
      tenantId: dev.rootTenantId,
      poolId,
      devices: [{ class: 'gpu', count: 2 }],
      duration: '1h',
      idempotencyKey: 'bcd-e2e-reserve',
    });
    const active = await until('the reservation to become active', async () => {
      const current = await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
      return current.state === 'active' ? current : undefined;
    });
    const { rows } = await dev.database.query<{ id: string; signed: boolean }>(
      `SELECT id, bound_sig IS NOT NULL AS signed FROM allocations WHERE owner_kind = 'reservation' AND owner_id = $1`,
      [created.id],
    );
    expect(rows[0]!.signed).toBe(true);
    const allocationId = rows[0]!.id;
    expect(active.binding.cdiDevices).toHaveLength(2);
    expect(sh(`cat '${dataDir}/fakehw-root/etc/cdi/bcd-${allocationId}.json'`)).toContain(allocationId);

    await api.reservations.release(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
    await until('the hold to be released on the node', async () =>
      sh(`test -e '${dataDir}/fakehw-root/etc/cdi/bcd-${allocationId}.json' && echo held || echo gone`) === 'gone',
    );
  }, 120_000);

  it('opens a console tunnel to a real shell on the node', async () => {
    const opened = await api.tunnels.open(dev.root, { tenantId: dev.rootTenantId, nodeId, op: 'console' });
    const request = { ticket: opened.ticket, nodeId, tunnelId: opened.tunnelId, gatewayId: dev.gateway.id };
    const tunnel = await dev.tunnelRelay!.open(request);
    let text = '';
    let closed: { exitCode: number } | undefined;
    const reading = (async () => {
      for await (const frame of tunnel.frames as AsyncIterable<any>) {
        if (frame.body.case === 'data') text += new TextDecoder().decode(frame.body.value);
        if (frame.body.case === 'closed') {
          closed = frame.body.value;
          break;
        }
      }
    })().catch(() => {});
    const type = (line: string) =>
      tunnel.send(create(TunnelFrameSchema, { tunnelId: opened.tunnelId, body: { case: 'data', value: new TextEncoder().encode(line) } }));
    type('echo hi-$((6*7))\n');
    await until('the shell to answer', async () => text.includes('hi-42'), 20_000);
    type('exit 5\n');
    await until('the shell to exit', async () => closed !== undefined, 20_000);
    expect(closed!.exitCode).toBe(5);
    tunnel.close();
    await reading;
  }, 90_000);

  it('reboots and reports SUCCEEDED{rebooted} from the next boot', async () => {
    const before = sh(`cat '${dataDir}/fakehw-boot-id'`);
    const reboot = await api.commands.run(dev.root, {
      tenantId: dev.rootTenantId,
      nodeId,
      kind: 'node.reboot',
      idempotencyKey: 'bcd-e2e-reboot',
    });
    await until('node.reboot to succeed', async () => (await commandState(reboot.id)) === 'succeeded', 90_000);
    const after = sh(`cat '${dataDir}/fakehw-boot-id'`);
    expect(after).not.toBe(before);
    const { rows } = await dev.database.query<{ boot_id: string }>(
      `SELECT boot_id FROM node_sessions WHERE node_id = $1`,
      [nodeId],
    );
    expect(rows[0]?.boot_id).toBe(after);
  }, 120_000);
});
