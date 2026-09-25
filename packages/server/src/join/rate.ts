/**
 * A token bucket per key: `perMinute` events a minute, refilled continuously. `take` answers the
 * count suppressed since the last admitted event, or undefined when this one is dropped. Bounded
 * to 1 000 keys (the oldest idle key goes first).
 */
export function refusalBucket(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number; suppressed: number }>();
  const rate = perMinute / 60_000;
  return {
    take(key: string, now: number): number | undefined {
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= 1000) buckets.delete(buckets.keys().next().value!);
        bucket = { tokens: perMinute, at: now, suppressed: 0 };
      }
      buckets.delete(key);
      buckets.set(key, bucket);
      bucket.tokens = Math.min(perMinute, bucket.tokens + Math.max(0, now - bucket.at) * rate);
      bucket.at = now;
      if (bucket.tokens < 1) {
        bucket.suppressed++;
        return undefined;
      }
      bucket.tokens -= 1;
      const suppressed = bucket.suppressed;
      bucket.suppressed = 0;
      return suppressed;
    },
  };
}
