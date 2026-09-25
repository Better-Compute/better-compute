import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { bcdArtifact, betterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { BASE_URL, options } from './support/server.js';

// The daemon downloads route (PLAN.md §6 "Release artifacts", §9.1): GET
// {basePath}/downloads/bcd/{version}/{os}-{arch} serves goreleaser's bare binary from a blob store
// or a directory, publicly (the install script checks the manifest's sha256), and nothing else.

let dir: string;
const database = pglite();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bc-downloads-'));
  await writeFile(join(dir, 'bcd_0.1.0_linux_amd64'), 'ELF-amd64');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await database.close();
});

const blob: BlobStore = {
  async get(key) {
    if (key !== 'bcd/0.2.0/bcd_0.2.0_linux_arm64') return undefined;
    return new Response('ELF-arm64').body!;
  },
  put: async () => undefined,
  delete: async () => undefined,
};

function server(downloads?: { dir?: string; blob?: BlobStore }) {
  return betterCompute({ ...options(database, fakeIam()), ...(downloads ? { downloads } : {}) });
}
const get = (compute: ReturnType<typeof server>, path: string) =>
  compute.handler(new Request(`${BASE_URL}/api/compute/${path}`));

describe('downloads', () => {
  it('serves bare binaries from the directory and the blob store, without credentials', async () => {
    const compute = server({ dir, blob });
    const amd64 = await get(compute, 'downloads/bcd/0.1.0/linux-amd64');
    expect(amd64.status).toBe(200);
    expect(await amd64.text()).toBe('ELF-amd64');
    expect(amd64.headers.get('content-type')).toBe('application/octet-stream');
    expect(amd64.headers.get('content-length')).toBe('9');
    expect(amd64.headers.get('cache-control')).toContain('immutable');
    // A leading v names the same release.
    expect((await get(compute, 'downloads/bcd/v0.1.0/linux-amd64')).status).toBe(200);
    const arm64 = await get(compute, 'downloads/bcd/0.2.0/linux-arm64');
    expect(await arm64.text()).toBe('ELF-arm64');
  });

  it('answers 404 for anything that is not a known artifact, and when not configured', async () => {
    const compute = server({ dir });
    for (const path of [
      'downloads/bcd/0.9.9/linux-amd64',
      'downloads/bcd/0.1.0/windows-amd64',
      'downloads/bcd/0.1.0/linux-riscv64',
      'downloads/bcd/..%2F..%2Fetc/linux-amd64',
      'downloads/bcd/0.1.0/../../x',
      'downloads/other/0.1.0/linux-amd64',
    ])
      expect((await get(compute, path)).status, path).toBe(404);
    expect((await get(server(), 'downloads/bcd/0.1.0/linux-amd64')).status).toBe(404);
    expect(bcdArtifact('downloads/bcd/1.2.3-rc.1/linux-arm64')).toEqual({
      version: '1.2.3-rc.1',
      file: 'bcd_1.2.3-rc.1_linux_arm64',
    });
  });

  it('refuses a downloads option without a source', () => {
    expect(() => server({})).toThrow(/downloads needs dir or blob/);
  });
});
