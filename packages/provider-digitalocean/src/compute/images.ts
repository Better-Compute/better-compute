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
