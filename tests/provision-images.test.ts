import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiSurface, type AuthzRow, type AuthzWriter, type MethodContext, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  addImageSigner,
  evictionCandidates,
  imageSigningInput,
  imagesCachedAt,
  provisionMigrations,
  provisionModule,
  recordImageLocation,
  resolveImageRef,
  revokeImageSigner,
  touchImageLocation,
  verifyImageForUse,
  type ProvisionApi,
  type RegisterImageInput,
} from '@better-compute/provision';

// The image catalog (PLAN.md §11.5): digests, signer allowlists, promotion and site caches.

let db: SqlExecutor;
let api: ProvisionApi;
let context: MethodContext;
const authzRows: AuthzRow[] = [];
const authz: AuthzWriter = {
  async upsert(_tx, row) {
    authzRows.push(row);
  },
  async remove() {},
  async setPending() {},
};

const platformKey = generateKeyPairSync('ed25519');
const tenantKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const strangerKey = generateKeyPairSync('ed25519');
const pem = (key: { publicKey: { export(o: object): string | Buffer } }) =>
  key.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const digest = (n: number) => n.toString(16).padStart(64, '0');
const image = (ref: string, extra: Partial<RegisterImageInput> = {}): RegisterImageInput => ({
  ref,
  format: 'raw',
  compression: 'zstd',
  sha256: digest(ref.length),
  source: `https://images.example.com/${ref}`,
  ...extra,
});
function signed(input: RegisterImageInput, key: typeof platformKey | typeof tenantKey, signerId: string): RegisterImageInput {
  const data = imageSigningInput(input);
  const signature = key === tenantKey ? sign('sha256', data, key.privateKey) : sign(null, data, key.privateKey);
  return { ...input, signature: signature.toString('base64'), signerId };
}
async function call<M extends keyof ProvisionApi['images']>(method: M, input: unknown) {
  const definition = api.images[method] as unknown as { validate(i: unknown): unknown; handler(c: MethodContext, i: unknown): Promise<any> };
  return definition.handler(context, definition.validate(input));
}

beforeAll(async () => {
  db = pglite();
  await db.migrate(provisionMigrations);
  await db.transaction(async (tx) => {
    await addImageSigner(tx, { tenantId: 'root', id: 'platform', algorithm: 'ed25519', publicKey: pem(platformKey) });
    await addImageSigner(tx, { tenantId: 'ten_a', id: 'team', algorithm: 'ecdsa-p256', publicKey: pem(tenantKey) });
  });
  context = { sql: db, authz, iam: { rootTenantId: 'root' } } as unknown as MethodContext;
  api = provisionModule().api!(context);
});
afterAll(() => db.close());

describe('the §9.2 images rows', () => {
  it('declares exactly the images rows', () => {
    const rows = apiSurface.filter((row) => row.group === 'images');
    expect(Object.keys(api.images).sort()).toEqual(rows.map((row) => row.method).sort());
    for (const row of rows) {
      const method = api.images[row.method as keyof ProvisionApi['images']];
      expect([method.action, method.kind, method.resource({ tenantId: 't', imageId: 'img_x' } as never)?.type]).toEqual([row.action, row.kind, row.resource]);
    }
  });
});

