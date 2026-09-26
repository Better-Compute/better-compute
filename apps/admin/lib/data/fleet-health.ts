// One decision per node, shared by every module: is it ready, degraded, offline or provisioning, is it held out
// of scheduling (failed, rescue, retiring, cordoned), and can new work land on it. The fleet pages build their
// full node view on this; capacity reads it so it never books a GPU on a node the fleet shows as broken; the
// Overview's fleet wall picks the same nodes (platform.ts nodeStates).
//
// Cheap and pure: poolPulse + nodeStates per pool, memoized per 20-minute fault bucket.

import { HOUR, MINUTE, noise } from './core';
import { nodeStates, poolPulse } from './platform';
import { poolNodeId, poolNodePlacement, pools, sites, type Pool } from './topology';

export type NodeHealth = 'ready' | 'degraded' | 'offline' | 'provisioning';
/** Operator-held states that last across fault buckets. */
export type NodeHold = 'failed' | 'rescue' | 'retiring';

export interface NodeHealthInfo {
  health: NodeHealth;
  hold?: NodeHold;
  /** Cordoned by an operator (simulated; operator actions in the admin overlay come on top). */
  cordoned: boolean;
  /** New reservations may land here. */
  schedulable: boolean;
}

interface NodeRef {
  pool: Pool;
  index: number;
  metal: boolean;
}

let refs: Map<string, NodeRef> | undefined;
function refFor(nodeId: string): NodeRef | undefined {
  if (!refs) {
    refs = new Map();
    for (const pool of pools) {
      const metal = sites.find((site) => site.id === pool.siteId)?.provider === 'metal';
      for (let index = 0; index < pool.nodes; index++) refs.set(poolNodeId(pool, index), { pool, index, metal });
    }
  }
  return refs.get(nodeId);
}

const bucketCache = new Map<string, Map<string, NodeHealth>>();
/** Every node of a pool at `now`, by the Overview's nodeStates choice. */
function poolHealth(pool: Pool, now: number): Map<string, NodeHealth> {
  const bucket = Math.floor(now / (20 * MINUTE));
  const key = `${pool.id}@${bucket}`;
  let health = bucketCache.get(key);
  if (!health) {
    health = new Map();
    for (const entry of nodeStates(poolPulse(pool, now), now))
      health.set(entry.id, entry.state === 'offline' || entry.state === 'degraded' || entry.state === 'provisioning' ? entry.state : 'ready');
    bucketCache.set(key, health);
    if (bucketCache.size > pools.length * 3) bucketCache.delete(bucketCache.keys().next().value!);
  }
  return health;
}

/** The held state of a node, stable across buckets (seeded by its id). */
export function nodeHold(nodeId: string, health: NodeHealth, metal: boolean, pool: Pool, unit: number): NodeHold | undefined {
  if (health !== 'ready') return undefined;
  const sticky = noise(`${nodeId}:sticky`);
  if (metal && sticky < 0.012) return 'failed';
  if (metal && sticky < 0.018) return 'rescue';
  if (pool.id === 'pool_a100_ams2' && unit < 10 && noise(`${nodeId}:retire`) < 0.5) return 'retiring';
  return undefined;
}

export function simulatedCordon(nodeId: string, health: NodeHealth, hold: NodeHold | undefined, now: number): boolean {
  return hold === 'retiring' || (health !== 'offline' && noise(`${nodeId}:cordon`, Math.floor(now / (8 * HOUR))) < 0.025);
}

/** The shared health decision for one node at `now`; undefined for an unknown id. */
export function nodeHealth(nodeId: string, now: number, unit?: number): NodeHealthInfo | undefined {
  const ref = refFor(nodeId);
  if (!ref) return undefined;
  const health = poolHealth(ref.pool, now).get(nodeId) ?? 'ready';
  const top = unit ?? poolNodePlacement(ref.pool, ref.index).unit;
  const hold = nodeHold(nodeId, health, ref.metal, ref.pool, top);
  const cordoned = simulatedCordon(nodeId, health, hold, now);
  return { health, ...(hold ? { hold } : {}), cordoned, schedulable: health === 'ready' && !hold && !cordoned };
}
