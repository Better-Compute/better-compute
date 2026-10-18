import { manualClock, type CallContext, type Clock, type Logger } from '@better-compute/core';
import {
  digitaloceanProvider,
  resetBudgets,
  type DoCompute,
  type DoConfig,
  type DoProviderOptions,
} from '@better-compute/provider-digitalocean';
import type { DoEmulator } from './do-emulator/index.js';

// Shared setup for the provider-digitalocean tests: secrets, accounts, a call context and a
// provider client over the emulator.

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

/**
 * A client for an account over the emulator, built the way vps builds one: the account config is
 * validated by the definition's manifest, then handed to `create`. `clock` is the provider's
 * (its caches age by it).
 */
export async function build(
  emu: DoEmulator,
  config: Record<string, unknown> = doAccount,
  options: DoProviderOptions = {},
  clock: Clock = manualClock(1_000_000),
): Promise<DoCompute> {
  const provider = digitaloceanProvider({ fetch: emu.fetch, ...options });
  const parsed = await provider.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  return (await provider.create((parsed as { value: DoConfig }).value, {
    clock,
    secrets,
    log: noopLog,
    account: platformAccount,
  })) as DoCompute;
}
