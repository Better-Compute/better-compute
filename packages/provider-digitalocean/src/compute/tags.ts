import { isComputeError } from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoDroplet } from './types.js';

// Tag writes on one Droplet at a time (never the tag-scoped bulk endpoints). A tag object must
// exist before it is assigned; DO keeps the spelling it first saw, and its URLs want that one.

/** Makes the tag object exist: one that already does is fine. */
export async function ensureTag(
  client: DoClient,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await client.request('POST', '/tags', { body: { name }, signal, budget: 'mutate' });
  } catch (error) {
    if (!isComputeError(error, 'CONFLICT')) throw error;
  }
}

/** Puts a tag on a Droplet, making the tag object first; DO answers 204. */
export async function assignTag(
  client: DoClient,
  name: string,
  dropletId: number,
  signal: AbortSignal,
): Promise<void> {
  await ensureTag(client, name, signal);
  await client.request('POST', `/tags/${encodeURIComponent(name)}/resources`, {
    body: { resources: [{ resource_id: String(dropletId), resource_type: 'droplet' }] },
    signal,
    budget: 'mutate',
  });
}

/** Takes a tag off one Droplet; a Droplet or tag that is gone counts as done. */
export async function unassignTag(
  client: DoClient,
  name: string,
  dropletId: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await client.request('DELETE', `/tags/${encodeURIComponent(name)}/resources`, {
      body: { resources: [{ resource_id: String(dropletId), resource_type: 'droplet' }] },
      signal,
      budget: 'mutate',
    });
  } catch (error) {
    if (!isComputeError(error, 'NOT_FOUND')) throw error;
  }
}

/** Whether a Droplet carries the (lowercase) tag, in any spelling. */
export function hasTag(droplet: DoDroplet, tag: string): boolean {
  return (droplet.tags ?? []).some((t) => t.toLowerCase() === tag);
}

/** The tag as the Droplet spells it: DO's URLs want the spelling a tag was made with. */
export function spelled(droplet: DoDroplet, tag: string): string {
  return (droplet.tags ?? []).find((t) => t.toLowerCase() === tag) ?? tag;
}
