/**
 * VPS for better-compute (PLAN.md §3.6): `defineProvider`, which is implemented, the `runtime`
 * driver kind merged into `DriverKinds` of `@better-compute/core` by importing this package, and
 * `vps()`, whose instance lifecycle arrives in v0.3. The provider, flavor and instance contracts are
 * declared in `@better-compute/core` and re-exported here.
 */
export { defineProvider } from './provider.js';
export { vps, type VpsOptions } from './module.js';
export type {
  RuntimeDriver,
  RuntimeInstanceStatus,
  RuntimeIsolation,
  RuntimeTraits,
} from './runtime.js';

export type {
  CallContext,
  ExternalMachine,
  Flavor,
  ImageRef,
  Instance,
  InstanceDesiredState,
  InstanceSpec,
  InstanceState,
  Offer,
  OfferQuery,
  ProviderContext,
  ProviderDefinition,
  ProviderImpl,
  ProviderInput,
  RescueAccess,
} from '@better-compute/core';
