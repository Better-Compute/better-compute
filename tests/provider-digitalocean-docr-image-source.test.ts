import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, manualClock, type ComputeError, type ImageSource } from '@better-compute/core';
import {
  docrImageSource,
  parseBearerChallenge,
  parseOciReference,
  resetBudgets,
  type DocrImageSourceOptions,
} from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import {
  DocrEmulator,
  docrFetch,
  registerRegistry,
  registryWorld,
  seedRegistry,
} from './support/do-emulator/registry.js';

// The DOCR image source: oci://registry.digitalocean.com/... resolved to the disk layer's digest
// and the registry's presigned blob URL, with short-lived read-only credentials that never leave
// the control plane.

beforeEach(() => resetBudgets());

const t0 = Date.parse('2026-11-05T10:00:00Z');
const secrets = {
  resolve: async (ref: string) => {
    if (ref === 'secret://do/t') return 'do-token';
    throw new Error('no such secret');
  },
};

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

function setup() {
  const clock = manualClock(t0);
  const emu = new DoEmulator({ now: () => clock.now() });
  registerRegistry(emu);
  const docr = new DocrEmulator(registryWorld(emu), () => clock.now());
  const source: ImageSource = docrImageSource({
    token: 'secret://do/t',
    secrets,
    fetch: docrFetch(emu, docr),
    clock,
  });
  const disk = new TextEncoder().encode('a disk image, compressed');
  const layer = docr.blob(disk);
  const config = docr.blob(new TextEncoder().encode('{}'));
  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: config, size: 2 },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar',
        digest: layer,
        size: disk.length,
        annotations: { 'org.opencontainers.image.title': 'ubuntu-24.04.raw.zst' },
      },
    ],
  };
  const manifestDigest = docr.push('acme/images/ubuntu', '24.04', manifest);
  return { clock, emu, docr, source, layer, disk, manifest, manifestDigest };
}

