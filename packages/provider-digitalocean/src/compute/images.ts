import { ComputeError } from '@better-compute/core';

// Image references (P3). An `ImageRef` names one of three things, tried in this order:
//
// 1. A DigitalOcean slug (`ubuntu-24-04-x64`, `gpu-h100x1-base`): passed through, DO checks it.
// 2. A numeric image id (a snapshot or a custom image): passed through as a number.
// 3. A catalog `name@version` (provision's image catalog): imported as a DO custom image from a
//    short-lived URL the host hands over (`catalogImages`), see `catalog.ts`.
//
// Anything else is refused before a request is made.

/** What an image reference names. */
export type ImageChoice =
  | { kind: 'slug'; slug: string }
  | { kind: 'id'; id: number }
  | { kind: 'catalog'; ref: string };

/** A slug has a letter: an all-digit ref is an id or nothing. */
const slugPattern = /^(?=[^a-z]*[a-z])[a-z0-9][a-z0-9._-]{0,127}$/;
const idPattern = /^[1-9][0-9]{0,18}$/;
/** provision's catalog ref (`images.ts` refPattern). */
const catalogPattern = /^[^\s@]{1,128}@[^\s@]{1,64}$/;

function invalidImage(ref: string): ComputeError {
  return new ComputeError(
    'INVALID_INPUT',
    `${JSON.stringify(ref.slice(0, 200))} is not a DigitalOcean image slug, image id or catalog image`,
    undefined,
    { provider: 'digitalocean', reason: 'image' },
  );
}

/** Classifies an image reference; a malformed one is `INVALID_INPUT` (`reason 'image'`). */
export function classifyImage(ref: string): ImageChoice {
  if (idPattern.test(ref)) {
    const id = Number(ref);
    if (Number.isSafeInteger(id)) return { kind: 'id', id };
    throw invalidImage(ref);
  }
  if (catalogPattern.test(ref)) return { kind: 'catalog', ref };
  if (slugPattern.test(ref)) return { kind: 'slug', slug: ref };
  throw invalidImage(ref);
}

/** The `image` member of a create or rebuild body for a slug or an id. */
export function imageParam(choice: Exclude<ImageChoice, { kind: 'catalog' }>): string | number {
  return choice.kind === 'id' ? choice.id : choice.slug;
}

// GPU image guard (decision D-P3-4). DO's AI/ML images (`gpu-h100x1-base`) carry one vendor's
// drivers; GPU Droplets also boot plain OS images (the drivers are then the tenant's to install),
// so only two combinations are refused, before any request: an AI/ML image on a size without
// GPUs, and an AI/ML image whose vendor is not the size's.

type GpuVendor = 'nvidia' | 'amd';

const amdPattern = /(^|[^a-z])(amd|mi[0-9]{3}[a-z]?)/;
const nvidiaPattern = /(^|[^a-z])(nvidia|[abhl][0-9]{2,3}s?|rtx|[0-9]{4}ada)/;

/** The vendor named in a GPU size slug or model (`gpu-mi300x1-192gb`, `nvidia_h100`). */
export function gpuVendorOf(name: string): GpuVendor | undefined {
  const lower = name.toLowerCase().replace(/^gpu-/, '');
  if (amdPattern.test(lower)) return 'amd';
  if (nvidiaPattern.test(lower)) return 'nvidia';
  return undefined;
}

/** Whether a slug is one of DO's AI/ML images (`gpu-…`). */
export function isGpuImage(choice: ImageChoice): boolean {
  return choice.kind === 'slug' && choice.slug.startsWith('gpu-');
}

/**
 * Refuses an AI/ML image the size can't use. `gpu` says whether the size has GPUs; `model` is the
 * size's GPU model when known (`nvidia_h100`), else the size slug decides the vendor.
 */
export function checkGpuImage(
  choice: ImageChoice,
  size: string,
  gpu: boolean,
  model?: string,
): void {
  if (!isGpuImage(choice)) return;
  const slug = (choice as { slug: string }).slug;
  if (!gpu)
    throw new ComputeError(
      'INVALID_INPUT',
      `image ${slug} is a GPU image and size ${size} has no GPU`,
      undefined,
      { provider: 'digitalocean', reason: 'gpuImage' },
    );
  const imageVendor = gpuVendorOf(slug);
  const sizeVendor = gpuVendorOf(model ?? '') ?? gpuVendorOf(size);
  if (imageVendor !== undefined && sizeVendor !== undefined && imageVendor !== sizeVendor)
    throw new ComputeError(
      'INVALID_INPUT',
      `image ${slug} is built for ${imageVendor.toUpperCase()} GPUs and size ${size} has ${sizeVendor.toUpperCase()} ones`,
      undefined,
      { provider: 'digitalocean', reason: 'gpuImage' },
    );
}
