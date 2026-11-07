import { doksProfile } from '../support/managed-k8s-profiles.js';
import { fleetPoolScenario } from '../support/fleet-pool-scenario.js';

// The Kubernetes fleet pool on DOKS: the provider-neutral scenario (tests/support/fleet-pool-scenario.ts) with the
// DOKS account swapped in.

fleetPoolScenario(doksProfile);
