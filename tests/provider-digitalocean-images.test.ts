import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  catalogImageName,
  classifyImage,
  deploymentTag,
  distributionOf,
  gpuVendorOf,
  imageTag,
  labels,
  type CatalogImageLocation,
  type CatalogImageSource,
} from '@better-compute/provider-digitalocean';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { failImport, seedImage } from './support/do-emulator/images.js';
import { DoEmulator } from './support/do-emulator/index.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean P3: image references (slug, id, catalog import, region transfer) and the
// GPU image guard, against the in-memory emulator.

const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';
const t0 = Date.parse('2026-11-05T10:00:00Z');

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const request = (over: Record<string, unknown> = {}) => ({
  offerId: 'nyc3/s-2vcpu-4gb',
  image: 'ubuntu-24-04-x64',
  userData: '#cloud-config\n',
  name: 'inst_1',
  sshKeys: [testKey],
  labels: { [labels.tenant]: 'acme' },
  ...over,
});

const dropletPosts = (emu: DoEmulator) =>
  emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v2/droplets');

beforeEach(freshBudgets);

describe('image references', () => {
  it('classifies slugs, ids and catalog refs', () => {
    expect(classifyImage('ubuntu-24-04-x64')).toEqual({ kind: 'slug', slug: 'ubuntu-24-04-x64' });
    expect(classifyImage('gpu-h100x1-base')).toEqual({ kind: 'slug', slug: 'gpu-h100x1-base' });
    expect(classifyImage('12345')).toEqual({ kind: 'id', id: 12345 });
    expect(classifyImage('ubuntu-24.04-server@2026.09')).toEqual({
      kind: 'catalog',
      ref: 'ubuntu-24.04-server@2026.09',
    });
  });

  it('refuses malformed refs as INVALID_INPUT', () => {
    for (const bad of ['', 'Ubuntu 24', '0123', '99999999999999999999', '-x', 'a@b@c', 'UBUNTU']) {
      expect(() => classifyImage(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({
          code: 'INVALID_INPUT',
          details: { provider: 'digitalocean', reason: 'image' },
        }),
      );
    }
  });

  it('create and reinstall refuse a malformed image before any request', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const compute = await build(emu);
    const error = await failure(compute.create(request({ image: 'not an image' }), ctx()));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toMatchObject({ reason: 'image' });
    const droplet = seedDroplet(emu.state, { tags: [] });
    const sent = emu.requests.length;
    const rebuild = await failure(compute.reinstall(String(droplet.id), 'x y', ctx()));
    expect(rebuild.code).toBe('INVALID_INPUT');
    expect(emu.requests).toHaveLength(sent);
    expect(dropletPosts(emu)).toHaveLength(0);
  });

  it('a slug and an id pass through to the create body without a lookup', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const compute = await build(emu, doAccount);
    await compute.create(request(), ctx('a'));
    await compute.create(request({ name: 'inst_2', image: '777' }), ctx('b'));
    expect(dropletPosts(emu).map((r) => (r.body as { image: unknown }).image)).toEqual([
      'ubuntu-24-04-x64',
      777,
    ]);
    expect(emu.requests.some((r) => r.url.pathname.startsWith('/v2/images'))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------ catalog

const digest = 'ab'.repeat(32);
const presigned =
  'https://blobs.example.test/images/ubuntu.qcow2?X-Amz-Signature=SECRETSIGNATURE&X-Amz-Expires=21600';

/** A catalog source with one image; `null` makes it know none. */
function catalogSource(over: Partial<CatalogImageLocation> | null = {}) {
  const calls: { ref: string; expiresInSeconds: number }[] = [];
  const source: CatalogImageSource = {
    async locate(ref, options) {
      calls.push({ ref, expiresInSeconds: options.expiresInSeconds });
      if (over === null) return undefined;
      return { url: presigned, sha256: digest, format: 'qcow2', compression: 'gzip', ...over };
    },
  };
  return { source, calls };
}

function capturingLog() {
  const lines: string[] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    void lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  return {
    lines,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

const catalogRef = 'ubuntu-24.04-server@2026.09';
const imagePosts = (emu: DoEmulator) =>
  emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v2/images');
const ourImageTags = ['better-compute-managed:true', deploymentTag('default'), imageTag(digest)];
const importsOf = (emu: DoEmulator) =>
  [...emu.state.images.values()].filter((i) => (i.tags as string[]).includes(imageTag(digest)));

describe('catalog image import', () => {
  it('imports a catalog image once, tagged, and creates from it when it is available', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    emu.importReads = 2;
    const { source, calls } = catalogSource();
    const compute = await build(emu, doAccount, { catalogImages: source });

    // The import starts; the create waits for it without blocking.
    const first = await failure(compute.create(request({ image: catalogRef }), ctx('k')));
    expect(first.code).toBe('UNAVAILABLE');
    expect(first.details).toMatchObject({ reason: 'imageImporting', retryAfterMs: 30_000 });
    expect(dropletPosts(emu)).toHaveLength(0);
    expect(imagePosts(emu)).toHaveLength(1);
    expect(imagePosts(emu)[0]!.body).toEqual({
      name: `bc-img-ubuntu-24.04-server-2026.09-${digest.slice(0, 12)}`,
      url: presigned,
      region: 'nyc3',
      distribution: 'Ubuntu',
      description: `better-compute catalog image ${catalogRef}`,
      tags: ourImageTags,
    });
    expect(calls[0]).toEqual({ ref: catalogRef, expiresInSeconds: 6 * 3600 });

    // The retry finds the import (no second one) and creates from it once it is there.
    const machine = await compute.create(request({ image: catalogRef }), ctx('k'));
    expect(imagePosts(emu)).toHaveLength(1);
    const [imported] = importsOf(emu);
    expect(imported!.status).toBe('available');
    expect(dropletPosts(emu)).toHaveLength(1);
    expect((dropletPosts(emu)[0]!.body as { image: unknown }).image).toBe(imported!.id);
    expect(machine.state).toBe('pending');

    // Another instance of the same image reuses the import.
    await compute.create(request({ name: 'inst_2', image: catalogRef }), ctx('k2'));
    expect(imagePosts(emu)).toHaveLength(1);
    expect(dropletPosts(emu)).toHaveLength(2);
  });

  it('two racing imports of one digest converge on the oldest; the other is deleted', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const { source } = catalogSource();
    const compute = await build(emu, doAccount, { catalogImages: source });
    let rival = 0;
    emu.beforeAction('POST /images', (context) => {
      rival = seedImage(context.state, {
        tags: ourImageTags,
        status: 'available',
        regions: ['nyc3'],
        created_at: '2026-11-05T09:00:00Z',
      }).id;
    });
    await compute.create(request({ image: catalogRef }), ctx('k'));
    expect((dropletPosts(emu)[0]!.body as { image: unknown }).image).toBe(rival);
    expect(imagePosts(emu)).toHaveLength(1);
    const deleted = emu.requests.filter((r) => r.method === 'DELETE').map((r) => r.url.pathname);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^\/v2\/images\/\d+$/);
    expect(deleted[0]).not.toBe(`/v2/images/${rival}`);
    expect(importsOf(emu).map((i) => i.id)).toEqual([rival]);
  });

  it("another deployment's import of the digest is neither used nor deleted", async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const foreign = seedImage(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('other'), imageTag(digest)],
      regions: ['nyc3'],
    });
    const unmanaged = seedImage(emu.state, { tags: [imageTag(digest)], regions: ['nyc3'] });
    const { source } = catalogSource();
    const compute = await build(emu, doAccount, { catalogImages: source });
    await compute.create(request({ image: catalogRef }), ctx('k'));
    expect(imagePosts(emu)).toHaveLength(1);
    const used = (dropletPosts(emu)[0]!.body as { image: number }).image;
    expect([foreign.id, unmanaged.id]).not.toContain(used);
    expect(emu.state.images.has(foreign.id)).toBe(true);
    expect(emu.state.images.has(unmanaged.id)).toBe(true);
    expect(emu.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('a failed import is deleted and fails the create; the next create imports afresh', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    emu.importReads = 5;
    const { source } = catalogSource();
    const compute = await build(emu, doAccount, { catalogImages: source });
    await failure(compute.create(request({ image: catalogRef }), ctx('k')));
    const [image] = importsOf(emu);
    failImport(emu.state, image!.id, `could not fetch ${presigned}`);
    const error = await failure(compute.create(request({ image: catalogRef }), ctx('k')));
    expect(error.code).toBe('INVALID_STATE');
    expect(error.details).toMatchObject({ reason: 'imageImportFailed' });
    expect(error.message).not.toContain('SECRETSIGNATURE');
    expect(emu.state.images.has(image!.id)).toBe(false);
    const again = await failure(compute.create(request({ image: catalogRef }), ctx('k')));
    expect(again.details).toMatchObject({ reason: 'imageImporting' });
    expect(imagePosts(emu)).toHaveLength(2);
  });

  it('refuses what DigitalOcean cannot import, and an unknown ref, before any import', async () => {
    const cases: [Partial<CatalogImageLocation> | null, string, string][] = [
      [null, 'INVALID_CONFIG', 'catalogImage'],
      [{ format: 'iso' }, 'UNSUPPORTED', 'imageFormat'],
      [{ compression: 'zstd' }, 'UNSUPPORTED', 'imageFormat'],
      [{ url: 'http://blobs.example.test/x' }, 'INVALID_CONFIG', 'catalogImageUrl'],
      [{ url: 'not a url' }, 'INVALID_CONFIG', 'catalogImageUrl'],
      [{ sha256: 'abc' }, 'INVALID_CONFIG', 'catalogImage'],
    ];
    for (const [over, code, reason] of cases) {
      freshBudgets();
      const emu = new DoEmulator({ now: () => t0 });
      const { source } = catalogSource(over);
      const compute = await build(emu, doAccount, { catalogImages: source });
      const error = await failure(compute.create(request({ image: catalogRef }), ctx('k')));
      expect([error.code, error.details?.reason], JSON.stringify(over)).toEqual([code, reason]);
      expect(imagePosts(emu)).toHaveLength(0);
      expect(dropletPosts(emu)).toHaveLength(0);
    }
  });

  it('the presigned URL never reaches a log line or an error, even when DO quotes it', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const { source } = catalogSource();
    const { lines, log } = capturingLog();
    const compute = await build(emu, doAccount, { catalogImages: source }, { log });
    emu.failNext({ method: 'POST', path: /^\/images$/ }, 422, {
      id: 'unprocessable_entity',
      message: `url ${presigned} is not reachable`,
    });
    const error = await failure(compute.create(request({ image: catalogRef }), ctx('k')));
    expect(error.code).toBe('INVALID_INPUT');
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
      'SECRETSIGNATURE',
    );
    await compute.create(request({ image: catalogRef }), ctx('k'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('SECRETSIGNATURE');
  });

  it('reinstall rebuilds from the imported image', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const { source } = catalogSource();
    const compute = await build(emu, doAccount, { catalogImages: source });
    const droplet = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('default')],
    });
    await compute.reinstall(String(droplet.id), catalogRef, ctx());
    const [imported] = importsOf(emu);
    const rebuild = emu.requests.find(
      (r) => r.method === 'POST' && r.url.pathname === `/v2/droplets/${droplet.id}/actions`,
    );
    expect(rebuild!.body).toEqual({ type: 'rebuild', image: imported!.id });
  });

  it('names and distributions of imports', () => {
    expect(catalogImageName('My Image@1.0', digest)).toBe(
      `bc-img-my-image-1.0-${digest.slice(0, 12)}`,
    );
    expect(distributionOf('debian-12@x')).toBe('Debian');
    expect(distributionOf('rocky-9@x')).toBe('Rocky Linux');
    expect(distributionOf('custom@1')).toBe('Unknown');
    expect(distributionOf('custom@1', 'Fedora')).toBe('Fedora');
    expect(distributionOf('custom@1', 'Windows')).toBe('Unknown');
  });
});