describe('register', () => {
  it('records an unsigned image as private and unverified', async () => {
    const registered = await call('register', { tenantId: 'ten_a', ...image('scratch@1') });
    expect(registered).toMatchObject({ ref: 'scratch@1', kind: 'os', verified: false, visibility: 'private', compression: 'zstd' });
    expect(registered.id).toMatch(/^img_/);
    expect(authzRows.at(-1)).toMatchObject({ type: 'image', id: registered.id, tenantId: 'ten_a', attributes: { verified: false } });
    await expect(call('register', { tenantId: 'ten_a', ...image('scratch@1') })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Another tenant may use the same ref.
    await call('register', { tenantId: 'ten_b', ...image('scratch@1') });
  });

  it('verifies signatures by the tenant or the platform, and rejects anyone else', async () => {
    const byTeam = await call('register', { tenantId: 'ten_a', ...signed(image('team-os@2026.09'), tenantKey, 'team') });
    expect(byTeam).toMatchObject({ verified: true, signerId: 'team' });
    const byPlatform = await call('register', { tenantId: 'ten_a', ...signed(image('ubuntu@2026.09'), platformKey, 'platform') });
    expect(byPlatform.verified).toBe(true);
    // ten_b cannot use ten_a's signer.
    await expect(
      call('register', { tenantId: 'ten_b', ...signed(image('team-os@2026.09'), tenantKey, 'team') }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      call('register', { tenantId: 'ten_a', ...signed(image('forged@1'), strangerKey, 'platform') }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // The signature covers the digest.
    const tampered = { ...signed(image('tampered@1'), platformKey, 'platform'), sha256: digest(999) };
    await expect(call('register', { tenantId: 'ten_a', ...tampered })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call('register', { tenantId: 'ten_a', ...image('half@1'), signerId: 'team' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('accepts only platform-signed ramdisks', async () => {
    const ramdisk = image('ramdisk@1', { kind: 'ramdisk', format: 'raw' });
    await expect(call('register', { tenantId: 'ten_a', ...ramdisk })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call('register', { tenantId: 'ten_a', ...signed(ramdisk, tenantKey, 'team') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await call('register', { tenantId: 'root', ...signed(ramdisk, platformKey, 'platform') })).kind).toBe('ramdisk');
  });

  it('stops verifying with a revoked signer', async () => {
    await db.transaction((tx) => addImageSigner(tx, { tenantId: 'ten_a', id: 'old', algorithm: 'ed25519', publicKey: pem(strangerKey) }));
    await db.transaction((tx) => revokeImageSigner(tx, 'ten_a', 'old'));
    await expect(call('register', { tenantId: 'ten_a', ...signed(image('late@1'), strangerKey, 'old') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      db.transaction((tx) => addImageSigner(tx, { tenantId: 'ten_a', id: 'wrong', algorithm: 'ed25519', publicKey: pem(tenantKey) })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('validates the request', async () => {
    for (const bad of [
      { ...image('x@1'), sha256: 'abc' },
      { ...image('no-version'), sha256: digest(1) },
      { ...image('x@2'), source: 'ftp://x' },
      { ...image('x@3'), format: 'vmdk' },
    ])
      await expect(call('register', { tenantId: 'ten_a', ...bad })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('a pluggable verifier', () => {
  it('lets a deployment swap the allowlist check (Sigstore, a KMS) without touching the catalog', async () => {
    const seen: string[] = [];
    const custom = provisionModule({
      imageVerifier: async (_tx, input) => {
        seen.push(`${input.signerId}:${input.tenants.join(',')}`);
        return input.signerId === 'sigstore' ? { tenantId: 'root' } : undefined;
      },
    }).api!(context);
    const register = (input: unknown) =>
      (custom.images.register as unknown as { validate(i: unknown): unknown; handler(c: MethodContext, i: unknown): Promise<any> }).handler(
        context,
        custom.images.register.validate(input),
      );
    const ok = await register({ tenantId: 'ten_v', ...image('keyless@1'), signature: 'AAAA', signerId: 'sigstore' });
    expect(ok.verified).toBe(true);
    await expect(register({ tenantId: 'ten_v', ...image('keyless@2'), signature: 'AAAA', signerId: 'nobody' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(seen).toEqual(['sigstore:ten_v,root', 'nobody:ten_v,root']);
  });
});

describe('get, list, promote', () => {
  it('promotes only verified images, and then every tenant sees them', async () => {
    const unsigned = await call('register', { tenantId: 'ten_a', ...image('private-only@1') });
    await expect(call('promote', { tenantId: 'ten_a', imageId: unsigned.id })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const signedImage = await call('register', { tenantId: 'ten_a', ...signed(image('shared@1'), platformKey, 'platform') });
    await expect(call('get', { tenantId: 'ten_c', imageId: signedImage.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const promoted = await call('promote', { tenantId: 'ten_a', imageId: signedImage.id });
    expect(promoted.visibility).toBe('public');
    expect(authzRows.at(-1)).toMatchObject({ type: 'image', id: signedImage.id, tenantId: '*' });
    expect((await call('get', { tenantId: 'ten_c', imageId: signedImage.id })).ref).toBe('shared@1');
    expect((await resolveImageRef(db, 'ten_c', 'shared@1'))?.id).toBe(signedImage.id);
    expect(await resolveImageRef(db, 'ten_c', 'private-only@1')).toBeUndefined();
    await expect(call('promote', { tenantId: 'ten_c', imageId: signedImage.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists own and public images by ref, in pages, filtered by kind', async () => {
    const first = await call('list', { tenantId: 'ten_c', limit: 1 });
    expect(first.items.map((i: { ref: string }) => i.ref)).toEqual(['shared@1']);
    const mine = await call('list', { tenantId: 'ten_a', limit: 3 });
    expect(mine.items).toHaveLength(3);
    const next = await call('list', { tenantId: 'ten_a', limit: 100, cursor: mine.cursor });
    const refs = [...mine.items, ...next.items].map((i: { ref: string }) => i.ref);
    expect(refs).toEqual([...refs].sort());
    expect(new Set(refs).size).toBe(refs.length);
    expect((await call('list', { tenantId: 'ten_a', kind: 'ramdisk' })).items).toEqual([]);
  });
});

describe('verifyImageForUse (deploy time, v0.2 exit)', () => {
  it('passes a signed image, and refuses unsigned ones and revoked signers', async () => {
    const good = await call('register', { tenantId: 'ten_a', ...signed(image('use-ok@1'), tenantKey, 'team') });
    expect((await verifyImageForUse(db, good)).ref).toBe('use-ok@1');
    const unsigned = await call('register', { tenantId: 'ten_a', ...image('use-unsigned@1') });
    await expect(verifyImageForUse(db, unsigned)).rejects.toMatchObject({ code: 'INVALID_STATE', details: { reason: 'unsigned' } });
    // Development escape hatch: private unsigned images only.
    expect((await verifyImageForUse(db, unsigned, { allowUnsigned: true })).id).toBe(unsigned.id);
    await db.transaction((tx) => addImageSigner(tx, { tenantId: 'ten_a', id: 'short-lived', algorithm: 'ed25519', publicKey: pem(strangerKey) }));
    const later = await call('register', { tenantId: 'ten_a', ...signed(image('use-later@1'), strangerKey, 'short-lived') });
    expect(later.verified).toBe(true);
    await db.transaction((tx) => revokeImageSigner(tx, 'ten_a', 'short-lived'));
    for (const options of [{}, { allowUnsigned: true }])
      await expect(verifyImageForUse(db, later, options)).rejects.toMatchObject({ code: 'INVALID_STATE', details: { reason: 'signature' } });
    // A tampered row (digest swapped after registration) no longer matches its signature.
    await db.query(`UPDATE images SET sha256 = $2 WHERE id = $1`, [good.id, digest(4242)]);
    await expect(verifyImageForUse(db, good)).rejects.toMatchObject({ details: { reason: 'signature' } });
    await expect(verifyImageForUse(db, { id: 'img_missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('site caches', () => {
  it('tracks ready images per site and picks LRU eviction candidates, sparing pinned and in-use ones', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) ids.push((await call('register', { tenantId: 'ten_a', ...image(`cache-${n}@1`) })).id);
    for (const [i, id] of ids.entries())
      await db.transaction((tx) => recordImageLocation(tx, { imageId: id, siteId: 'site_a', state: i === 3 ? 'pulling' : 'ready', sizeBytes: 10 }));
    expect(await imagesCachedAt(db, 'site_a')).toEqual(new Set(ids.slice(0, 3)));
    await db.query(`UPDATE image_locations SET last_used_at = last_used_at - make_interval(secs => $2) WHERE image_id = $1`, [ids[0], 30]);
    await db.query(`UPDATE image_locations SET last_used_at = last_used_at - make_interval(secs => $2) WHERE image_id = $1`, [ids[1], 20]);
    await db.transaction((tx) => touchImageLocation(tx, ids[0]!, 'site_a', true));

    const picked = await evictionCandidates(db, 'site_a', 15);
    expect(picked.map((p) => p.imageId)).toEqual([ids[1], ids[2]]);
    expect((await evictionCandidates(db, 'site_a', 15, new Set([ids[1]!]))).map((p) => p.imageId)).toEqual([ids[2]]);
  });
});
