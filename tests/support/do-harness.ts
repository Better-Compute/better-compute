import { manualClock, type CallContext, type Logger } from '@better-compute/core';
import { resetBudgets } from '@better-compute/provider-digitalocean';

// Shared setup for the provider-digitalocean tests: secrets, accounts and a call context.

/** Resolves `secret://do/t` to the emulator's default token. */
export const secrets = {
  resolve: async (ref: string): Promise<string> => {
    if (ref === 'secret://do/t') return 'do-token';
    throw new Error('this account has no such secret');
  },
};

export const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A root-tenant account. */
export const platformAccount = { id: 'pacct_platform', tenantId: 'root', platform: true };

export function ctx(key = 'k1'): CallContext {
  return {
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: manualClock(1_000_000),
    secrets,
    log: noopLog,
  };
}

export const doAccount = { token: 'secret://do/t', regions: ['nyc3'] };

/**
 * Every test starts from clean shared state: the per-token request budgets are process-wide, and
 * all tests use the same token. Call it from `beforeEach`.
 */
export function freshBudgets(): void {
  resetBudgets();
}
