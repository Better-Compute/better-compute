import { createHash } from 'node:crypto';
import type { DoEmulator } from './index.js';
import { isoSeconds } from './actions.js';
import { fixture, type DoState, type Json } from './state.js';

// Droplet autoscale pools, read-only: `GET /v2/droplets/autoscale` (paged, key `autoscale_pools`)
// and `GET /v2/droplets/autoscale/{id}/members` (paged, key `droplets`, as the spec's
// all_members response has it). A test seeds a pool with the Droplets that are its members.

const templates = fixture('autoscale');
const poolTemplate = templates.pool as Json;
const memberTemplate = templates.member as Json;

/** A uuid-shaped id derived from a seed, so the emulator's ids are stable across runs. */
function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Puts a pool in the account with these Droplets as members; returns the stored pool. */
export function seedAutoscalePool(
  state: DoState,
  pool: { name: string; members: readonly number[]; id?: string },
): Json {
  const id = pool.id ?? uuidFrom(`autoscale:${pool.name}`);
  const now = isoSeconds(state.now());
  const stored: Json = {
    ...structuredClone(poolTemplate),
    id,
    name: pool.name,
    created_at: now,
    updated_at: now,
    active_resources_count: pool.members.length,
  };
  state.autoscalePools.set(id, stored);
  state.autoscaleMembers.set(
    id,
    pool.members.map((dropletId) => ({
      ...structuredClone(memberTemplate),
      droplet_id: dropletId,
      created_at: now,
      updated_at: now,
    })),
  );
  return stored;
}

export function registerAutoscale(emulator: DoEmulator): void {
  emulator.route('GET', /^\/droplets\/autoscale$/, (context) =>
    emulator.paged(context, 'autoscale_pools', [...context.state.autoscalePools.values()]),
  );

  emulator.route('GET', /^\/droplets\/autoscale\/([^/]+)\/members$/, (context) => {
    const id = decodeURIComponent(context.match[1]!);
    if (!context.state.autoscalePools.has(id)) return emulator.error('not-found');
    return emulator.paged(context, 'droplets', context.state.autoscaleMembers.get(id) ?? []);
  });
}
