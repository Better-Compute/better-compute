import type { Clock } from '@better-compute/core';

/**
 * A token bucket: `ratePerSecond` tokens refill continuously up to a burst of the same size. Bounds
 * TLS handshakes and session opens per process (§7.2, 200/s by default) so a reconnect storm is
 * spread by the daemons' jittered retries instead of melting the gateway.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly clock: Clock,
    private readonly burst = ratePerSecond,
  ) {
    this.tokens = burst;
    this.last = clock.now();
  }

  /** Takes one token; false when the bucket is empty. */
  take(): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
