import { ComputeError } from '@better-compute/core';

/** A revoked certificate. Serials are lower-case hex without leading zeros (`node_certs.serial`). */
export interface RevocationEntry {
  serial: string;
  reason?: string;
  /** Epoch milliseconds. */
  revokedAt: number;
  /** The certificate's own expiry; `prune` drops entries past it. */
  notAfter?: number;
}

/**
 * The revocations a process knows about. Postgres (`node_certs.revoked_at`) is the truth; this set is
 * the in-memory view gateways and the Renew verifier consult on every handshake, fed from the outbox.
 * Listeners run synchronously on each new revocation (a gateway closes the matching session at once).
 */
export interface RevocationSet {
  /** Adds a revocation; false when the serial was already revoked (the first entry is kept). */
  add(serial: string, options?: { reason?: string; at?: number; notAfter?: number }): boolean;
  has(serial: string): boolean;
  get(serial: string): RevocationEntry | undefined;
  entries(): RevocationEntry[];
  readonly size: number;
  /** Drops entries whose certificate expired before `now`; returns how many. */
  prune(now: number): number;
  /** Returns an unsubscribe function. A throwing listener never stops the others. */
  subscribe(listener: (entry: RevocationEntry) => void): () => void;
}

/** Canonical serial form: lower-case hex, no leading zeros. Throws `INVALID_INPUT`. */
export function normalizeSerial(serial: string): string {
  const text = typeof serial === 'string' ? serial.trim().toLowerCase().replace(/:/g, '') : '';
  if (!/^[0-9a-f]{1,40}$/.test(text))
    throw new ComputeError('INVALID_INPUT', 'A certificate serial is 1 to 40 hex digits');
  return BigInt(`0x${text}`).toString(16);
}

export function createRevocationSet(initial: Iterable<RevocationEntry> = []): RevocationSet {
  const entries = new Map<string, RevocationEntry>();
  const listeners = new Set<(entry: RevocationEntry) => void>();
  for (const entry of initial) {
    const serial = normalizeSerial(entry.serial);
    if (!entries.has(serial)) entries.set(serial, { ...entry, serial });
  }
  return {
    add(serial, options = {}) {
      const key = normalizeSerial(serial);
      if (entries.has(key)) return false;
      const entry: RevocationEntry = { serial: key, revokedAt: options.at ?? Date.now() };
      if (options.reason !== undefined) entry.reason = options.reason;
      if (options.notAfter !== undefined) entry.notAfter = options.notAfter;
      entries.set(key, entry);
      for (const listener of [...listeners]) {
        try {
          listener(entry);
        } catch {
          // A listener's failure is its own; revocation has already happened.
        }
      }
      return true;
    },
    has(serial) {
      try {
        return entries.has(normalizeSerial(serial));
      } catch {
        return false;
      }
    },
    get(serial) {
      try {
        return entries.get(normalizeSerial(serial));
      } catch {
        return undefined;
      }
    },
    entries: () => [...entries.values()],
    get size() {
      return entries.size;
    },
    prune(now) {
      let removed = 0;
      for (const [serial, entry] of entries)
        if (entry.notAfter !== undefined && entry.notAfter < now) {
          entries.delete(serial);
          removed++;
        }
      return removed;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