describe('catalog image region transfer', () => {
  it('copies an import into another region once, then creates there', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    emu.transferReads = 3;
    const imported = seedImage(emu.state, { tags: ourImageTags, regions: ['nyc3'] });
    const { source } = catalogSource();
    const compute = await build(
      emu,
      { ...doAccount, regions: ['nyc3', 'sfo3'] },
      { catalogImages: source },
    );
    const sfo = request({ offerId: 'sfo3/s-1vcpu-1gb', image: catalogRef });
    const transfers = () =>
      emu.requests.filter(
        (r) => r.method === 'POST' && r.url.pathname === `/v2/images/${imported.id}/actions`,
      );

    const first = await failure(compute.create(sfo, ctx('k')));
    expect(first.code).toBe('UNAVAILABLE');
    expect(first.details).toMatchObject({ reason: 'imageTransferring', retryAfterMs: 30_000 });
    expect(transfers().map((r) => r.body)).toEqual([{ type: 'transfer', region: 'sfo3' }]);

    // While the copy runs, a retry starts no second one.
    await failure(compute.create(sfo, ctx('k')));
    await failure(compute.create(sfo, ctx('k')));
    expect(transfers()).toHaveLength(1);

    await compute.create(sfo, ctx('k'));
    expect(dropletPosts(emu)[0]!.body as { image: unknown; region: string }).toMatchObject({
      image: imported.id,
      region: 'sfo3',
    });
    expect(imagePosts(emu)).toHaveLength(0);
  });

  it('a transfer that errored is started again', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    emu.transferReads = 10;
    const imported = seedImage(emu.state, { tags: ourImageTags, regions: ['nyc3'] });
    const { source } = catalogSource();
    const compute = await build(
      emu,
      { ...doAccount, regions: ['nyc3', 'sfo3'] },
      { catalogImages: source },
    );
    const sfo = request({ offerId: 'sfo3/s-1vcpu-1gb', image: catalogRef });
    await failure(compute.create(sfo, ctx('k')));
    const action = [...emu.state.actions.values()].find((a) => a.resource_id === imported.id);
    action!.status = 'errored';
    await failure(compute.create(sfo, ctx('k')));
    const posts = emu.requests.filter(
      (r) => r.method === 'POST' && r.url.pathname === `/v2/images/${imported.id}/actions`,
    );
    expect(posts).toHaveLength(2);
  });
});

