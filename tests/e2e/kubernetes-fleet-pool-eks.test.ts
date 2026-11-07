import { eksProfile } from '../support/managed-k8s-profiles.js';
import { fleetPoolScenario } from '../support/fleet-pool-scenario.js';

// The Kubernetes fleet pool on EKS: the provider-neutral scenario (tests/support/fleet-pool-scenario.ts) with the
// EKS account swapped in.

fleetPoolScenario(eksProfile);
