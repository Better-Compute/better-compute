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
    .describe('Service-account key JSON, as a secret reference; absent means the metadata server'),
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
  /** Default `https://compute.googleapis.com/compute/v1`. */
  endpoint?: string;
  /** Overrides `credentials` and the metadata server (a host's workload-identity client). */
  tokenSource?: TokenSource;
  /** Default 2000. Only used by in-call operation waits of at most 20 seconds. */
  operationPollMs?: number;
}