describe('GPU image guard', () => {
  it('vendors of sizes, models and images', () => {
    expect(gpuVendorOf('gpu-h100x1-80gb')).toBe('nvidia');
    expect(gpuVendorOf('gpu-l40sx1-48gb')).toBe('nvidia');
    expect(gpuVendorOf('gpu-6000adax1-48gb')).toBe('nvidia');
    expect(gpuVendorOf('nvidia_h100')).toBe('nvidia');
    expect(gpuVendorOf('gpu-mi300x1-192gb')).toBe('amd');
    expect(gpuVendorOf('amd_mi300x')).toBe('amd');
    expect(gpuVendorOf('gpu-amd-base')).toBe('amd');
    expect(gpuVendorOf('gpu-h100x1-base')).toBe('nvidia');
    expect(gpuVendorOf('s-2vcpu-4gb')).toBeUndefined();
  });

  it('an AI/ML image on a size without GPUs is refused before any request', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const compute = await build(emu);
    const error = await failure(compute.create(request({ image: 'gpu-h100x1-base' }), ctx()));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'gpuImage' });
    expect(emu.requests).toHaveLength(0);
  });

  it('an AI/ML image of the other vendor is refused; plain images boot GPU sizes', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const compute = await build(emu, { ...doAccount, regions: ['atl1'] });
    const amd = request({ offerId: 'atl1/gpu-mi300x1-192gb', image: 'gpu-h100x1-base' });
    const error = await failure(compute.create(amd, ctx('a')));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toMatchObject({ reason: 'gpuImage' });
    expect(emu.requests).toHaveLength(0);
    // The vendor's own AI/ML image and a plain OS image both go through.
    await compute.create(
      request({ offerId: 'atl1/gpu-h100x1-80gb', image: 'gpu-h100x1-base' }),
      ctx('b'),
    );
    await compute.create(
      request({ name: 'inst_2', offerId: 'atl1/gpu-mi300x1-192gb', image: 'ubuntu-24-04-x64' }),
      ctx('c'),
    );
    expect(dropletPosts(emu)).toHaveLength(2);
  });

  it('reinstall refuses an AI/ML image the droplet size cannot use', async () => {
    const emu = new DoEmulator({ now: () => t0 });
    const compute = await build(emu);
    const droplet = seedDroplet(emu.state, {
      tags: ['better-compute-managed:true', deploymentTag('default')],
    });
    const error = await failure(compute.reinstall(String(droplet.id), 'gpu-h100x1-base', ctx()));
    expect(error.details).toMatchObject({ reason: 'gpuImage' });
    expect(emu.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});
