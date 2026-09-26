import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandSpec } from '@better-compute/cli';
import { spkiPin } from '@better-compute/pki';
import {
  kubernetesManifestCommand,
  type ManifestCommandContext,
} from '@better-compute/provider-kubernetes';

// `kubernetes manifest` (PLAN.md §3.8), shipped with the provider (the CLI never imports providers): a hosted
// join token goes only to a 0600 Secret file; the manifests carry the well-known gateway, pins and join key.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const encryption = key();
const signing = key();
const serving = key();
const wellKnown = {
  gateway: {
    url: 'https://gw.eu.example.com',
    serverName: 'gw.internal',
    servingCaPin: spkiPin(serving.publicKey),
  },
  join: {
    encryptionJwk: encryption.publicKey.export({ format: 'jwk' }),
    encryptionKeyPin: spkiPin(encryption.publicKey),
    signingKeyPin: spkiPin(signing.publicKey),
  },
};
const image = `ghcr.io/acme/bcd:0.5.0@sha256:${'ab'.repeat(32)}`;
// The operator's out-of-band anchors (the PKI bundle's pins): the only pins the manifests carry.
const pinFlags = {
  'serving-ca-pin': spkiPin(serving.publicKey),
  'join-signing-pin': spkiPin(signing.publicKey),
  'join-encryption-pin': spkiPin(encryption.publicKey),
};

function harness(
  flags: Record<string, string | number | boolean | undefined>,
  token: string | null = 'bcjt_join_secret123',
  document: unknown = wellKnown,
  commandOptions: Parameters<typeof kubernetesManifestCommand>[0] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'k8s-manifest-'));
  dirs.push(dir);
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const out: string[] = [];
  const notes: string[] = [];
  const fetched: string[] = [];
  const context: ManifestCommandContext = {
    flags: {
      tenant: 'tenant-root',
      pool: 'pool_1',
      image,
      'secret-out': 'join.json',
      ...pinFlags,
      ...flags,
    },
    path: (value) => join(dir, value),
    note: (message) => notes.push(message),
    io: { out: (message) => out.push(message) },
    api: async () => ({
      call: async <T>(path: string, input?: Record<string, unknown>) => {
        calls.push([path, input]);
        if (path === 'pools/get') return { id: 'pool_1', siteId: 'site_1' } as T;
        return { id: 'jt_1', expiresAt: '2026-09-27T00:00:00Z', ...(token ? { token } : {}) } as T;
      },
    }),
    compute: async () => ({
      endpoint: { basePath: '/api/compute' },
      handler: async (request: Request) => {
        fetched.push(new URL(request.url).pathname);
        return Response.json(document);
      },
    }),
  };
  const command = kubernetesManifestCommand({
    fetch: (async (url: string) => {
      fetched.push(String(url));
      return Response.json(document);
    }) as typeof fetch,
    ...commandOptions,
  });
  return { dir, context, command, calls, out, notes, fetched };
}

