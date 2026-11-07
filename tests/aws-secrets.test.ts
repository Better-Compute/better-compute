import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pglite } from '@better-compute/postgres/pglite';
import { localSealedSecretStore, sealedSecretsMigration } from '@better-compute/pki';
import { ComputeError, type SecretRef, type SecretStore } from '@better-compute/core';
import {
  awsKmsSealingKeyCommand,
  awsParameterStore,
  awsSecretsManagerStore,
  generateKmsSealingKey,
  kmsSealingKeys,
  routeSecretStores,
} from '@better-compute/aws';
import { kmsFake } from './support/aws-platform-emulator/kms.js';
import { AwsEmulator, recordingLogger } from './support/aws-platform-emulator/index.js';
import { parameterStoreFake, secretsManagerFake } from './support/aws-platform-emulator/secrets.js';

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

  it('a local-sealed tenant named aws-sm keeps resolving through the fallback (review)', async () => {
    const { store: sm, emu } = smWorld();
    const local = memoryStore('local');
    // local-sealed refs are secret://<tenant>/<id>: tenant "aws-sm" looks like the route prefix.
    const legacy = await local.put('aws-sm', 'tenant-value');
    expect(legacy).toBe('secret://aws-sm/local-0');
    const routed = routeSecretStores({ routes: [{ prefix: 'secret://aws-sm/', store: sm }], fallback: local, putTo: sm });
    await expect(routed.resolve(legacy)).resolves.toBe('tenant-value');
    await routed.put('aws-sm', 'rotated', { ref: legacy });
    expect(local.values.get(legacy)).toBe('rotated');
    await routed.delete(legacy);
    expect(emu.requests).toHaveLength(0);
    // The AWS ref shape (two segments after the prefix) still goes to the store.
    const fresh = await routed.put('aws-sm', 'in-sm');
    await expect(routed.resolve(fresh)).resolves.toBe('in-sm');
  });

  it("tenant ids with '.' work in the AWS stores; '.', '..' and ':' are refused", async () => {
    const { store: sm } = smWorld();
    const ref = await sm.put('acme.eu', 'dotted');
    expect(ref.startsWith('secret://aws-sm/acme.eu/')).toBe(true);
    await expect(sm.resolve(ref, { tenantId: 'acme.eu' })).resolves.toBe('dotted');
    for (const tenantId of ['.', '..', 'acme:eu', 'a/b']) expect(await codeOf(sm.put(tenantId, 'x'))).toBe('INVALID_INPUT');
    expect(await codeOf(sm.resolve('secret://aws-sm/../x' as SecretRef))).toBe('INVALID_INPUT');
  });
});

describe('Parameter Store', () => {
  function ssmWorld(tier?: 'Standard' | 'Advanced') {
    const emu = new AwsEmulator();
    const fake = parameterStoreFake(emu);
    const log = recordingLogger();
    const store = awsParameterStore({
      region: 'eu-central-1',
      credentials: emu.credentials,
      fetch: emu.fetch,
      endpoint: 'http://emu.local',
      clock: emu.clock,
      log,
      kmsKeyId: 'alias/bc-params',
      ...(tier ? { tier } : {}),
    });
    return { emu, fake, store, log };
  }

  it('stores SecureString parameters under the tenant path', async () => {
    const { store, fake, emu, log } = ssmWorld();
    const ref = await store.put('t1', 'p4ssw0rd-value');
    expect(ref).toMatch(/^secret:\/\/aws-ssm\/t1\/[A-Za-z0-9_-]+$/);
    const [parameter] = [...fake.parameters.values()];
    expect(parameter).toMatchObject({
      name: `/better-compute/t1/${ref.split('/').at(-1)}`,
      type: 'SecureString',
      keyId: 'alias/bc-params',
      tier: 'Standard',
      tags: [{ Key: 'better-compute:tenant', Value: 't1' }],
    });
    await expect(store.resolve(ref, { tenantId: 't1' })).resolves.toBe('p4ssw0rd-value');
    await store.put('t1', 'rotated-value', { ref });
    await expect(store.resolve(ref)).resolves.toBe('rotated-value');
    await store.delete(ref);
    await expect(store.delete(ref)).resolves.toBeUndefined();
    expect(emu.calls('DeleteParameter')).toHaveLength(2);
    expect(log.text()).not.toContain('p4ssw0rd-value');
    expect(log.text()).not.toContain('rotated-value');
  });

  it('respects tier size limits', async () => {
    const standard = ssmWorld();
    expect(await codeOf(standard.store.put('t1', 'x'.repeat(4097)))).toBe('PAYLOAD_TOO_LARGE');
    await expect(standard.store.put('t1', 'x'.repeat(4096))).resolves.toBeDefined();
    const advanced = ssmWorld('Advanced');
    await expect(advanced.store.put('t1', 'x'.repeat(8192))).resolves.toBeDefined();
    expect(await codeOf(advanced.store.put('t1', 'x'.repeat(8193)))).toBe('PAYLOAD_TOO_LARGE');
    expect([...advanced.fake.parameters.values()][0]!.tier).toBe('Advanced');
  });

  it("refuses another tenant's ref without calling AWS", async () => {
    const { store, emu } = ssmWorld();
    expect(await codeOf(store.resolve('secret://aws-ssm/t2/x', { tenantId: 't1' }))).toBe('ACCESS_DENIED');
    expect(await codeOf(store.resolve('secret://aws-ssm/t1/../t2/x' as SecretRef))).toBe('INVALID_INPUT');
    expect(await codeOf(store.resolve('secret://aws-sm/t1/x', { tenantId: 't1' }))).toBe('INVALID_INPUT');
    expect(emu.requests).toHaveLength(0);
  });
});

