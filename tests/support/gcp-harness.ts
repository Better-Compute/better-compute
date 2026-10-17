import { manualClock, type CallContext, type ProviderImpl } from '@better-compute/core';
import { gcpProvider, type GcpConfig, type GcpProviderOptions } from '@better-compute/provider-gcp';
import type { GceEmulator } from './gce-emulator.js';

// Shared setup for the provider-gcp tests: a client over the emulator and a call context.

export const secrets = {
  resolve: async (): Promise<string> => {
    throw new Error('this account has no secrets');
  },
};

const log = { debug() {}, info() {}, warn() {}, error() {} };

/** A root-tenant account: the only kind that may use ambient credentials (ruling F1). */
export const platformAccount = { id: 'pacct_platform', tenantId: 'root', platform: true };

export function ctx(key = 'k1'): CallContext {
  return {
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: manualClock(1_000_000),
    secrets,
    log,
  };
}

export const gcpAccount = { projectId: 'p', zones: ['us-central1-a'] };

export async function build(
  emu: GceEmulator,
  config: Record<string, unknown> = gcpAccount,
  options: GcpProviderOptions = {},
): Promise<ProviderImpl> {
  const provider = gcpProvider({ fetch: emu.fetch, ...options });
  const parsed = await provider.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  return provider.create((parsed as { value: GcpConfig }).value, {
    clock: manualClock(1_000_000),
    secrets,
    log,
    account: platformAccount,
  });
}