describe('kubernetes manifest', () => {
  it('is a CLI command an application adds to its configuration', () => {
    const spec: CommandSpec<any> = kubernetesManifestCommand() as unknown as CommandSpec<any>;
    expect(spec.name).toBe('kubernetes manifest');
    expect(Object.keys(spec.flags ?? {})).toEqual(
      expect.arrayContaining(['pool', 'image', 'secret-out', 'control-plane', 'gpu-api']),
    );
  });

  it('writes the token only to a 0600 Secret file and prints manifests without it', async () => {
    const h = harness({
      'max-uses': 12,
      ttl: '2h',
      'node-selector': 'nvidia.com/gpu.present=true',
      'gpu-api': 'dra',
    });
    expect(await h.command.run(h.context)).toBeUndefined();
    // The well-known document came from the configured deployment.
    expect(h.fetched).toEqual(['/api/compute/.well-known/better-compute']);
    expect(h.calls.map(([path]) => path)).toEqual(['pools/get', 'joinTokens/create']);
    expect(h.calls[1]![1]).toMatchObject({
      tenantId: 'tenant-root',
      poolId: 'pool_1',
      ttlSeconds: 7200,
      maxUses: 12,
      hosted: 'kubernetes',
    });

    const secretFile = join(h.dir, 'join.json');
    if (process.platform !== 'win32') expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    const secret = JSON.parse(readFileSync(secretFile, 'utf8'));
    expect(JSON.stringify(secret)).toContain('bcjt_join_secret123');
    expect(JSON.stringify(secret)).toContain('"kind":"Secret"');

    const manifests = h.out.join('\n');
    expect(manifests).not.toContain('bcjt_join_secret123');
    expect(manifests).toContain('DaemonSet');
    expect(manifests).toContain('https://gw.eu.example.com');
    expect(manifests).toContain(wellKnown.join.encryptionKeyPin);
    expect(manifests).toContain('bcd-join-token');
    expect(manifests).toContain('nvidia.com/gpu.present');
    expect(manifests).toContain('gpu_api');
    expect(h.notes.join('\n')).toContain('0600');
    // The operator is told to retire the token once the nodes joined, and what isolation bcd needs.
    expect(h.notes.join('\n')).toContain('join-tokens revoke jt_1');
    expect(h.notes.join('\n')).toContain('devicePlugin.enabled=false');
    expect(manifests).toMatch(/"runtimeClassName":\s*"nvidia"/);
    const bare = harness({ 'nvidia-runtime-class': 'none' });
    await bare.command.run(bare.context);
    expect(bare.out.join('\n')).not.toContain('runtimeClassName');
  });

  it('reads --control-plane over https and writes --out to a new file', async () => {
    const h = harness({
      'control-plane': 'https://compute.example.com/api/compute',
      out: 'bcd.json',
    });
    const result = (await h.command.run(h.context)) as Record<string, unknown>;
    expect(h.fetched).toEqual([
      'https://compute.example.com/api/compute/.well-known/better-compute',
    ]);
    expect(result).toMatchObject({
      poolId: 'pool_1',
      siteId: 'site_1',
      namespace: 'bcd-system',
      tokenId: 'jt_1',
    });
    expect(readFileSync(join(h.dir, 'bcd.json'), 'utf8')).toContain(
      'https://compute.example.com/api/compute',
    );
    // Never over an existing file.
    const again = harness({ out: 'bcd.json' });
    again.context.path = h.context.path;
    await expect(again.command.run(again.context)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('never takes its pins from the control plane', async () => {
    // Well-known only (no operator pins): refused before any call.
    const bare = harness({
      'serving-ca-pin': undefined,
      'join-signing-pin': undefined,
      'join-encryption-pin': undefined,
    });
    await expect(bare.command.run(bare.context)).rejects.toThrow(/pki show/);
    expect(bare.calls).toEqual([]);
    const partial = harness({ 'join-signing-pin': undefined });
    await expect(partial.command.run(partial.context)).rejects.toThrow(/go together/);

    // A document that answers with someone else's keys and pins: the manifests keep the operator's pins, and
    // the join key that does not match them is refused before a token exists.
    const intruder = key();
    const forged = {
      gateway: { url: 'https://gw.eu.example.com', servingCaPin: spkiPin(intruder.publicKey) },
      join: {
        encryptionJwk: intruder.publicKey.export({ format: 'jwk' }),
        encryptionKeyPin: spkiPin(intruder.publicKey),
        signingKeyPin: spkiPin(intruder.publicKey),
      },
    };
    const mitm = harness({}, 'bcjt_join_secret123', forged);
    await expect(mitm.command.run(mitm.context)).rejects.toThrow(/joinEncryption|pin/i);
    expect(mitm.calls.map(([path]) => path)).not.toContain('joinTokens/create');

    // An application may supply its own bundle's pins instead of flags.
    const app = harness(
      {
        'serving-ca-pin': undefined,
        'join-signing-pin': undefined,
        'join-encryption-pin': undefined,
      },
      'bcjt_join_secret123',
      wellKnown,
      {
        pins: {
          servingCaPin: pinFlags['serving-ca-pin'],
          joinSigningPin: pinFlags['join-signing-pin'],
          joinEncryptionPin: pinFlags['join-encryption-pin'],
        },
      },
    );
    await app.command.run(app.context);
    const manifests = app.out.join('\n');
    expect(manifests).toContain(pinFlags['serving-ca-pin']);
    expect(manifests).not.toContain(spkiPin(intruder.publicKey));
  });

  it('refuses before minting when the inputs are wrong, and a replayed key', async () => {
    const bad = harness({ image: 'ghcr.io/acme/bcd:latest' });
    await expect(bad.command.run(bad.context)).rejects.toThrow(/digest|image/);
    expect(bad.calls.map(([path]) => path)).toEqual(['pools/get']);
    const http = harness({ 'control-plane': 'http://compute.example.com' });
    await expect(http.command.run(http.context)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const replay = harness({ key: 'k1' }, null);
    await expect(replay.command.run(replay.context)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});
