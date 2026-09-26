import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCertificate,
  distinguishedName,
  generateP256KeyPair,
  parseCertificate,
  privateKeyPem,
  spkiPin,
  toPem,
  tpmAttestor,
  type TpmIdentity,
} from '@better-compute/pki';
import { createDevStack, type DevStack } from '@better-compute/testing';

// The tpm join attestor end to end (v0.5, PLAN §13): a fakehw bcd with its software TPM
// (<data_dir>/fakehw-tpm.json) runs `bcd join --attestor tpm` with no token against JoinService
// with tpmAttestor. It proves its EK and AK over the challenge round, lands in the pool the attestor
// resolves for its EK, and is bound to that EK: after losing its identity (a reinstall) the same TPM
// joins as the same node. Then bcd node runs on that identity. Same WSL/Linux gating as bcd.test.ts.

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
function runLinux(argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { cmd, args } = linux(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

let dev: DevStack;
let configDir: string;
let ekCa: string;
let config: string;
let dataDir: string;
let poolId = '';
let node: ChildProcess | undefined;
let nodeLog = '';
const seen: TpmIdentity[] = [];

describe.skipIf(!enabled)('bcd join --attestor tpm', () => {
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
    // A TPM manufacturer: the fake machine's TPM gets its EK certificate from this root
    // (BCD_FAKEHW_TPM_EK_CA), and the attestor trusts only it, as it trusts real manufacturers.
    configDir = mkdtempSync(join(tmpdir(), 'bcd-tpm-'));
    const manufacturer = generateP256KeyPair();
    const subject = distinguishedName({ commonName: 'bcd e2e TPM EK root' });
    const ekRoot = buildCertificate(
      {
        serial: new Uint8Array([1]),
        issuer: subject,
        subject,
        notBefore: Date.now() - 86_400_000,
        notAfter: Date.now() + 10 * 365 * 86_400_000,
        publicKey: manufacturer.publicKey,
        ca: {},
      },
      manufacturer.privateKey,
    );
    ekCa = join(configDir, 'ek-ca.pem');
    writeFileSync(ekCa, toPem(ekRoot) + privateKeyPem(manufacturer.privateKey), { mode: 0o600 });
    dev = await createDevStack({
      externalTls: { host: '0.0.0.0' },
      attestors: [
        tpmAttestor({
          challengeKey: new Uint8Array(randomBytes(32)),
          ekRoots: [ekRoot],
          // The operator's allow-list: this EK joins the TPM pool.
          resolve: async (_tx, identity) => {
            seen.push(identity);
            return { tenantId: dev.rootTenantId, role: 'node', poolId };
          },
        }),
      ],
    });
    const api = dev.compute.api as any;
    const site = await api.sites.create(dev.root, { tenantId: dev.rootTenantId, kind: 'shared', region: 'dev-1', idempotencyKey: 'bcd-tpm-site' });
    poolId = (
      await api.pools.create(dev.root, {
        tenantId: dev.rootTenantId,
        siteId: site.id,
        class: 'metal-host',
        sharing: 'exclusive',
        idempotencyKey: 'bcd-tpm-pool',
      })
    ).id;

    const url = new URL(dev.externalGatewayUrl!);
    url.hostname = host;
    config = join(configDir, 'config.toml');
    dataDir = `/tmp/bcd-tpm-${randomBytes(6).toString('hex')}`;
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
  }, 240_000);

  afterAll(async () => {
    if (config) sh(`pkill -f '${toLinux(config)}' ; true`);
    node?.kill();
    if (dataDir) sh(`rm -rf '${dataDir}'`);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    await dev?.close();
  }, 60_000);

  // The fake machine's TPM: its EK certified by the manufacturer above, and the node key kept in it.
  const tpmEnv = () => ['env', 'BCD_FAKEHW_SEED=93', `BCD_FAKEHW_TPM_EK_CA=${toLinux(ekCa)}`, 'BCD_FAKEHW_TPM_KEYS=1'];
  const tpmJoin = () => runLinux([...tpmEnv(), toLinux(binary), 'join', '--config', toLinux(config), '--attestor', 'tpm']);

  it('joins with its TPM and no token, into the pool the attestor resolves, bound to its EK; a reinstall rejoins as the same node', async () => {
    const first = await tpmJoin();
    expect(first.status, first.stderr).toBe(0);
    const nodeId = /joined as (\S+)/.exec(first.stdout)?.[1] ?? '';
    expect(nodeId).toMatch(/^node_/);
    // Two rounds: the evidence, then the activated credential and the quote. resolve ran on the verified identity.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pcrs.get(0x000b)?.size).toBe(8); // SHA-256 bank, PCRs 0-7
    // The EK certificate bcd read from the TPM's NV, chained to the manufacturer.
    expect(seen[0]!.ekCertificate?.issuer).toContain('bcd e2e TPM EK root');
    // The node key is in the TPM too: the data directory holds only its record.
    expect(sh(`head -n 1 '${dataDir}/node.key'`)).toBe('-----BEGIN BCD TPM NODE KEY-----');
    const row = (await dev.database.query<{ pool_id: string }>('SELECT pool_id FROM nodes WHERE id = $1', [nodeId])).rows[0];
    expect(row?.pool_id).toBe(poolId);
    const bindings = (
      await dev.database.query<{ node_id: string; subject: Uint8Array }>(`SELECT node_id, subject FROM node_bindings WHERE attestor = 'tpm'`)
    ).rows;
    expect(bindings.map((b) => b.node_id)).toEqual([nodeId]);
    expect(Buffer.from(bindings[0]!.subject).equals(Buffer.from(seen[0]!.ekSha256))).toBe(true);

    // The machine loses its identity (a disk swap, a reinstall); its TPM is the same: the same node.
    sh(`rm -f '${dataDir}/identity.json' '${dataDir}/node.key'`);
    const again = await tpmJoin();
    expect(again.status, again.stderr).toBe(0);
    expect(/joined as (\S+)/.exec(again.stdout)?.[1]).toBe(nodeId);
    // Both joins' node keys were certified by the TPM's AK (tpmAttestor's default, nodeKey: certified), and
    // the control plane recorded it.
    const joinedEvents = (
      await dev.database.query<{ payload: { data: { nodeId: string; nodeKey: string } } }>(
        `SELECT payload FROM outbox WHERE topic = 'node.joined' ORDER BY seq`,
      )
    ).rows.map((row) => row.payload.data);
    expect(joinedEvents.filter((e) => e.nodeId === nodeId).map((e) => e.nodeKey)).toEqual(['tpm', 'tpm']);
    // And once joined, re-running it is a no-op that needs no TPM round.
    const noop = await tpmJoin();
    expect(noop.stdout).toContain(`already joined as ${nodeId}`);

    const { cmd, args } = linux([...tpmEnv(), toLinux(binary), 'node', '--config', toLinux(config)]);
    node = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    node.stderr!.on('data', (chunk: Buffer) => {
      nodeLog += chunk.toString();
      if (process.env.BCD_E2E_LOG) process.stderr.write(chunk);
    });
    await dev.waitFor([nodeId], { timeoutMs: 120_000 }).catch((error) => {
      throw new Error(`${error}\n--- bcd log ---\n${nodeLog.slice(-4000)}`);
    });
  }, 240_000);
});