describe('KMS sealing', () => {
  function kmsWorld() {
    const emu = new AwsEmulator();
    const kms = kmsFake(emu);
    kms.addSymmetricKey('sealing-key');
    const base = { region: 'us-east-1', credentials: emu.credentials, fetch: emu.fetch, endpoint: 'http://emu.local', clock: emu.clock };
    return { emu, kms, base };
  }

  it('round-trips a wrapped key into SealingKeys', async () => {
    const { base, emu } = kmsWorld();
    const k1 = await generateKmsSealingKey({ ...base, keyId: 'sealing-key' });
    const k2 = await generateKmsSealingKey({ ...base, keyId: 'sealing-key' });
    const keys = await kmsSealingKeys({ ...base, current: 'k2', wrapped: { k1, k2 } });
    expect(keys.current).toBe('k2');
    expect(Object.keys(keys.keys)).toEqual(['k1', 'k2']);
    expect((keys.keys.k1 as Uint8Array).length).toBe(32);
    expect(emu.calls('Decrypt')).toHaveLength(2);
    const db = pglite();
    await db.migrate([sealedSecretsMigration]);
    const store = localSealedSecretStore({ sql: db, keys });
    const ref = await store.put('t1', 'sealed-value');
    await expect(store.resolve(ref)).resolves.toBe('sealed-value');
    await db.close?.();
  });

  it('wrong encryption context is ACCESS_DENIED', async () => {
    const { base } = kmsWorld();
    const k1 = await generateKmsSealingKey({ ...base, keyId: 'sealing-key', encryptionContext: { purpose: 'other' } });
    expect(await codeOf(kmsSealingKeys({ ...base, current: 'k1', wrapped: { k1 } }))).toBe('ACCESS_DENIED');
    expect(await codeOf(kmsSealingKeys({ ...base, current: 'k9', wrapped: { k1 } }))).toBe('INVALID_CONFIG');
  });

  it('with keyId, Decrypt is pinned to that key: a blob wrapped under another key is refused (review)', async () => {
    const { base, kms, emu } = kmsWorld();
    kms.addSymmetricKey('other-key');
    const own = await generateKmsSealingKey({ ...base, keyId: 'sealing-key' });
    const foreign = await generateKmsSealingKey({ ...base, keyId: 'other-key' });
    const keys = await kmsSealingKeys({ ...base, keyId: 'sealing-key', current: 'k1', wrapped: { k1: own } });
    expect((keys.keys.k1 as Uint8Array).length).toBe(32);
    expect(JSON.parse(Buffer.from(emu.calls('Decrypt')[0]!.body).toString()).KeyId).toBe('sealing-key');
    expect(await codeOf(kmsSealingKeys({ ...base, keyId: 'sealing-key', current: 'k1', wrapped: { k1: own, k2: foreign } }))).toBe('ACCESS_DENIED');
    expect(await codeOf(kmsSealingKeys({ ...base, keyId: 'not a key id', current: 'k1', wrapped: { k1: own } }))).toBe('INVALID_CONFIG');
  });

  it('generate returns only ciphertext', async () => {
    const { base, kms, emu } = kmsWorld();
    const wrapped = await generateKmsSealingKey({ ...base, keyId: 'sealing-key' });
    expect(kms.minted).toHaveLength(1);
    expect(wrapped).not.toContain(kms.minted[0]);
    expect(Buffer.from(wrapped, 'base64').includes(Buffer.from(kms.minted[0]!, 'base64'))).toBe(false);
    expect(emu.calls('GenerateDataKeyWithoutPlaintext')).toHaveLength(1);
    expect(emu.calls('GenerateDataKey')).toHaveLength(0);
  });

  it('the CLI never prints plaintext', async () => {
    const { emu, kms } = kmsWorld();
    const out: string[] = [];
    const notes: string[] = [];
    const command = awsKmsSealingKeyCommand({ credentials: emu.credentials, fetch: emu.fetch, endpoint: 'http://emu.local', clock: emu.clock });
    expect(command.name).toBe('aws kms-sealing-key');
    const context = (flags: Record<string, string>) => ({ flags, io: { out: (m: string) => out.push(m) }, note: (m: string) => notes.push(m), path: (p: string) => p });
    await command.run(context({ 'key-id': 'sealing-key', region: 'us-east-1' }));
    expect(out).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), 'bc-aws-'));
    const file = join(dir, 'wrapped.txt');
    await command.run(context({ 'key-id': 'sealing-key', region: 'us-east-1', out: file }));
    expect(readFileSync(file, 'utf8').trim().length).toBeGreaterThan(0);
    await expect(command.run(context({ 'key-id': 'sealing-key', region: 'us-east-1', out: file }))).rejects.toThrow(/exists/);
    const printed = [...out, ...notes, readFileSync(file, 'utf8')].join(' ');
    for (const plaintext of kms.minted) {
      expect(printed).not.toContain(plaintext);
      expect(printed).not.toContain(Buffer.from(plaintext, 'base64').toString('hex'));
    }
    const keys = await kmsSealingKeys({ region: 'us-east-1', credentials: emu.credentials, fetch: emu.fetch, endpoint: 'http://emu.local', clock: emu.clock, current: 'k1', wrapped: { k1: out[0]! } });
    expect(Buffer.from(keys.keys.k1 as Uint8Array).toString('base64')).toBe(kms.minted[0]);
  });
});
