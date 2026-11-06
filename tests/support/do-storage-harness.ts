import { manualClock, type CallContext, type ManualClock } from '@better-compute/core';
import {
  digitalocean,
  doStorageKinds,
  doStorageResources,
  type DoConfig,
  type DoResourceRequest,
  type DoResourceState,
  type DoStorageKindEntry,
  type DoStorageResources,
  type DoStorageOptions,
} from '@better-compute/provider-digitalocean';
import { DoEmulator } from './do-emulator/index.js';
import { noopLog, platformAccount } from './do-harness.js';
import { SpacesEmulator } from './spaces-emulator.js';

// Shared setup for the DigitalOcean storage kinds: the DO API emulator, the Spaces (S3) emulator,
// and `doStorageResources` built over both for an account whose config the provider's manifest
// validated.

export const storageSecrets = {
  resolve: async (ref: string): Promise<string> => {
    if (ref === 'secret://do/t') return 'do-token';
    if (ref === 'secret://spaces/access') return 'SPACESKEY';
    if (ref === 'secret://spaces/secret') return 'spaces-secret';
    throw new Error('this account has no such secret');
  },
};

export const storageAccount = {
  token: 'secret://do/t',
  regions: ['nyc3'],
  spacesAccessKey: 'secret://spaces/access',
  spacesSecretKey: 'secret://spaces/secret',
};

export function storageCtx(clock: ManualClock, key = 'k1'): CallContext {
  return {
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock,
    secrets: storageSecrets,
    log: noopLog,
  };
}

export interface StorageWorld {
  emu: DoEmulator;
  spaces: SpacesEmulator;
  clock: ManualClock;
  resources: DoStorageResources;
  /** The same kinds as entries of the provider-wide DigitalOcean dispatcher. */
  kinds: DoStorageKindEntry[];
  ctx: (key?: string) => CallContext;
  /** `resources.ensure` with the request spelled out: kind, name, spec, then the context. */
  ensure: (
    kind: string,
    name: string,
    spec: unknown,
    context: CallContext,
    extra?: Omit<DoResourceRequest, 'kind' | 'name' | 'spec'>,
  ) => Promise<DoResourceState>;
}

export async function storageWorld(
  config: Record<string, unknown> = storageAccount,
  options: DoStorageOptions = {},
  register: (world: { emu: DoEmulator; spaces: SpacesEmulator }) => void = () => {},
): Promise<StorageWorld> {
  const t0 = Date.parse('2026-11-05T10:00:00Z');
  const clock = manualClock(t0);
  const emu = new DoEmulator({ now: () => clock.now() });
  const spaces = new SpacesEmulator({ now: () => clock.now() });
  register({ emu, spaces });
  const parsed = await digitalocean.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  const args = [
    (parsed as { value: DoConfig }).value,
    { clock, secrets: storageSecrets, log: noopLog, account: platformAccount },
    { fetch: emu.fetch, spacesFetch: spaces.fetch, ...options },
  ] as const;
  const resources = doStorageResources(...args);
  return {
    emu,
    spaces,
    clock,
    resources,
    kinds: doStorageKinds(...args),
    ctx: (key) => storageCtx(clock, key),
    ensure: (kind, name, spec, context, extra = {}) =>
      resources.ensure({ kind, name, spec, ...extra }, context),
  };
}
