import { createPublicKey, verify } from 'node:crypto';
import {
  ComputeError,
  newId,
  type AuthzWriter,
  type Image,
  type ImageCompression,
  type ImageFormat,
  type SqlTx,
} from '@better-compute/core';

// The image catalog (PLAN.md §11.5): images are registered by digest; a signature by a signer on
// the tenant's allowlist (or the platform's) makes them verified. Unsigned images stay private,
// ramdisks are platform-signed only, and only verified images can be promoted to public.

export type ImageKind = 'os' | 'ramdisk';
export type SignerAlgorithm = 'ed25519' | 'ecdsa-p256';

/** A catalog image with its kind and source. */
export interface CatalogImage extends Image {
  kind: ImageKind;
  source: string;
  signerId?: string;
  createdAt: number;
}

export interface RegisterImageInput {
  ref: string;
  kind?: ImageKind;
  format: ImageFormat;
  compression?: ImageCompression;
  sha256: string;
  sizeBytes?: number;
  source: string;
  /** Base64 signature over `imageSigningInput(...)`. */
  signature?: string;
  signerId?: string;
}

const refPattern = /^[^\s@]{1,128}@[^\s@]{1,64}$/;
const sourcePattern = /^(https|oci):\/\/[^\s]{1,2040}$/;

/**
 * What an image signature covers: the tenant-independent identity of the artifact. A signer signs
 * these UTF-8 bytes with Ed25519, or with ECDSA P-256 over SHA-256.
 */
export function imageSigningInput(image: Pick<RegisterImageInput, 'ref' | 'format' | 'compression' | 'sha256'> & { kind?: ImageKind }): Uint8Array {
  return new TextEncoder().encode(
    `bc-image-v1\n${image.kind ?? 'os'}\n${image.ref}\n${image.format}\n${image.compression ?? 'none'}\n${image.sha256.toLowerCase()}\n`,
  );
}

interface ImageRow {
  id: string;
  tenant_id: string;
  ref: string;
  kind: ImageKind;
  format: ImageFormat;
  compression: ImageCompression;
  sha256: string;
  size_bytes: number | null;
  source: string;
  signer_id: string | null;
  verified: boolean;
  visibility: 'private' | 'public';
  created_at: Date;
  version: number;
}

function toImage(row: ImageRow): CatalogImage {
  const image: CatalogImage = {
    id: row.id,
    tenantId: row.tenant_id,
    ref: row.ref,
    kind: row.kind,
    format: row.format,
    compression: row.compression,
    sha256: row.sha256,
    source: row.source,
    visibility: row.visibility,
    verified: row.verified,
    createdAt: row.created_at.getTime(),
    version: Number(row.version),
  };
  if (row.size_bytes !== null) image.sizeBytes = Number(row.size_bytes);
  if (row.signer_id) image.signerId = row.signer_id;
  return image;
}

const columns = 'id, tenant_id, ref, kind, format, compression, sha256, size_bytes, source, signer_id, verified, visibility, created_at, version';

