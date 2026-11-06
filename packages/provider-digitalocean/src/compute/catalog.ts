import {
  ComputeError,
  isComputeError,
  type CatalogImageIdentity,
  type Logger,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { labels, tagFor } from '../ids.js';
import type { DoAction, DoImage } from './types.js';

// Catalog images as DigitalOcean custom images (P3). DO imports a custom image from a URL it
// fetches itself, so the host hands the provider a source (`catalogImages`) that names a catalog
// image's digest and a short-lived HTTPS URL for it (a presigned BlobStore GET). The URL is a
// bearer credential for its lifetime: it goes into the import body and nowhere else, never a log
// line, an error message or a stored row.
//
// There is no table of imports: DO images take tags, so the image is its own record (decision
// D-P3-1). An import carries the managed tag, this deployment's tag and `better-compute-image:<h>`
// (h = the digest's first 24 hex characters), and is found by that tag, the key-tag protocol of
// DO-D4: look, import, look again, keep the oldest and delete the others. Its `regions` is the
// per-region cache. Nothing blocks: an import that is still running makes the create throw
// `UNAVAILABLE` with a `retryAfterMs`, and vps calls the (idempotent) create again.

/** Where a catalog image can be fetched from, as the host's source hands it over. */
export interface CatalogImageLocation {
  /** An HTTPS URL DigitalOcean can GET, valid for at least the import's duration. */
  url: string;
  /** Hex SHA-256 of the artifact, as the catalog registered it. */
  sha256: string;
  /** `raw` or `qcow2` (DO also takes vhdx, vdi and vmdk); `iso` is refused. */
  format: string;
  /** `none` or `gzip` (DO also takes bzip2); `zstd` is refused. */
  compression?: string;
  /** DO's distribution name (`Ubuntu`); absent: guessed from the ref's name, else `Unknown`. */
  distribution?: string;
}

/**
 * The host's catalog: provision's image catalog plus a BlobStore that can presign a GET. A catalog
 * ref is unique only within a tenant (and may be private), so the source is handed the image as
 * vps resolved it for the instance's tenant (`tenantId`, `sha256`) and must look it up by those,
 * never by the bare ref; the provider refuses a location whose digest differs.
 */
export interface CatalogImageSource {
  /** The catalog image `ref` names in `tenantId`'s catalog; undefined when it has none. */
  locate(
    ref: string,
    options: CatalogImageIdentity & { expiresInSeconds: number; signal: AbortSignal },
  ): Promise<CatalogImageLocation | undefined>;
}

/** How long the URL handed to DO stays valid: an import of a large image takes a while. */
export const importUrlTtlSeconds = 6 * 3600;
/** How soon vps should call a create again while an image imports or transfers. */
export const imageRetryAfterMs = 30_000;
/** Errored transfers of one import to one region after which the create fails instead of retrying. */
export const maxImageTransferAttempts = 3;
/** An import still not available this long after it started never will be: it goes, the create fails. */
export const importStuckMs = 24 * 3600_000;
/**
 * A transfer still in progress this long after it started is stuck, and a completed one whose
 * region the image still doesn't list this long after is lost: either fails the create.
 */
export const transferStuckMs = 24 * 3600_000;

const formats = new Set(['raw', 'qcow2', 'vhdx', 'vdi', 'vmdk']);
const compressions = new Set(['none', 'gzip', 'bzip2']);
const distributions: readonly [RegExp, string][] = [
  [/^ubuntu/, 'Ubuntu'],
  [/^debian/, 'Debian'],
  [/^fedora-atomic/, 'Fedora Atomic'],
  [/^fedora/, 'Fedora'],
  [/^centos/, 'CentOS'],
  [/^rocky/, 'Rocky Linux'],
  [/^arch/, 'Arch Linux'],
  [/^freebsd/, 'FreeBSD'],
  [/^opensuse/, 'openSUSE'],
  [/^gentoo/, 'Gentoo'],
  [/^coreos/, 'CoreOS'],
  [/^rancheros/, 'RancherOS'],
];
const knownDistributions = new Set([...distributions.map(([, name]) => name), 'Unknown']);

function fail(
  code: 'INVALID_CONFIG' | 'INVALID_STATE' | 'UNSUPPORTED' | 'UNAVAILABLE' | 'PROVIDER_ERROR',
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason, ...extra });
}

