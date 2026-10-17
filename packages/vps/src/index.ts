/**
 * VPS for better-compute (PLAN.md §3.6): `vps()`, the module behind the `instances`, `flavors` and
 * `providerAccounts` groups; `defineProvider`; the `runtime` driver kind merged into `DriverKinds`
 * of `@better-compute/core` by importing this package; pool IPAM; and the seams the gateway and the
 * node spec use (`reportInstances`, `instanceSpecs`). The provider, flavor and instance contracts
 * are declared in `@better-compute/core` and re-exported here.
 */
export { defineProvider } from './provider.js';
export { vps, type VpsApi, type VpsOptions, type ProviderAccountView } from './module.js';
export * from './migrations.js';
export * from './instances.js';
export * from './lifecycle.js';
export * from './status.js';
export * from './flavors.js';
export * from './accounts.js';
export * from './ipam.js';
export * from './hosts.js';
export * from './bootstraps.js';
export * from './provider-reservations.js';
export * from './discovery.js';
export * from './attach.js';
export * from './sandboxes.js';
export * from './snapshots.js';
export * from './volumes.js';
export * from './volume-storage.js';
export * from './networks.js';
export * from './tenancy.js';
export * from './describe.js';
export * from './placement.js';
export { builtinRuntimeTraits } from './runtime.js';
export type {
  RuntimeDriver,
  RuntimeInstanceStatus,
  RuntimeIsolation,
  RuntimeSnapshotResult,
  RuntimeSnapshotTarget,
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
export * from './conformance.js';
export * from './usage.js';