describe('docrImageSource', () => {
  it('resolves a tag to the disk layer and a presigned blob URL', async () => {
    const { source, layer, disk, emu, docr } = setup();
    expect(source.extension).toBe('image-source');
    expect(source.schemes).toEqual(['oci']);
    const resolved = await source.resolve('oci://registry.digitalocean.com/acme/images/ubuntu:24.04');
    expect(resolved).toEqual({
      url: `https://docr-blobs.nyc3.digitaloceanspaces.com/${layer.replace(':', '/')}?X-Amz-Expires=1200&X-Amz-Signature=presigned`,
      sha256: layer.slice('sha256:'.length),
      sizeBytes: disk.length,
      format: 'raw',
      compression: 'zstd',
    });
    // Read-only, short-lived credentials.
    const creds = emu.requests.filter((r) => r.url.pathname === '/v2/registry/docker-credentials');
    expect(creds).toHaveLength(1);
    expect(creds[0]!.url.searchParams.get('read_write')).toBe('false');
    expect(Number(creds[0]!.url.searchParams.get('expiry_seconds'))).toBeLessThanOrEqual(3600);
    // The node-facing URL carries no credential of ours.
    const issued = [...registryWorld(emu).issued.keys()];
    expect(resolved.url).not.toContain(issued[0]!);
    expect(resolved.url).not.toContain('do-token');
    // Credentials go to the token service only; the registry sees bearer tokens.
    for (const r of docr.requests.filter((r) => r.url.host === 'registry.digitalocean.com'))
      expect(r.headers.authorization ?? '').not.toMatch(/^Basic/);
  });

  it('reuses credentials and tokens across resolutions until they expire', async () => {
    const { source, emu, clock } = setup();
    await source.resolve('oci://registry.digitalocean.com/acme/images/ubuntu:24.04');
    await source.resolve('oci://registry.digitalocean.com/acme/images/ubuntu:24.04');
    const credCalls = () =>
      emu.requests.filter((r) => r.url.pathname === '/v2/registry/docker-credentials').length;
    expect(credCalls()).toBe(1);
    clock.advance(600_000);
    await source.resolve('oci://registry.digitalocean.com/acme/images/ubuntu:24.04');
    expect(credCalls()).toBe(2);
  });

  it('resolves by digest and checks the manifest against it', async () => {
    const { source, manifestDigest, docr, manifest } = setup();
    const byDigest = await source.resolve(
      `oci://registry.digitalocean.com/acme/images/ubuntu@${manifestDigest}`,
    );
    expect(byDigest.format).toBe('raw');
    // A registry that answers a digest with other bytes is caught.
    docr.manifests
      .get('acme/images/ubuntu')!
      .set(manifestDigest, { body: JSON.stringify({ ...manifest, extra: 1 }), mediaType: 'application/vnd.oci.image.manifest.v1+json' });
    const error = await failure(
      source.resolve(`oci://registry.digitalocean.com/acme/images/ubuntu@${manifestDigest}`),
    );
    expect(error.details?.reason).toBe('manifestDigest');
  });

  it('never sends credentials to a token realm off DigitalOcean', async () => {
    const { source, docr } = setup();
    docr.realm = 'https://evil.example/token';
    const error = await failure(
      source.resolve('oci://registry.digitalocean.com/acme/images/ubuntu:24.04'),
    );
    expect(error.details?.reason).toBe('realm');
    expect(docr.requests.some((r) => r.url.host === 'evil.example')).toBe(false);
  });

  it('fails closed when the registry would need our credentials to serve the blob', async () => {
    const { source, docr } = setup();
    docr.serveBlobs = true;
    expect(
      (await failure(source.resolve('oci://registry.digitalocean.com/acme/images/ubuntu:24.04')))
        .details?.reason,
    ).toBe('blobRedirect');
  });

  it('refuses references it cannot serve', async () => {
    const { source, docr, layer } = setup();
    const reason = async (ref: string) => (await failure(source.resolve(ref))).details?.reason;
    expect(await reason('oci://registry.digitalocean.com/acme/images/ubuntu')).toBe('ociReference');
    expect(await reason('oci://ghcr.io/acme/images/ubuntu:1')).toBe('registryHost');
    expect(await reason('https://registry.digitalocean.com/acme/x:1')).toBe('ociReference');
    docr.push('acme/images/none', '1', { schemaVersion: 2, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: layer, size: 1 }] });
    expect(await reason('oci://registry.digitalocean.com/acme/images/none:1')).toBe('noDiskLayer');
    docr.push('acme/images/two', '1', {
      schemaVersion: 2,
      layers: [
        { mediaType: 'application/vnd.better-compute.disk.raw+zstd', digest: layer, size: 1 },
        { mediaType: 'application/vnd.better-compute.disk.qcow2', digest: layer, size: 1 },
      ],
    });
    expect(await reason('oci://registry.digitalocean.com/acme/images/two:1')).toBe('ambiguousDiskLayer');
    docr.push('acme/images/index', '1', { schemaVersion: 2, manifests: [] });
    expect(await reason('oci://registry.digitalocean.com/acme/images/index:1')).toBe('imageIndex');
    expect((await failure(source.resolve('oci://registry.digitalocean.com/acme/images/missing:1'))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('reads the disk format from the layer media type', async () => {
    const { source, docr, layer } = setup();
    docr.push('acme/images/q', '1', {
      schemaVersion: 2,
      layers: [{ mediaType: 'application/vnd.better-compute.disk.qcow2', digest: layer, size: 9 }],
    });
    const resolved = await source.resolve('oci://registry.digitalocean.com/acme/images/q:1');
    expect(resolved).toMatchObject({ format: 'qcow2', compression: 'none', sizeBytes: 9 });
  });

  it('refuses a plain token', () => {
    expect(() =>
      docrImageSource({ token: 'dop_v1_plain' as unknown as 'secret://x', secrets }),
    ).toThrow(/secret reference/);
  });
});

describe('regional mirrors', () => {
  const ref = 'oci://registry.digitalocean.com/acme/images/ubuntu:24.04';
  const blobHost = (url: string) => new URL(url).host;

  function mirrored(mirrors: DocrImageSourceOptions['mirrors']) {
    const base = setup();
    const source = docrImageSource({
      token: 'secret://do/t',
      secrets,
      fetch: docrFetch(base.emu, base.docr),
      clock: base.clock,
      ...(mirrors !== undefined ? { mirrors } : {}),
    });
    base.docr.blobRegions.set('acme-ams3', 'ams3');
    base.docr.blobRegions.set('acme-sgp1', 'sgp1');
    return { ...base, source };
  }

  const manifestReads = (docr: DocrEmulator) =>
    docr.requests.filter((r) => r.url.pathname.includes('/manifests/')).map((r) => r.url.pathname);
  const blobReads = (docr: DocrEmulator) =>
    docr.requests
      .filter((r) => r.url.pathname.includes('/blobs/') && !r.headers.authorization?.startsWith('Basic'))
      .map((r) => r.url.pathname.split('/')[2]);

  it('serves the layer from the mirror in the region, the manifest from the source', async () => {
    const { source, docr, layer } = mirrored({ acme: { ams3: 'acme-ams3' } });
    const resolved = await source.resolve(ref, { region: 'ams3' });
    expect(blobHost(resolved.url)).toBe('docr-blobs.ams3.digitaloceanspaces.com');
    expect(resolved.sha256).toBe(layer.slice('sha256:'.length));
    // The source registry is authoritative for what the tag means; the mirror only serves bytes
    // the node verifies by digest.
    expect(manifestReads(docr).every((path) => path.startsWith('/v2/acme/images/'))).toBe(true);
    expect(new Set(blobReads(docr))).toEqual(new Set(['acme-ams3']));
    // Without a region, or in a region with no mirror: the source.
    expect(blobHost((await source.resolve(ref)).url)).toBe('docr-blobs.nyc3.digitaloceanspaces.com');
    expect(blobHost((await source.resolve(ref, { region: 'fra1' })).url)).toBe(
      'docr-blobs.nyc3.digitaloceanspaces.com',
    );
    // A source bound to a region.
    expect(blobHost((await source.forRegion('ams3').resolve(ref)).url)).toBe(
      'docr-blobs.ams3.digitaloceanspaces.com',
    );
  });

  it('falls back to the source when the mirror lacks the layer or is down', async () => {
    const { source, docr, layer } = mirrored({ acme: { ams3: 'acme-ams3' } });
    docr.missingBlobs.add(`acme-ams3@${layer}`);
    expect(blobHost((await source.resolve(ref, { region: 'ams3' })).url)).toBe(
      'docr-blobs.nyc3.digitaloceanspaces.com',
    );
    docr.missingBlobs.clear();
    docr.failingRegistries.set('acme-ams3', 503);
    expect(blobHost((await source.resolve(ref, { region: 'ams3' })).url)).toBe(
      'docr-blobs.nyc3.digitaloceanspaces.com',
    );
    // A mirror that would serve the bytes itself is skipped, never handed to a node.
    docr.failingRegistries.clear();
    docr.serveBlobs = true;
    expect((await failure(source.resolve(ref, { region: 'ams3' }))).details?.reason).toBe(
      'blobRedirect',
    );
  });

  it('discovers mirrors among the account registries: <source>-<region>, in that region', async () => {
    const { source, docr, emu } = mirrored(undefined);
    seedRegistry(emu, { name: 'acme', region: 'nyc3' });
    seedRegistry(emu, { name: 'acme-sgp1', region: 'sgp1' });
    // Named for fra1 but stored in ams3: not a fra1 mirror.
    seedRegistry(emu, { name: 'acme-fra1', region: 'ams3' });
    expect(blobHost((await source.resolve(ref, { region: 'sgp1' })).url)).toBe(
      'docr-blobs.sgp1.digitaloceanspaces.com',
    );
    expect(blobHost((await source.resolve(ref, { region: 'fra1' })).url)).toBe(
      'docr-blobs.nyc3.digitaloceanspaces.com',
    );
    // The source's own region needs no mirror.
    expect(blobHost((await source.resolve(ref, { region: 'nyc3' })).url)).toBe(
      'docr-blobs.nyc3.digitaloceanspaces.com',
    );
    const listings = () => emu.requests.filter((r) => r.url.pathname === '/v2/registries').length;
    expect(listings()).toBe(1);
    expect(blobReads(docr)).not.toContain('acme-fra1');
  });

  it('resolves from the source when the registry listing fails, and never lists with mirrors off', async () => {
    const off = mirrored(false);
    seedRegistry(off.emu, { name: 'acme-sgp1', region: 'sgp1' });
    expect(blobHost((await off.source.resolve(ref, { region: 'sgp1' })).url)).toBe(
      'docr-blobs.nyc3.digitaloceanspaces.com',
    );
    expect(off.emu.requests.some((r) => r.url.pathname === '/v2/registries')).toBe(false);

    const broken = mirrored(undefined);
    seedRegistry(broken.emu, { name: 'acme-sgp1', region: 'sgp1' });
    broken.emu.failNext({ method: 'GET', path: /^\/registries$/ }, 403, {
      id: 'forbidden',
      message: 'You are not authorized to perform this operation',
    });
    expect(blobHost((await broken.source.resolve(ref, { region: 'sgp1' })).url)).toBe(
      'docr-blobs.nyc3.digitaloceanspaces.com',
    );
  });

  it('refuses a mirror map with an invalid registry or region', () => {
    const invalid: Record<string, Record<string, string>>[] = [
      { acme: { ams3: 'Not_A_Registry' } },
      { acme: { amsterdam: 'acme-ams3' } },
    ];
    for (const mirrors of invalid)
      expect(() =>
        docrImageSource({ token: 'secret://do/t', secrets, mirrors }),
      ).toThrow(/mirror/);
  });
});

describe('OCI parsing helpers', () => {
  it('parses references and challenges', () => {
    expect(parseOciReference('oci://registry.digitalocean.com/acme/app:v1.2')).toEqual({
      host: 'registry.digitalocean.com',
      name: 'acme/app',
      reference: 'v1.2',
    });
    expect(
      parseBearerChallenge(
        'Bearer realm="https://api.digitalocean.com/v2/registry/auth",service="registry.digitalocean.com",scope="repository:acme/app:pull"',
      ),
    ).toEqual({
      realm: 'https://api.digitalocean.com/v2/registry/auth',
      service: 'registry.digitalocean.com',
      scope: 'repository:acme/app:pull',
    });
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
  });
});
