import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveGateway, watchTlsFiles, type ServedGateway } from '@better-compute/gateway';
import { createServingCa, generateP256KeyPair, privateKeyPem, toPem } from '@better-compute/pki';
import { gatewayFixture, type GatewayFixture } from './support/gateway.js';

// Serving certificate hot reload (PLAN.md §7.1: 30-day gateway certificates, hot-reloaded): new
// handshakes get the new certificate, open connections keep theirs, a key that does not match its
// certificate is refused without touching the listener, and watchTlsFiles applies what
// `pki issue-gateway` writes.

const servingCa = createServingCa();

async function issue(name: string) {
  const key = generateP256KeyPair();
  const issued = await servingCa.issue(key.publicKey, { usage: 'server', dnsSans: ['gw.reload.test'], ttlSeconds: 86_400 });
  return {
    name,
    key: privateKeyPem(key.privateKey),
    cert: [issued.certificate, ...issued.chain].map((der) => toPem(der)).join(''),
    serial: issued.serial.toLowerCase().replace(/^0+/, ''),
  };
}

let f: GatewayFixture;
let served: ServedGateway;
const sockets: TLSSocket[] = [];

/** One TLS handshake against the gateway; resolves the serial of the certificate it presented. */
function handshake(): Promise<{ serial: string; socket: TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      port: served.port,
      host: '127.0.0.1',
      servername: 'gw.reload.test',
      ca: toPem(servingCa.certificate),
      ALPNProtocols: ['h2'],
      checkServerIdentity: () => undefined,
    });
    sockets.push(socket);
    socket.once('secureConnect', () =>
      resolve({ serial: socket.getPeerCertificate().serialNumber.toLowerCase().replace(/^0+/, ''), socket }),
    );
    socket.once('error', reject);
  });
}

let first: Awaited<ReturnType<typeof issue>>;
let second: Awaited<ReturnType<typeof issue>>;

beforeEach(async () => {
  [first, second] = await Promise.all([issue('first'), issue('second')]);
  f = await gatewayFixture();
  served = await serveGateway(f.gateway, {
    tls: { key: first.key, cert: first.cert, minVersion: 'TLSv1.3' },
    authenticate: () => undefined,
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await served.close(100);
  await f.close();
});

describe('serving certificate hot reload', () => {
  it('serves the new certificate to new handshakes and keeps open connections', async () => {
    const before = await handshake();
    expect(before.serial).toBe(first.serial);

    served.setTls({ key: second.key, cert: second.cert });
    const after = await handshake();
    expect(after.serial).toBe(second.serial);
    // The connection opened before the swap is untouched; the rest of the options (TLS 1.3) stayed.
    expect(before.socket.destroyed).toBe(false);
    expect(after.socket.getProtocol()).toBe('TLSv1.3');
  });

  it('refuses a key that does not match its certificate and keeps serving the old one', async () => {
    expect(() => served.setTls({ key: first.key, cert: second.cert })).toThrow(/does not load/);
    expect((await handshake()).serial).toBe(first.serial);
  });
});

describe('watchTlsFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bc-tls-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies replaced files, reports a broken pair, and applies the next good one', async () => {
    const files = { key: join(dir, 'gw.key'), cert: join(dir, 'gw.crt') };
    await writeFile(files.key, first.key);
    await writeFile(files.cert, first.cert);
    const errors: unknown[] = [];
    let reloads = 0;
    const watch = watchTlsFiles(files, (material) => served.setTls(material), {
      intervalMs: 3_600_000,
      onError: (error) => errors.push(error),
      onReload: () => reloads++,
    });
    try {
      // What the listener started with is not a change.
      expect(await watch.check()).toBe(false);

      await writeFile(files.key, second.key);
      await writeFile(files.cert, second.cert + '\n');
      expect(await watch.check()).toBe(true);
      expect((await handshake()).serial).toBe(second.serial);

      // Half a rotation (a new certificate, the old key): refused, the listener keeps serving.
      await writeFile(files.cert, first.cert + '\n\n');
      expect(await watch.check()).toBe(false);
      expect(errors).toHaveLength(1);
      expect((await handshake()).serial).toBe(second.serial);

      await writeFile(files.key, first.key);
      expect(await watch.check()).toBe(true);
      expect((await handshake()).serial).toBe(first.serial);
      expect(reloads).toBe(2);
    } finally {
      watch.close();
    }
  });
});
