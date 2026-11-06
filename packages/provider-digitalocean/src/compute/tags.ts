import { isComputeError } from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { kubernetesTag } from '../doks/clusters.js';
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

/** DOKS's membership tag: `k8s:<cluster uuid>`. */
const clusterMemberTag = /^k8s:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * DOKS's own tag keys (`k8s`, `k8s:<cluster uuid>`, `k8s-worker`): never a vps label's key, so no
 * tenant label makes a Droplet look like a worker (or forges one).
 */
export const doksTagKeys: ReadonlySet<string> = new Set(['k8s', 'k8s-worker']);

/**
 * Whether a Droplet is a DOKS worker node: exactly what DOKS writes (the bare `k8s-worker` tag or
 * `k8s:<cluster uuid>`), or the ownership tag better-compute's DOKS node pools carry (DOKS puts a
 * pool's tags on its workers). DOKS owns these Droplets: they are never claimed, managed or
 * deleted as vps instances. A `k8s:<anything else>` tag (a label a vps instance got before those
 * keys were refused) does not count: it would make the instance's own Droplet unowned.
 */
export function isKubernetesNode(droplet: DoDroplet): boolean {
  return (droplet.tags ?? []).some((t) => {
    const tag = t.toLowerCase();
    return tag === 'k8s-worker' || clusterMemberTag.test(tag) || tag === kubernetesTag;
  });
}

/** Whether a Droplet carries the (lowercase) tag, in any spelling. */
export function hasTag(droplet: DoDroplet, tag: string): boolean {
  return (droplet.tags ?? []).some((t) => t.toLowerCase() === tag);
}

/** The tag as the Droplet spells it: DO's URLs want the spelling a tag was made with. */
export function spelled(droplet: DoDroplet, tag: string): string {
  return (droplet.tags ?? []).find((t) => t.toLowerCase() === tag) ?? tag;
}
