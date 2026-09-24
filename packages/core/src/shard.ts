// Reconciler sharding (PLAN.md §8.5): a fixed set of shards, each owned through a `shard:<n>` lease.

/** The number of reconciler shards. Fixed: `nodes.shard` and `work_queue.shard` store values below it. */
export const SHARD_COUNT = 256;

const encoder = new TextEncoder();

/** FNV-1a (32-bit) over the UTF-8 bytes of `key`, modulo {@link SHARD_COUNT}: `nodes.shard` for a node id. */
export function shardOf(key: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % SHARD_COUNT;
}
