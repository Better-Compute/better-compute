import { ComputeError, type Clock, type Logger } from '@better-compute/core';
import { createTransport, type CredentialSource, type Transport } from './internal/transport.js';

export type { AwsCredentials, CredentialContext, CredentialSource } from './internal/transport.js';

/** Options every factory in this package takes. */
export interface AwsServiceOptions {
  region: string;
  /** Request credentials: aws-core's ambient chain on ECS/EKS/EC2, or any `CredentialSource`. */
  credentials: CredentialSource;
  fetch?: typeof fetch;
  /** Base URL override for tests and VPC endpoints (`http(s)://host[:port]`). */
  endpoint?: string;
  clock?: Clock;
  log?: Logger;
  /** Time to response headers per request attempt (default 20_000 ms); response bodies stream unbounded. */
  timeoutMs?: number;
}

/** The transport behind a factory (internal). */
export function transportFor(options: AwsServiceOptions): Transport {
  return createTransport(options);
}

/**
 * Splits `items` into ordered chunks of at most `maxCount` items and `maxBytes` total `size`. An item
 * larger than `maxBytes` is a chunk of its own (the caller decides whether that is an error).
 */
export function chunkBy<T>(
  items: readonly T[],
  limits: { maxCount: number; maxBytes: number; size: (item: T) => number },
): T[][] {
  if (!Number.isInteger(limits.maxCount) || limits.maxCount < 1)
    throw new ComputeError('INVALID_INPUT', 'maxCount must be a positive integer');
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = limits.size(item);
    if (current.length > 0 && (current.length >= limits.maxCount || bytes + size > limits.maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
    if (size > limits.maxBytes) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The structural command context of the `aws …` CLI commands (same shape as provider-aws's). */
export interface AwsCommandContext {
  flags: Record<string, string | number | boolean | undefined>;
  io: { out(message: string): void };
  note(message: string): void;
  path(value: string): string;
}

/** Best-effort zeroing of a plaintext buffer. */
export function wipe(buffer: Uint8Array | undefined): void {
  try {
    buffer?.fill(0);
  } catch {
    /* frozen or detached */
  }
}
