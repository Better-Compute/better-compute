import { ComputeError, isComputeError, systemClock, type Clock, type Logger } from '@better-compute/core';
import type { SnapshotStore } from '@better-compute/vps';
import type { AwsCredentials, CredentialSource } from './internal/transport.js';
import { s3Access, type S3StoreOptions } from './s3.js';
import { checkSegment } from './secret-refs.js';

export interface S3SnapshotStoreOptions extends S3StoreOptions {
  /** Lifetime of the presigned upload (default 3600). */
  uploadExpiresSeconds?: number;
  /** Lifetime of each presigned download (default 3600); restores mint a new one. */
  downloadExpiresSeconds?: number;
}

/** `s3SnapshotStore`: a `SnapshotStore` whose `downloadUrl` signs with cached credentials only. */
export interface S3SnapshotStore extends SnapshotStore {
  downloadUrl(input: { tenantId: string; snapshotId: string; url: string }): Promise<string>;
  /**
   * Loads (or reloads) the credentials `downloadUrl` signs with. The store starts this when it is
   * made and again ahead of expiry; a host may await it at startup. Never rejects (failures are
   * logged by code).
   */
  warm(): Promise<void>;
  /** Drops the cached download credentials: `downloadUrl` is UNAVAILABLE until the next warm-up. */
  invalidateCredentials(): void;
}

/** Credentials kept in memory, refreshed in the background, never awaited by a signer. */
function cachedCredentials(source: CredentialSource, clock: Clock, refreshBeforeMs: number, log?: Logger) {
  let current: AwsCredentials | undefined;
  let inflight: Promise<void> | undefined;
  const minValidMs = 60_000;
  const refresh = (): Promise<void> =>
    (inflight ??= (async () => {
      try {
        current = await source.credentials({ signal: AbortSignal.timeout(30_000), clock });
      } catch (error) {
        log?.warn('snapshot download credentials did not load', { code: isComputeError(error) ? error.code : 'INTERNAL' });
      } finally {
        inflight = undefined;
      }
    })());
  const cached: CredentialSource = {
    kind: `${source.kind}-cached`,
    async credentials() {
      const remaining = current?.expiresAt === undefined ? Number.POSITIVE_INFINITY : current.expiresAt - clock.now();
      if (!current || remaining < refreshBeforeMs) void refresh();
      if (!current || remaining <= minValidMs)
        throw new ComputeError('UNAVAILABLE', 'snapshot download credentials are not loaded yet', undefined, {
          provider: 'aws',
          retryAfterMs: 1000,
        });
      return current;
    },
  };
  return {
    source: cached,
    refresh,
    invalidate() {
      current = undefined;
      source.invalidate?.();
    },
  };
}

/**
 * Sandbox snapshots in S3. Keys are `${prefix}/${tenantId}/${sandboxId}/${snapshotId}`; the stored
 * `url` is the stable `s3://bucket/key` (an identifier, not a link). Uploads are presigned PUTs with
 * the SSE headers signed and returned as `uploadHeaders`; restores get a fresh presigned GET from
 * `downloadUrl`, only for the snapshot's own tenant.
 *
 * `downloadUrl` runs inside NodeSpec's transaction (with the node row locked), so it makes no
 * network call: it signs with credentials cached in memory and refreshed in the background, and is
 * UNAVAILABLE (the restore keeps its stored url for that pass) while none are loaded. A stored url
 * that is not `s3://` (written before the host used this store) passes through unchanged.
 */
export function s3SnapshotStore(options: S3SnapshotStoreOptions): S3SnapshotStore {
  const s3 = s3Access(options);
  const clock = options.clock ?? systemClock;
  const uploadExpires = options.uploadExpiresSeconds ?? 3600;
  const downloadExpires = options.downloadExpiresSeconds ?? 3600;
  for (const value of [uploadExpires, downloadExpires])
    if (!Number.isInteger(value) || value < 60 || value > 7 * 24 * 3600)
      throw new ComputeError('INVALID_CONFIG', 'snapshot URL lifetimes are between 60 seconds and 7 days');
  const keyOf = (tenantId: string, sandboxId: string, snapshotId: string) =>
    s3.fullKey(
      `${checkSegment(tenantId, 'tenant id')}/${checkSegment(sandboxId, 'sandbox id')}/${checkSegment(snapshotId, 'snapshot id')}`,
    );
  // Refreshed once less than one URL lifetime is left, so a URL rarely outlives its signing key.
  const credentialCache = cachedCredentials(options.credentials, clock, downloadExpires * 1000, options.log);
  const s3Download = s3Access({ ...options, credentials: credentialCache.source });
  void credentialCache.refresh();
  const urlPrefix = `s3://${options.bucket}/`;
  const keyPrefix = options.prefix ? `${options.prefix}/` : '';

  /** The key of a stored `s3://` url, after checking it is this store's and `tenantId`'s. */
  function ownKey(input: { tenantId: string; snapshotId: string; url: string }): string {
    if (typeof input.url !== 'string' || !input.url.startsWith(urlPrefix))
      throw new ComputeError('INVALID_INPUT', 'not a snapshot of this store');
    const key = input.url.slice(urlPrefix.length);
    if (!key.startsWith(keyPrefix)) throw new ComputeError('INVALID_INPUT', 'not a snapshot of this store');
    const parts = key.slice(keyPrefix.length).split('/');
    if (parts.length !== 3) throw new ComputeError('INVALID_INPUT', 'not a snapshot of this store');
    const [tenantId, sandboxId, snapshotId] = parts as [string, string, string];
    if (tenantId !== input.tenantId) throw new ComputeError('ACCESS_DENIED', "the snapshot belongs to another tenant");
    if (snapshotId !== input.snapshotId) throw new ComputeError('INVALID_INPUT', 'the url is not that snapshot');
    return keyOf(tenantId, sandboxId, snapshotId);
  }

  return {
    async presign(input) {
      const key = keyOf(input.tenantId, input.sandboxId, input.snapshotId);
      const uploadHeaders = s3.sseHeaders();
      const uploadUrl = await s3.presign(key, { method: 'PUT', expiresInSeconds: uploadExpires, headers: uploadHeaders });
      return {
        uploadUrl,
        ...(Object.keys(uploadHeaders).length > 0 ? { uploadHeaders } : {}),
        url: `${urlPrefix}${key}`,
      };
    },

    async downloadUrl(input) {
      // A legacy stored url (another store's link): nothing to mint, the host fetches it as stored.
      if (typeof input.url === 'string' && !input.url.startsWith('s3://')) return input.url;
      const key = ownKey(input);
      // Signed at the start of the current half-lifetime window: the URL (and so the host's
      // desired spec) is stable within the window and always valid for at least half its lifetime.
      const window = (downloadExpires * 1000) / 2;
      const at = Math.floor(clock.now() / window) * window;
      return s3Download.presign(key, { method: 'GET', expiresInSeconds: downloadExpires, at });
    },

    warm: () => credentialCache.refresh(),
    invalidateCredentials: () => credentialCache.invalidate(),

    async delete(input) {
      const key = ownKey(input);
      const response = await s3.request({ method: 'DELETE', key, operation: 'DeleteObject', accept: [404] });
      await response.body?.cancel();
    },
  };
}
