// The ProviderResources conformance cases live in @better-compute/vps (next to providerConformance), so a provider
// runs them without depending on this module. Re-exported here for existing callers.
export {
  providerResourcesConformanceCases,
  type ProviderResourcesConformanceSubject,
} from '@better-compute/vps';
