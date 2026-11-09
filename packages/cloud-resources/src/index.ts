/**
 * Managed data and platform services for better-compute: `cloudResources()`, the module behind the `cloudResources`
 * group, over the generic `ProviderResources` contract (managed databases, apps, functions, …) on the provider
 * accounts vps manages; and that contract's conformance cases.
 */
export { cloudResources, type CloudResourcesApi, type CloudResourcesOptions } from './module.js';
export * from './types.js';
export * from './migrations.js';
export * from './conformance.js';
export { cloudResourcesSchemas, maxSpecBytes } from './parse.js';
export {
  providerResourceName,
  resourceLabels,
  resourcesWork,
  type CloudResourcesDeps,
} from './store.js';
export {
  reconcileResource,
  resourcesReconciler,
  resourceMaxBackoffMs,
  resourcePollMs,
  resourceRetryMs,
} from './reconciler.js';
export {
  defaultResourceMeterGraceMs,
  meterRates,
  meterResources,
  resourceHoursMeter,
} from './usage.js';
export { maxCatalogEntries } from './catalog.js';
export { maxSignalItems } from './signals.js';