/** The tag an import of the artifact with this digest carries. */
export function imageTag(sha256: string): string {
  return tagFor(labels.image, sha256.toLowerCase().slice(0, 24));
}

/** The name of an import: `bc-img-<ref, cleaned>-<digest prefix>`, at most 100 characters. */
export function catalogImageName(ref: string, sha256: string): string {
  const cleaned = ref
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 72);
  return `bc-img-${cleaned}-${sha256.toLowerCase().slice(0, 12)}`.replace(/-+/g, '-');
}

/** DO's distribution for an import: the source's when DO knows it, else guessed from the name. */
export function distributionOf(ref: string, given?: string): string {
  if (given !== undefined && knownDistributions.has(given)) return given;
  const name = ref.toLowerCase();
  return distributions.find(([pattern]) => pattern.test(name))?.[1] ?? 'Unknown';
}

/** Oldest first: by creation time, then by id. */
function byAge(a: DoImage, b: DoImage): number {
  const at = Date.parse(a.created_at) - Date.parse(b.created_at);
  return Number.isFinite(at) && at !== 0 ? at : a.id - b.id;
}

/** An import DO gave up on: it can never boot. */
function failedImport(image: DoImage): boolean {
  const status = image.status ?? 'available';
  return status === 'deleted' || status === 'retired' || Boolean(image.error_message);
}

/** How long ago `at` (an ISO time) was; undefined when DO sent none or a malformed one. */
function ageOf(at: string | null | undefined, now: number): number | undefined {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? now - ms : undefined;
}

function tagged(image: DoImage, tag: string): boolean {
  return (image.tags ?? []).some((t) => t.toLowerCase() === tag);
}

/** The images better-compute imported for one deployment, by digest. */
export class DoCatalogImages {
  readonly #client: DoClient;
  readonly #source: CatalogImageSource;
  readonly #managedTag: string;
  readonly #deploymentTag: string;
  readonly #log: Logger;

  constructor(
    client: DoClient,
    source: CatalogImageSource,
    tags: { managed: string; deployment: string },
    log: Logger,
  ) {
    this.#client = client;
    this.#source = source;
    this.#managedTag = tags.managed;
    this.#deploymentTag = tags.deployment;
    this.#log = log;
  }

  /** Whether better-compute may delete (or transfer) the image: managed, and in this deployment. */
  owned(image: DoImage): boolean {
    return tagged(image, this.#managedTag) && tagged(image, this.#deploymentTag);
  }

  /**
   * The catalog's location of `ref` as resolved for `identity`'s tenant, checked; the URL is not
   * looked at beyond its scheme.
   */
  protected async locate(
    ref: string,
    identity: CatalogImageIdentity,
    signal: AbortSignal,
  ): Promise<CatalogImageLocation> {
    const location = await this.#source.locate(ref, {
      tenantId: identity.tenantId,
      sha256: identity.sha256.toLowerCase(),
      expiresInSeconds: importUrlTtlSeconds,
      signal,
    });
    if (!location)
      throw fail('INVALID_CONFIG', `catalog image ${ref} does not exist`, 'catalogImage');
    if (!/^[0-9a-f]{64}$/i.test(location.sha256))
      throw fail('INVALID_CONFIG', `catalog image ${ref} has no SHA-256 digest`, 'catalogImage');
    // The image vps resolved for the tenant is the one imported, or nothing is.
    if (location.sha256.toLowerCase() !== identity.sha256.toLowerCase())
      throw fail(
        'INVALID_CONFIG',
        `the catalog source located a different artifact for ${ref} than the one resolved`,
        'catalogImageDigest',
      );
    if (!formats.has(location.format))
      throw fail(
        'UNSUPPORTED',
        `catalog image ${ref} is ${location.format}, which DigitalOcean can't import`,
        'imageFormat',
      );
    if (!compressions.has(location.compression ?? 'none'))
      throw fail(
        'UNSUPPORTED',
        `catalog image ${ref} is ${location.compression}-compressed, which DigitalOcean can't import`,
        'imageFormat',
      );
    let url: URL | undefined;
    try {
      url = new URL(location.url);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:')
      throw fail(
        'INVALID_CONFIG',
        `the catalog source handed over a URL for ${ref} that is not https`,
        'catalogImageUrl',
      );
    return location;
  }