/** Adds a signer to a tenant's allowlist (the root tenant's signers are the platform's). */
export async function addImageSigner(
  tx: SqlTx,
  input: { tenantId: string; id: string; algorithm: SignerAlgorithm; publicKey: string },
): Promise<void> {
  let key;
  try {
    key = createPublicKey(input.publicKey);
  } catch {
    throw new ComputeError('INVALID_INPUT', 'publicKey must be an SPKI PEM public key');
  }
  const type = key.asymmetricKeyType;
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (input.algorithm === 'ed25519' ? type !== 'ed25519' : type !== 'ec' || curve !== 'prime256v1')
    throw new ComputeError('INVALID_INPUT', `publicKey is not an ${input.algorithm} key`);
  const inserted = await tx.query(
    `INSERT INTO image_signers (tenant_id, id, algorithm, public_key) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [input.tenantId, input.id, input.algorithm, key.export({ type: 'spki', format: 'pem' }).toString()],
  );
  if (inserted.rowCount === 0) throw new ComputeError('CONFLICT', `Signer ${input.id} already exists`);
}

/** Revokes a signer; images it verified keep their flag (re-verify by registering again). */
export async function revokeImageSigner(tx: SqlTx, tenantId: string, id: string): Promise<void> {
  const result = await tx.query(
    'UPDATE image_signers SET revoked_at = compute_now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL',
    [tenantId, id],
  );
  if (result.rowCount === 0) throw new ComputeError('NOT_FOUND', `Signer ${id} does not exist`);
}

/** Checks a signature against the named signer of `tenantId` or of the platform (`rootTenantId`). */
async function verifySignature(
  tx: SqlTx,
  tenants: readonly string[],
  signerId: string,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<{ tenantId: string } | undefined> {
  const { rows } = await tx.query<{ tenant_id: string; algorithm: SignerAlgorithm; public_key: string }>(
    `SELECT tenant_id, algorithm, public_key FROM image_signers
      WHERE id = $1 AND tenant_id = ANY($2) AND revoked_at IS NULL`,
    [signerId, tenants],
  );
  for (const row of rows) {
    const key = createPublicKey(row.public_key);
    const ok =
      row.algorithm === 'ed25519'
        ? verify(null, data, key, signature)
        : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature) ||
          verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
    if (ok) return { tenantId: row.tenant_id };
  }
  return undefined;
}

/**
 * `images.register`: records an image by digest. With a signature it must verify against the
 * named signer of the tenant or of the platform, else `INVALID_INPUT`. Ramdisks must be signed by
 * a platform signer. `CONFLICT` if the tenant already has that ref.
 */
export async function registerImage(
  tx: SqlTx,
  authz: AuthzWriter | undefined,
  tenantId: string,
  rootTenantId: string,
  input: RegisterImageInput,
): Promise<CatalogImage> {
  if (!refPattern.test(input.ref)) throw new ComputeError('INVALID_INPUT', 'ref must be name@version');
  const sha256 = input.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ComputeError('INVALID_INPUT', 'sha256 must be 64 hex digits');
  if (!sourcePattern.test(input.source)) throw new ComputeError('INVALID_INPUT', 'source must be an https:// or oci:// URL');
  const kind = input.kind ?? 'os';
  let verified = false;
  let signature: Uint8Array | null = null;
  let signerTenant: string | null = null;
  if (input.signature !== undefined || input.signerId !== undefined) {
    if (!input.signature || !input.signerId) throw new ComputeError('INVALID_INPUT', 'signature and signerId go together');
    signature = Uint8Array.from(Buffer.from(input.signature, 'base64'));
    const signer = await verifySignature(
      tx,
      kind === 'ramdisk' ? [rootTenantId] : [...new Set([tenantId, rootTenantId])],
      input.signerId,
      imageSigningInput({ ...input, kind, sha256 }),
      signature,
    );
    if (!signer) throw new ComputeError('INVALID_INPUT', `The signature does not verify against signer ${input.signerId}`);
    verified = true;
    signerTenant = signer.tenantId;
  }
  if (kind === 'ramdisk' && !verified)
    throw new ComputeError('INVALID_INPUT', 'A ramdisk must be signed by a platform signer');
  const inserted = await tx.query<ImageRow>(
    `INSERT INTO images (id, tenant_id, ref, kind, format, compression, sha256, size_bytes, source, signature,
       signer_tenant_id, signer_id, verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING
     RETURNING ${columns}`,
    [
      newId('img'),
      tenantId,
      input.ref,
      kind,
      input.format,
      input.compression ?? 'none',
      sha256,
      input.sizeBytes ?? null,
      input.source,
      signature,
      signerTenant,
      verified ? input.signerId : null,
      verified,
    ],
  );
  if (!inserted.rows[0]) throw new ComputeError('CONFLICT', `Image ${input.ref} is already registered`);
  const image = toImage(inserted.rows[0]);
  await authz?.upsert(tx, {
    type: 'image',
    id: image.id,
    tenantId,
    attributes: { kind, format: image.format, verified, visibility: 'private' },
  });
  return image;
}

/** An image the tenant owns, or a public one. */
export async function readImage(tx: SqlTx, tenantId: string, imageId: string): Promise<CatalogImage> {
  const { rows } = await tx.query<ImageRow>(
    `SELECT ${columns} FROM images WHERE id = $1 AND deleted_at IS NULL AND (tenant_id = $2 OR visibility = 'public')`,
    [imageId, tenantId],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Image ${imageId} does not exist`);
  return toImage(rows[0]);
}

/** Resolves `name@version` for a tenant: its own image first, then a public one. */
export async function resolveImageRef(tx: SqlTx, tenantId: string, ref: string): Promise<CatalogImage | undefined> {
  const { rows } = await tx.query<ImageRow>(
    `SELECT ${columns} FROM images WHERE ref = $1 AND deleted_at IS NULL AND (tenant_id = $2 OR visibility = 'public')
      ORDER BY (tenant_id = $2) DESC, created_at LIMIT 1`,
    [ref, tenantId],
  );
  return rows[0] ? toImage(rows[0]) : undefined;
}

/** A page of the tenant's images and public ones, by ref. */
export async function listImages(
  tx: SqlTx,
  tenantId: string,
  page: { limit: number; after?: string; kind?: ImageKind },
): Promise<{ items: CatalogImage[]; cursor?: string }> {
  const { rows } = await tx.query<ImageRow>(
    `SELECT ${columns} FROM images
      WHERE deleted_at IS NULL AND (tenant_id = $1 OR visibility = 'public')
        AND ($2::text IS NULL OR (ref || '|' || id) > $2) AND ($3::text IS NULL OR kind = $3)
      ORDER BY ref, id LIMIT $4`,
    [tenantId, page.after ?? null, page.kind ?? null, page.limit + 1],
  );
  const items = rows.slice(0, page.limit).map(toImage);
  return rows.length > page.limit ? { items, cursor: `${items.at(-1)!.ref}|${items.at(-1)!.id}` } : { items };
}

/**
 * `images.promote`: makes a verified image public (a wildcard authz row, §12.4). Unsigned images
 * stay tenant-only: `INVALID_STATE`.
 */
export async function promoteImage(tx: SqlTx, authz: AuthzWriter | undefined, tenantId: string, imageId: string): Promise<CatalogImage> {
  const { rows } = await tx.query<ImageRow>(
    `SELECT ${columns} FROM images WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [imageId, tenantId],
  );
  const row = rows[0];
  if (!row) throw new ComputeError('NOT_FOUND', `Image ${imageId} does not exist`);
  if (!row.verified) throw new ComputeError('INVALID_STATE', `Image ${row.ref} is not signed; unsigned images stay tenant-only`);
  if (row.visibility === 'public') return toImage(row);
  const updated = await tx.query<ImageRow>(
    `UPDATE images SET visibility = 'public', version = version + 1 WHERE id = $1 RETURNING ${columns}`,
    [imageId],
  );
  await authz?.upsert(tx, {
    type: 'image',
    id: imageId,
    tenantId: '*',
    attributes: { kind: row.kind, format: row.format, verified: true, visibility: 'public' },
  });
  return toImage(updated.rows[0]!);
}

// --- Site caches -------------------------------------------------------------------------------------

export type ImageLocationState = 'pulling' | 'ready' | 'failed' | 'evicting';

/** A site agent reports what its cache holds. */
export async function recordImageLocation(
  tx: SqlTx,
  input: { imageId: string; siteId: string; state: ImageLocationState; sizeBytes?: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO image_locations (image_id, site_id, state, size_bytes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (image_id, site_id) DO UPDATE SET state = EXCLUDED.state,
       size_bytes = COALESCE(EXCLUDED.size_bytes, image_locations.size_bytes), updated_at = compute_now()`,
    [input.imageId, input.siteId, input.state, input.sizeBytes ?? null],
  );
}

/** Marks an image used at a site (LRU order), optionally pinning it while a deploy streams it. */
export async function touchImageLocation(tx: SqlTx, imageId: string, siteId: string, pinned?: boolean): Promise<void> {
  await tx.query(
    `UPDATE image_locations SET last_used_at = compute_now(), pinned = COALESCE($3, pinned)
      WHERE image_id = $1 AND site_id = $2`,
    [imageId, siteId, pinned ?? null],
  );
}

/** Image ids ready at a site (the `image-cached` scorer's input). */
export async function imagesCachedAt(tx: SqlTx, siteId: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ image_id: string }>(
    `SELECT image_id FROM image_locations WHERE site_id = $1 AND state = 'ready'`,
    [siteId],
  );
  return new Set(rows.map((row) => row.image_id));
}

/**
 * The least recently used ready images at a site whose sizes add up to at least `bytesNeeded`,
 * never pinned ones or those in `inUse`. Fewer than needed means the cache cannot make room.
 */
export async function evictionCandidates(
  tx: SqlTx,
  siteId: string,
  bytesNeeded: number,
  inUse: ReadonlySet<string> = new Set(),
): Promise<{ imageId: string; sizeBytes: number }[]> {
  const { rows } = await tx.query<{ image_id: string; size_bytes: number | null }>(
    `SELECT image_id, size_bytes FROM image_locations
      WHERE site_id = $1 AND state = 'ready' AND NOT pinned ORDER BY last_used_at, image_id`,
    [siteId],
  );
  const picked: { imageId: string; sizeBytes: number }[] = [];
  let freed = 0;
  for (const row of rows) {
    if (freed >= bytesNeeded) break;
    if (inUse.has(row.image_id)) continue;
    const size = Number(row.size_bytes ?? 0);
    picked.push({ imageId: row.image_id, sizeBytes: size });
    freed += size;
  }
  return picked;
}
