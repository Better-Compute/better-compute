import { field, manifest, type SecretRef } from '@better-compute/core';
import type { TokenSource } from './auth.js';

/** A Google Cloud account's configuration: credentials are a SecretRef, never a value. */
export const gcpConfig = manifest({
  projectId: field.string().describe('The Google Cloud project id'),
  zones: field
    .list(field.string(), { min: 1 })
    .describe('Zones the provider works in: offers and discovery are limited to these'),
  credentials: field
    .secret()
    .optional()
    .describe(
      'Service-account key JSON, as a secret reference; absent means the host identity (the token source or the metadata server), which only a platform account may use',
    ),
  impersonate: field
    .string()
    .optional()
    .describe('Service-account email to impersonate with the base credentials'),
  network: field
    .string()
    .default('default')
    .describe('VPC network that create uses when no tenant network is given'),
  subnet: field.string().optional().describe('Subnetwork that create uses with that network'),
  imageProject: field
    .string()
    .default('ubuntu-os-cloud')
    .describe('Project that image families resolve in'),
  diskGiB: field.int().default(100).describe('Boot disk size in GiB'),
  discoverLabel: field
    .string()
    .optional()
    .describe('"key=value": discovery yields only VMs carrying this label'),
});

/** The validated account configuration. */
export interface GcpConfig {
  projectId: string;
  zones: string[];
  credentials?: SecretRef;
  impersonate?: string;
  network?: string;
  subnet?: string;
  imageProject?: string;
  diskGiB?: number;
  discoverLabel?: string;
}

export interface GcpProviderOptions {
  /** The fetch implementation (tests pass an emulating one). */
  fetch?: typeof fetch;
  /** Default `https://compute.<universeDomain>/compute/v1` (`https://compute.googleapis.com/compute/v1`). */
  endpoint?: string;
  /**
   * The Google Cloud universe this host runs in (default `googleapis.com`; a Trusted Partner Cloud
   * has its own domain). It sets the default compute endpoint, the IAM Credentials host, and the
   * only token endpoint a service-account key may name; a key's own `universe_domain` must match it
   * and never selects it. Malformed values are INVALID_CONFIG when the provider is built.
   */
  universeDomain?: string;
  /**
   * The host's own identity (a workload-identity client), used instead of the metadata server by
   * platform (root-tenant) accounts that name no `credentials`. Never overrides an account's
   * `credentials`, and never serves a tenant's account.
   */
  tokenSource?: TokenSource;
  /** Default 2000. Only used by in-call operation waits of at most 20 seconds. */
  operationPollMs?: number;
}
