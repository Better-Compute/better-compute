import { gkeProfile } from '../support/managed-k8s-profiles.js';
import { fleetPoolScenario } from '../support/fleet-pool-scenario.js';

// The Kubernetes fleet pool on GKE: the provider-neutral scenario (tests/support/fleet-pool-scenario.ts) with the
// GKE account swapped in.

fleetPoolScenario(gkeProfile);
