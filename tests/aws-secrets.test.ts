import { describe, expect, it } from 'vitest';
import { ComputeError, type SecretRef, type SecretStore } from '@better-compute/core';
import { awsSecretsManagerStore, routeSecretStores } from '@better-compute/aws';
import { AwsEmulator, recordingLogger } from './support/aws-platform-emulator/index.js';
import { secretsManagerFake } from './support/aws-platform-emulator/secrets.js';

function smWorld(options: { recoveryWindowDays?: number; cacheTtlMs?: number } = {}) {
  const emu = new AwsEmulator();
  const fake = secretsManagerFake(emu);
  const log = recordingLogger();
  const store = awsSecretsManagerStore({
    region: 'us-east-1',
    credentials: emu.credentials,
    fetch: emu.fetch,
    endpoint: 'http://emu.local',
    clock: emu.clock,
    log,
    kmsKeyId: 'alias/bc-secrets',
    ...options,
  });
  return { emu, fake, store, log };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ComputeError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('Secrets Manager', () => {
  it('put creates a tagged secret and returns a tenant-scoped ref', async () => {
    const { store, fake, emu } = smWorld();
    const ref = await store.put('t1', 'hunter2');
    expect(ref).toMatch(/^secret:\/\/aws-sm\/t1\/[A-Za-z0-9_-]+$/);
    const [secret] = [...fake.secrets.values()];
    expect(secret!.name).toBe(`better-compute/t1/${ref.split('/').at(-1)}`);
    expect(secret!.tags).toEqual([{ Key: 'better-compute:tenant', Value: 't1' }]);
    expect(secret!.kmsKeyId).toBe('alias/bc-secrets');
    expect(emu.calls('CreateSecret')).toHaveLength(1);
  });

  it('resolve returns the value', async () => {
    const { store } = smWorld();
    const ref = await store.put('t1', 'hunter2');
    await expect(store.resolve(ref)).resolves.toBe('hunter2');
    await expect(store.resolve(ref, { tenantId: 't1' })).resolves.toBe('hunter2');
  });

  it('rotates in place with PutSecretValue, only for its own tenant', async () => {
    const { store, emu } = smWorld();
    const ref = await store.put('t1', 'v1');
    await expect(store.put('t1', 'v2', { ref })).resolves.toBe(ref);
    expect(emu.calls('PutSecretValue')).toHaveLength(1);
    await expect(store.resolve(ref)).resolves.toBe('v2');
    expect(await codeOf(store.put('t2', 'evil', { ref }))).toBe('ACCESS_DENIED');
  });

  it("refuses another tenant's ref without calling AWS", async () => {
    const { store, emu } = smWorld();
    const before = emu.requests.length;
    expect(await codeOf(store.resolve('secret://aws-sm/t2/x', { tenantId: 't1' }))).toBe('ACCESS_DENIED');
    expect(emu.requests.length).toBe(before);
  });

  it('refuses path injection', async () => {
    const { store, emu } = smWorld();
    for (const ref of [
      'secret://aws-sm/t1/../t2/x',
      'secret://aws-sm/t1/a/b',
      'secret://aws-sm//x',
      'secret://aws-sm/t1/..',
      'secret://aws-sm/t1/a%2Fb',
      'secret://other/t1/x',
    ])
      expect(await codeOf(store.resolve(ref as SecretRef, { tenantId: 't1' }))).toBe('INVALID_INPUT');
    expect(await codeOf(store.put('../t2', 'x'))).toBe('INVALID_INPUT');
    expect(emu.requests).toHaveLength(0);
  });

  it('delete uses the recovery window and tolerates a missing secret', async () => {
    const { store, fake } = smWorld({ recoveryWindowDays: 14 });
    const ref = await store.put('t1', 'x');
    await store.delete(ref);
    expect(fake.deletions).toEqual([{ name: expect.stringMatching(/^better-compute\/t1\//), recoveryWindowDays: 14, force: undefined }]);
    await expect(store.delete(ref)).resolves.toBeUndefined();
    const force = smWorld({ recoveryWindowDays: 0 });
    await force.store.delete(await force.store.put('t1', 'x'));
    expect(force.fake.deletions[0]!.force).toBe(true);
    expect(() => smWorld({ recoveryWindowDays: 3 })).toThrow(/recoveryWindowDays/);
  });

  it('values over 64 KiB are refused', async () => {
    const { store, emu } = smWorld();
    expect(await codeOf(store.put('t1', 'x'.repeat(64 * 1024 + 1)))).toBe('PAYLOAD_TOO_LARGE');
    await expect(store.put('t1', 'x'.repeat(64 * 1024))).resolves.toBeDefined();
    expect(emu.calls('CreateSecret')).toHaveLength(1);
  });

  it('a SecretBinary-only secret is INVALID_STATE', async () => {
    const { store, fake } = smWorld();
    fake.secrets.set('better-compute/t1/bin', { name: 'better-compute/t1/bin', binary: 'AAEC', tags: [], versions: 1 });
    expect(await codeOf(store.resolve('secret://aws-sm/t1/bin'))).toBe('INVALID_STATE');
  });

  it('caches resolved values for cacheTtlMs', async () => {
    const { store, emu } = smWorld({ cacheTtlMs: 60_000 });
    const ref = await store.put('t1', 'v');
    await store.resolve(ref);
    await store.resolve(ref);
    expect(emu.calls('GetSecretValue')).toHaveLength(1);
    emu.clock.advance(60_001);
    await store.resolve(ref);
    expect(emu.calls('GetSecretValue')).toHaveLength(2);
  });

  it('never logs secret values', async () => {
    const { store, log } = smWorld();
    const ref = await store.put('t1', 'sup3r-s3cret-value');
    await store.resolve(ref);
    await store.put('t1', 'r0tated-s3cret', { ref });
    await store.delete(ref);
    await store.resolve(ref).catch(() => undefined);
    expect(log.entries.length).toBeGreaterThan(0);
    for (const leaked of ['sup3r-s3cret-value', 'r0tated-s3cret', 'testsecret', 'AKIATESTKEY'])
      expect(log.text()).not.toContain(leaked);
  });
});

describe('routing', () => {
  function memoryStore(id: string): SecretStore & { values: Map<string, string> } {
    const values = new Map<string, string>();
    let next = 0;
    return {
      id,
      schemes: ['secret'],
      values,
      async put(tenantId, value, options) {
        const ref = options?.ref ?? (`secret://${tenantId}/${id}-${next++}` as SecretRef);
        values.set(ref, value);
        return ref;
      },
      async resolve(ref) {
        const value = values.get(ref);
        if (value === undefined) throw new ComputeError('NOT_FOUND', 'no secret');
        return value;
      },
      async delete(ref) {
        values.delete(ref);
      },
    };
  }

  it('routing sends aws-sm refs to Secrets Manager and others to the fallback', async () => {
    const { store: sm, emu } = smWorld();
    const local = memoryStore('local');
    const legacy = await local.put('t1', 'old-value');
    const routed = routeSecretStores({ routes: [{ prefix: 'secret://aws-sm/', store: sm }], fallback: local, putTo: sm });
    expect(routed.schemes).toEqual(['secret']);
    const fresh = await routed.put('t1', 'new-value');
    expect(fresh.startsWith('secret://aws-sm/t1/')).toBe(true);
    await expect(routed.resolve(fresh)).resolves.toBe('new-value');
    await expect(routed.resolve(legacy)).resolves.toBe('old-value');
    await routed.put('t1', 'old-rotated', { ref: legacy });
    expect(local.values.get(legacy)).toBe('old-rotated');
    await routed.delete(legacy);
    expect(local.values.has(legacy)).toBe(false);
    expect(emu.calls('CreateSecret')).toHaveLength(1);
    expect(() => routeSecretStores({ routes: [{ prefix: 'aws-sm', store: sm }], fallback: local, putTo: sm })).toThrow(ComputeError);
  });
});
