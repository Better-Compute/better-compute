import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  buildReleaseManifest,
  createReleaseSigningKey,
  parseCertificate,
  releaseArtifact,
  signReleaseManifest,
  spkiPin,
} from '@better-compute/pki';
import { TunnelFrameSchema } from '@better-compute/protocol';
import { pkiAllocationBindingCheck } from '@better-compute/server';
import { rolloutModule } from '@better-compute/rollout';
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

// The release key self-update trusts (its pin goes into the node's [update] config).
const releaseKey = createReleaseSigningKey();

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

function startNode(exe = toLinux(binary)) {
  const { cmd, args } = linux(['env', 'BCD_FAKEHW_SEED=41', exe, 'node', '--config', toLinux(config)]);
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
      // daemon.upgrade is the rollout module's kind.
      modules: [rolloutModule({ release: { pins: [spkiPin(releaseKey.publicKey)] }, downloadsUrl: 'https://downloads.invalid' })],
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

  it('bootstraps an OS provisioned with only a token, the control plane URL and the pins', async () => {
    // What provision's user data and the Robot bootstrap run: no config.toml, no join key file. bcd
    // reads the gateway from the control plane's well-known document (the server's own join keys,
    // plus where its gateway is), checks it against the pins on its command line, joins and writes
    // its configuration.
    const host = new URL(config ? readFileSync(config, 'utf8').match(/gateway_url = "([^"]+)"/)![1]! : '').hostname;
    const { basePath, origin } = dev.compute.endpoint;
    const published = await (await dev.compute.handler(new Request(`${origin}${basePath}/.well-known/better-compute`))).json();
    const pin = (der: Uint8Array) => spkiPin(parseCertificate(der).publicKey);
    const gatewayUrl = new URL(dev.externalGatewayUrl!);
    gatewayUrl.hostname = host;
    const wellKnown = createServer((req, res) => {
      if (req.url !== `${basePath}/.well-known/better-compute`) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ ...published, gateway: { url: gatewayUrl.origin, serverName: 'gw.dev.local', servingCaPin: pin(dev.servingCaCertificate!) } }),
      );
    });
    await new Promise<void>((resolve) => wellKnown.listen(0, '0.0.0.0', resolve));
    const port = (wellKnown.address() as AddressInfo).port;
    const root = `/tmp/bcd-e2e-boot-${randomBytes(6).toString('hex')}`;
    const provisioned = (
      await api.joinTokens.create(dev.root, {
        tenantId: dev.rootTenantId,
        poolId,
        ttlSeconds: 3600,
        maxUses: 1,
        idempotencyKey: `bcd-e2e-boot-${Date.now()}`,
      })
    ).token;
    let second: ChildProcess | undefined;
    try {
      // The token arrives as a root-only file (user data, or the Robot post-install script).
      const written = await runLinux(['sh', '-c', `mkdir -p ${root} && umask 077 && cat > ${root}/join-token`], provisioned);
      expect(written.status, written.stderr).toBe(0);
      const join = () =>
        runLinux([
          'env', 'BCD_FAKEHW_SEED=43', toLinux(binary), 'join',
          '--config', `${root}/etc/bcd/config.toml`,
          '--server', `http://${host}:${port}${basePath}`,
          '--token-file', `${root}/join-token`,
          '--serving-ca-pin', pin(dev.servingCaCertificate!),
          '--join-signing-pin', spkiPin(createPublicKey({ key: dev.pins.joinSigningKey as any, format: 'jwk' })),
          '--join-encryption-pin', spkiPin(createPublicKey({ key: dev.pins.joinEncryptionJwk as any, format: 'jwk' })),
          '--data-dir', `${root}/data`,
        ]);
      const joined = await join();
      expect(joined.status, joined.stderr).toBe(0);
      const bootNode = /joined as (\S+)/.exec(joined.stdout)?.[1] ?? '';
      expect(bootNode).toMatch(/^node_/);
      expect(sh(`test -e ${root}/join-token && echo kept || echo gone`)).toBe('gone');
      const installed = sh(`cat ${root}/etc/bcd/config.toml`);
      expect(installed).toContain(`gateway_url = "${gatewayUrl.origin}"`);
      expect(installed).toContain('gateway_server_name = "gw.dev.local"');
      expect(sh(`cat ${root}/etc/bcd/join-encryption.jwk`)).toContain(dev.pins.joinEncryptionJwk.x as string);
      // A re-run (the join unit on the next boot) succeeds without a token.
      const again = await join();
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toContain(`already joined as ${bootNode}`);

      // The node agent runs on the written configuration alone.
      const { cmd, args } = linux(['env', 'BCD_FAKEHW_SEED=43', toLinux(binary), 'node', '--config', `${root}/etc/bcd/config.toml`]);
      let log = '';
      second = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      second.stderr!.on('data', (chunk: Buffer) => (log += chunk.toString()));
      await dev.waitFor([bootNode], { timeoutMs: 120_000 }).catch((error) => {
        throw new Error(`${error}\n--- bcd log ---\n${log.slice(-4000)}`);
      });
    } finally {
      sh(`pkill -f '${root}/etc/bcd/config.toml' ; true`);
      second?.kill();
      sh(`rm -rf '${root}'`);
      wellKnown.close();
    }
  }, 240_000);

  it('runs many real daemons in one process (bcd sim)', async () => {
    const simData = `/tmp/bcd-e2e-sim-${randomBytes(6).toString('hex')}`;
    const simConfig = join(configDir, 'sim.toml');
    writeFileSync(
      simConfig,
      readFileSync(config, 'utf8')
        .replace(/^data_dir = .*$/m, `data_dir = "${simData}"`)
        .replace(/^socket_path = .*$/m, `socket_path = "${simData}/bcd.sock"`),
      { mode: 0o600 },
    );
    const simToken = (
      await api.joinTokens.create(dev.root, {
        tenantId: dev.rootTenantId,
        poolId,
        ttlSeconds: 3600,
        maxUses: 5,
        idempotencyKey: `bcd-e2e-sim-${Date.now()}`,
      })
    ).token;
    const { cmd, args } = linux([toLinux(binary), 'sim', '--config', toLinux(simConfig), '--nodes', '5', '--seed', '100']);
    const sim = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let log = '';
    sim.stdout!.on('data', (chunk: Buffer) => (log += chunk.toString()));
    sim.stderr!.on('data', (chunk: Buffer) => (log += chunk.toString()));
    sim.stdin!.end(`${simToken}\n`);
    try {
      const ids = await until(
        'five simulated nodes to join',
        async () => {
          const joined = [...log.matchAll(/simulated node joined.*?node=(node_\w+)/g)].map((m) => m[1]!);
          return new Set(joined).size === 5 ? [...new Set(joined)] : undefined;
        },
        120_000,
      ).catch((error) => {
        throw new Error(`${error}\n--- bcd sim log ---\n${log.slice(-4000)}`);
      });
      await dev.waitFor(ids, { timeoutMs: 120_000 });
      const { rows } = await dev.database.query<{ n: number }>(
        `SELECT count(DISTINCT hardware_key)::int AS n FROM nodes WHERE id = ANY($1)`,
        [ids],
      );
      expect(rows[0]!.n).toBe(5); // five distinct machines
      expect(log).not.toContain(simToken);
    } finally {
      sh(`pkill -f '${toLinux(simConfig)}' ; true`);
      sim.kill();
      sh(`rm -rf '${simData}'`);
    }
  }, 240_000);

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

  it('self-updates to a signed release (daemon.upgrade): A/B slots, exec, confirmed by the Welcome', async () => {
    // A second build that reports 0.9.0, released under a key only this node's config pins.
    const nextBinary = join(daemonDir, 'bin', 'bcd-linux-amd64-next');
    const built = spawnSync(goBinary, ['build', '-tags', 'nonvml,fakehw', '-ldflags', '-X main.version=0.9.0', '-o', 'bin/bcd-linux-amd64-next', './cmd/bcd'], {
      cwd: daemonDir,
      env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
      encoding: 'utf8',
    });
    expect(built.status, built.stderr).toBe(0);
    const bytes = readFileSync(nextBinary);
    const key = releaseKey;
    const signed = signReleaseManifest(
      buildReleaseManifest({
        product: 'bcd',
        version: '0.9.0',
        sequence: 1,
        artifacts: [releaseArtifact('bcd_0.9.0_linux_amd64', bytes, 'linux-amd64')],
        signers: [key],
      }),
      [key],
    );
    const served = createServer((_req, res) => res.end(bytes));
    await new Promise<void>((resolve) => served.listen(0, '0.0.0.0', resolve));
    try {
      const host = windows ? sh("ip route show default | awk '{print $3}'") : '127.0.0.1';
      const url = `http://${host}:${(served.address() as AddressInfo).port}/downloads/bcd/0.9.0/linux-amd64`;

      // Restart the node from an entrypoint it may replace, with the release key pinned.
      // [n]ode: the pattern must not match the shell running pkill/pgrep.
      sh(`pkill -f '[n]ode --config ${toLinux(config)}' ; true`);
      let left = '';
      await until('the node to stop', async () => (left = sh(`pgrep -af '[n]ode --config ${toLinux(config)}' || echo gone`)) === 'gone', 30_000).catch(async (error) => {
        const before = nodeLog.length;
        sh(`pkill -QUIT -f '[n]ode --config ${toLinux(config)}' ; true`);
        await sleep(3000);
        throw new Error(`${error}: ${left}\n${nodeLog.slice(before)}`);
      });
      const entry = `${dataDir}/entry/bcd`;
      sh(`mkdir -p '${dataDir}/entry' && cp '${toLinux(binary)}' '${entry}' && chmod 0755 '${entry}'`);
      writeFileSync(
        config,
        `${readFileSync(config, 'utf8')}\n[update]\nrelease_pins = "${spkiPin(key.publicKey)}"\nentrypoint = "${entry}"\n`,
      );
      const restarted = new Date();
      startNode(entry);
      const version = async (since = new Date(0)) =>
        (
          await dev.database.query<{ daemon_version: string }>(
            'SELECT daemon_version FROM node_sessions WHERE node_id = $1 AND connected_at > $2',
            [nodeId, since],
          )
        ).rows[0]?.daemon_version;
      await until('the node to reconnect', async () => (await version(restarted)) === '0.0.0-dev', 90_000);

      // daemon.upgrade is the rollout controller's (not runnable through the API): enqueue it as it does.
      const upgrade = await dev.database.transaction((tx: any) =>
        dev.compute.context.commands.enqueue(tx, {
          nodeId,
          kind: 'daemon.upgrade',
          payload: {
            version: '0.9.0',
            url,
            sha256: createHash('sha256').update(bytes).digest('base64'),
            signature: Buffer.from(JSON.stringify(signed)).toString('base64'),
          },
          idempotencyKey: 'bcd-e2e-upgrade',
          notAfter: Date.now() + 600_000,
        }),
      );
      await until('daemon.upgrade to succeed', async () => (await commandState(upgrade.id)) === 'succeeded', 120_000).catch((error) => {
        throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-4000)}`);
      });
      expect(await version()).toBe('0.9.0');
      expect(sh(`readlink '${dataDir}/bin/current'`)).toBe('bcd-b');
      expect(sh(`readlink '${entry}'`)).toBe(`${dataDir}/bin/current`);
      expect(sh(`test -f '${dataDir}/upgrade.json' && echo pending || echo confirmed`)).toBe('confirmed');
    } finally {
      served.close();
    }
  }, 300_000);
});
