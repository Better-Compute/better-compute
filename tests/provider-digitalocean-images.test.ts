import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import { classifyImage, labels } from '@better-compute/provider-digitalocean';
import { seedDroplet } from './support/do-emulator/droplets.js';
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
