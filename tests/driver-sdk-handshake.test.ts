import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import {
  buildCertificate,
  distinguishedName,
  generateP256KeyPair,
  parseCertificate,
  privateKeyPem,
  toPem,
  toPrivateKey,
} from '@better-compute/pki';
import {
  BCX_CLIENT_CERT,
  BCX_MAGIC_COOKIE_KEY,
  BCX_MAGIC_COOKIE_VALUE,
  BCX_SOCKET_DIR,
  connectPlugin,
  createEphemeralIdentity,
  decodeArgs,
  encodeArgs,
  externalDriver,
  formatHandshake,
  GrpcError,
  parseHandshake,
  pinnedFile,
  sha256File,
  type EphemeralIdentity,
  type Handshake,
} from '@better-compute/driver-sdk';

const fixture = fileURLToPath(new URL('./fixtures/bcx-echo-driver.mjs', import.meta.url));
const socketDir = mkdtempSync(join(tmpdir(), 'bcx-test-'));
const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) {
    child.stdin?.end();
    child.kill();
  }
  rmSync(socketDir, { recursive: true, force: true });
});

/** Starts the fixture by hand (no host), trusting `identity`, and reads its handshake. */
async function startPlugin(identity: EphemeralIdentity): Promise<Handshake> {
  const child = spawn(process.execPath, [fixture], {
    env: {
      ...process.env,
      [BCX_MAGIC_COOKIE_KEY]: BCX_MAGIC_COOKIE_VALUE,
      [BCX_SOCKET_DIR]: socketDir,
      [BCX_CLIENT_CERT]: identity.certificatePem,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr!.resume();
  const lines = createInterface({ input: child.stdout! });
  for await (const line of lines) if (line.startsWith('bcx|')) return parseHandshake(line);
  throw new Error('the plugin exited without a handshake');
}

describe('handshake line', () => {
  const certificate = createEphemeralIdentity('bcx-plugin').certificate;

  it('round-trips unix and tcp lines, with | in a socket path', () => {
    for (const handshake of [
      { protocolVersion: 1, network: 'unix' as const, address: '/tmp/a|b/bcx.sock', certificate },
      { protocolVersion: 1, network: 'tcp' as const, address: '127.0.0.1:41234', certificate },
    ]) {
      const line = formatHandshake(handshake);
      expect(line.startsWith(`bcx|1|${handshake.network}|${handshake.address}|grpc|`)).toBe(true);
      expect(parseHandshake(line)).toEqual(handshake);
    }
  });

  it('refuses other versions, networks, protocols and certificates', () => {
    const cert = Buffer.from(certificate).toString('base64url');
    for (const line of [
      `bcx|2|unix|/tmp/x.sock|grpc|${cert}`,
      `bcx|1|udp|/tmp/x.sock|grpc|${cert}`,
      `bcx|1|unix|/tmp/x.sock|netrpc|${cert}`,
      `bcx|1|tcp|localhost|grpc|${cert}`,
      'bcx|1|unix|/tmp/x.sock|grpc|bm90LWEtY2VydA',
      '1|unix|/tmp/x.sock|grpc',
    ])
      expect(() => parseHandshake(line), line).toThrow(/Invalid bcx handshake/);
  });
});

describe('pinned file and arguments', () => {
  it('pins the executable, or the script after node/bun', () => {
    const cwd = resolve('/plugins');
    expect(pinnedFile(['./acme-bmc', '--verbose'], cwd)).toBe(resolve(cwd, 'acme-bmc'));
    expect(pinnedFile([process.execPath, '--enable-source-maps', 'dist/plugin.js'], cwd)).toBe(
      resolve(cwd, 'dist/plugin.js'),
    );
    expect(pinnedFile(['bun', 'run', 'plugin.ts'], cwd)).toBe(resolve(cwd, 'plugin.ts'));
    expect(() => pinnedFile(['node', '--inspect'], cwd)).toThrow(/needs a script/);
    expect(() => pinnedFile([], cwd)).toThrow(/must name an executable/);
  });

  it('encodes arguments as a JSON array; a non-array is the single argument', () => {
    expect(encodeArgs([])).toBe('[]');
    expect(encodeArgs(['on', undefined])).toBe('["on"]');
    expect(decodeArgs('["pxe",{"persistent":true}]')).toEqual(['pxe', { persistent: true }]);
    expect(decodeArgs('{"wipe":"quick"}')).toEqual([{ wipe: 'quick' }]);
    expect(decodeArgs('')).toEqual([]);
  });
});

describe('plugin process', () => {
  it('refuses to run without the magic cookie', () => {
    const env = { ...process.env };
    delete env[BCX_MAGIC_COOKIE_KEY];
    const run = spawnSync(process.execPath, [fixture], { env, encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('It is not meant to be run directly');
    expect(run.stdout).not.toContain('bcx|');
  });

  it('prints one handshake line with its network and a self-signed P-256 certificate', async () => {
    const handshake = await startPlugin(createEphemeralIdentity('bcx-host'));
    expect(handshake.protocolVersion).toBe(1);
    if (process.platform === 'win32') {
      expect(handshake.network).toBe('tcp');
      expect(handshake.address).toMatch(/^127\.0\.0\.1:\d+$/);
    } else {
      expect(handshake.network).toBe('unix');
      expect(handshake.address.startsWith(socketDir)).toBe(true);
    }
    const certificate = new X509Certificate(handshake.certificate);
    expect(certificate.subject).toContain('CN=bcx-plugin');
    expect(certificate.checkIssued(certificate)).toBe(true);
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });

  it('serves only the host certificate it was given, and the host pins the server certificate', async () => {
    const host = createEphemeralIdentity('bcx-host');
    const handshake = await startPlugin(host);

    const trusted = await connectPlugin(handshake, host);
    expect((await trusted.describe()).drivers.map((entry) => entry.id)).toEqual(['echo', 'quiet']);

    // Another self-signed client certificate is refused by the plugin's TLS layer (with TLS 1.3
    // the client learns it on its first call).
    const stranger = createEphemeralIdentity('bcx-host');
    await expect(
      connectPlugin(handshake, stranger).then((connection) => connection.describe()),
    ).rejects.toBeInstanceOf(GrpcError);

    // The refusal did not disturb the host's own connection.
    expect((await trusted.health()).status).toBe(1);
    trusted.close();
  });

  it('refuses even a certificate the host key signed: only the exact host certificate counts', async () => {
    const host = createEphemeralIdentity('bcx-host');
    const handshake = await startPlugin(host);
    // The host certificate is a CA (so OpenSSL accepts it as its own anchor), so a leaf it signed
    // passes chain verification; the plugin's exact-match check must still refuse it.
    const issuer = parseCertificate(host.certificate);
    const keys = generateP256KeyPair();
    const leaf = buildCertificate(
      {
        serial: Uint8Array.of(0x42, 0x01),
        issuer: issuer.subject,
        subject: distinguishedName({ commonName: 'bcx-host-leaf' }),
        notBefore: Date.now() - 60_000,
        notAfter: Date.now() + 3_600_000,
        publicKey: keys.publicKey,
        authorityKeyId: issuer.subjectKeyId,
        usage: ['client'],
      },
      toPrivateKey(host.keyPem),
    );
    const signed = {
      keyPem: privateKeyPem(keys.privateKey),
      certificatePem: toPem(leaf) + host.certificatePem,
    };
    await expect(
      connectPlugin(handshake, signed).then((connection) => connection.describe()),
    ).rejects.toBeInstanceOf(GrpcError);
  });

  it('refuses a plugin whose certificate differs from its handshake', async () => {
    const host = createEphemeralIdentity('bcx-host');
    const handshake = await startPlugin(host);
    // The pinned certificate is the only trust anchor, so the real one no longer verifies.
    const impostor = {
      ...handshake,
      certificate: createEphemeralIdentity('bcx-plugin').certificate,
    };
    await expect(connectPlugin(impostor, host, { timeoutMs: 5_000 })).rejects.toThrow(
      /Cannot connect to the plugin: self-signed certificate/,
    );
  });
});

describe('externalDriver start', () => {
  it('refuses a plugin whose sha256 does not match, before running it', async () => {
    const host = externalDriver({ command: [process.execPath, fixture], sha256: '0'.repeat(64) });
    const error = await host.start().catch((caught: unknown) => caught);
    expect(isComputeError(error, 'INVALID_CONFIG')).toBe(true);
    expect((error as Error).message).toMatch(/does not match its pin/);
    expect(host.pid).toBeUndefined();
    await host.close();
  });

  it('rejects a malformed pin up front', () => {
    expect(() => externalDriver({ command: [process.execPath, fixture], sha256: 'abc' })).toThrow(
      /64 hex characters/,
    );
  });

  it('gives up on a plugin that never prints its handshake', async () => {
    const host = externalDriver({
      command: [process.execPath, fixture],
      sha256: await sha256File(fixture),
      env: { BCX_ECHO_HANG: '1' },
      startTimeoutMs: 3_000,
      shutdownGraceMs: 500,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const error = await host.start().catch((caught: unknown) => caught);
    expect(isComputeError(error, 'DRIVER_ERROR')).toBe(true);
    expect((error as { details?: Record<string, unknown> }).details?.driverCode).toBe('timeout');
    await host.close();
  });
});