  /** This deployment's imports of one digest, oldest first. */
  protected async byTag(tag: string, signal: AbortSignal): Promise<DoImage[]> {
    const found: DoImage[] = [];
    for await (const image of this.#client.pages<DoImage>('/images', 'images', {
      query: { tag_name: tag },
      signal,
      budget: 'observe',
    }))
      if (tagged(image, tag) && this.owned(image)) found.push(image);
    return found.sort(byAge);
  }

  /** Deletes one import by id; one already gone counts as deleted. */
  protected async destroy(id: number, signal: AbortSignal): Promise<void> {
    try {
      await this.#client.request('DELETE', `/images/${id}`, { signal, budget: 'mutate' });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }

  /**
   * Deletes the failed imports, keeps the oldest of the rest and deletes the others: each carries
   * our tags. The survivor is the oldest, not the first available, so every racing create picks
   * the same one. When every import failed, they all go and the create fails.
   */
  protected async converge(images: DoImage[], ref: string, signal: AbortSignal): Promise<DoImage> {
    for (const image of images.filter(failedImport)) {
      // A failed import is ours: it goes, so a usable duplicate (or the next create) wins.
      this.#log.warn('digitalocean.imageImportFailed', { ref, image: image.id });
      await this.destroy(image.id, signal);
    }
    const live = images.filter((image) => !failedImport(image));
    if (live.length === 0)
      throw fail(
        'INVALID_STATE',
        `the import of catalog image ${ref} into DigitalOcean failed`,
        'imageImportFailed',
      );
    const [oldest, ...others] = live.sort(byAge);
    for (const duplicate of others) {
      this.#log.info('digitalocean.duplicateImageReaped', {
        kept: oldest!.id,
        deleted: duplicate.id,
      });
      await this.destroy(duplicate.id, signal);
    }
    return oldest!;
  }

  /** Starts the import into `region`. A refusal never carries the URL. */
  protected async startImport(
    ref: string,
    location: CatalogImageLocation,
    tag: string,
    region: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#client.request('POST', '/images', {
        body: {
          name: catalogImageName(ref, location.sha256),
          url: location.url,
          region,
          distribution: distributionOf(ref, location.distribution),
          description: `better-compute catalog image ${ref}`.slice(0, 255),
          tags: [this.#managedTag, this.#deploymentTag, tag],
        },
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error)) throw error;
      // DO's message may quote the body it refused, whole or in part (a truncated or re-escaped
      // query string still holds the signature): it is never passed on, whatever it says.
      throw new ComputeError(
        error.code,
        `DigitalOcean refused the import of catalog image ${ref}`,
        undefined,
        error.details,
      );
    }
    this.#log.info('digitalocean.imageImport', { ref, region });
  }

  /**
   * The id of the import of `ref` (as resolved for `identity`'s tenant) that can boot in `region`.
   * Starts the import, or a transfer of an import that is in another region, and throws
   * `UNAVAILABLE` (`retryAfterMs`) until it is there.
   */
  async imageIn(
    ref: string,
    identity: CatalogImageIdentity,
    region: string,
    signal: AbortSignal,
  ): Promise<number> {
    const location = await this.locate(ref, identity, signal);
    const tag = imageTag(location.sha256);
    let images = await this.byTag(tag, signal);
    if (images.length === 0) {
      try {
        await this.startImport(ref, location, tag, region, signal);
      } catch (error) {
        // An answer that never arrived may still have started the import: the look below decides.
        if (!isComputeError(error, 'UNAVAILABLE')) throw error;
      }
      // A racing create may have imported too: the oldest wins.
      images = await this.byTag(tag, signal);
      if (images.length === 0) throw importing(ref, 'imageImporting');
    }
    const image = await this.converge(images, ref, signal);
    return this.usable(image, ref, region, signal);
  }

  /** The image's id once it can boot in `region`. */
  protected async usable(
    image: DoImage,
    ref: string,
    region: string,
    signal: AbortSignal,
  ): Promise<number> {
    // converge has removed failed imports.
    const status = image.status ?? 'available';
    if (status !== 'available') {
      const startedAt = Date.parse(image.created_at);
      if (Number.isFinite(startedAt) && this.#client.clock.now() - startedAt > importStuckMs) {
        // Its URL expired long ago: it can't finish. It goes, so a later create imports afresh.
        this.#log.warn('digitalocean.imageImportStuck', { ref, image: image.id });
        await this.destroy(image.id, signal);
        throw fail(
          'INVALID_STATE',
          `the import of catalog image ${ref} into DigitalOcean did not finish`,
          'imageImportFailed',
        );
      }
      throw importing(ref, 'imageImporting');
    }
    if (image.regions.includes(region)) return image.id;
    if (await this.transfer(image, ref, region, signal)) return image.id;
    throw importing(ref, 'imageTransferring');
  }

  /**
   * Copies an import into another region; true when the region turns out to hold it already.
   *
   * - A copy there that is running is waited for (a retried create finds the transfer its first
   *   attempt started), unless it started more than `transferStuckMs` ago: then the create fails.
   * - A copy that completed is never posted again: the image is re-read, since the list can lag
   *   behind the action. Until that read shows the region the create waits, and past
   *   `transferStuckMs` after completion it fails.
   * - A transfer that errored is started again, up to `maxImageTransferAttempts`; then the create
   *   fails rather than retrying forever into a region that can't take the image.
   *
   * Every failure is `INVALID_STATE` (`imageTransferFailed`). Only an image of ours is ever
   * transferred (`byTag` returns no other).
   */
  protected async transfer(
    image: DoImage,
    ref: string,
    region: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const now = this.#client.clock.now();
    let errored = 0;
    let running: DoAction | undefined;
    let completed: DoAction | undefined;
    for await (const action of this.#client.pages<DoAction>(
      `/images/${image.id}/actions`,
      'actions',
      { signal, budget: 'observe' },
    )) {
      if (action.type !== 'transfer' || action.region_slug !== region) continue;
      if (action.status === 'in-progress') running = action;
      else if (action.status === 'completed') completed = action;
      else if (action.status === 'errored') errored++;
    }
    const stuck = (): ComputeError => {
      this.#log.warn('digitalocean.imageTransferStuck', { ref, image: image.id, region });
      return fail(
        'INVALID_STATE',
        `catalog image ${ref} could not be copied to ${region}: the transfer did not finish`,
        'imageTransferFailed',
      );
    };
    if (running) {
      if ((ageOf(running.started_at, now) ?? 0) > transferStuckMs) throw stuck();
      return false;
    }
    if (completed) {
      const current = await this.#client.request<{ image: DoImage }>(
        'GET',
        `/images/${image.id}`,
        { signal, budget: 'observe' },
      );
      if (current.image.regions.includes(region)) return true;
      const since = ageOf(completed.completed_at ?? completed.started_at, now) ?? 0;
      if (since > transferStuckMs) throw stuck();
      return false;
    }
    if (errored >= maxImageTransferAttempts)
      throw fail(
        'INVALID_STATE',
        `catalog image ${ref} could not be copied to ${region} (${errored} attempts)`,
        'imageTransferFailed',
      );
    await this.#client.request('POST', `/images/${image.id}/actions`, {
      body: { type: 'transfer', region },
      signal,
      budget: 'mutate',
    });
    this.#log.info('digitalocean.imageTransfer', { ref, image: image.id, region });
    return false;
  }
}

function importing(ref: string, reason: 'imageImporting' | 'imageTransferring'): ComputeError {
  return fail(
    'UNAVAILABLE',
    reason === 'imageImporting'
      ? `catalog image ${ref} is still being imported into DigitalOcean`
      : `catalog image ${ref} is still being copied to the region`,
    reason,
    { retryAfterMs: imageRetryAfterMs },
  );
}
