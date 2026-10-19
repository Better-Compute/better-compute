import { field, manifest, type SecretRef } from '@better-compute/core';
import type { TokenSource } from './auth.js';

/**
 * A BigQuery table id, `project.dataset.table`. A table name cannot be a query parameter, so the
 * reader puts it in the SQL between backticks: this pattern is what keeps that safe (no backtick,
 * whitespace or quote can pass). The project may be domain-scoped (`example.com:proj`).
 */
export const billingExportPattern =
  '^[a-z][a-z0-9.:-]{0,126}[a-z0-9]\\.[A-Za-z0-9_]{1,1024}\\.[A-Za-z0-9_-]{1,1024}$';

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
  federationAudience: field
    .string()
    .optional()
    .describe(
      'Workload identity pool provider (//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>): better-compute signs in as this account with no key',
    ),
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
  billingExport: field
    .string({ pattern: billingExportPattern, maxLength: 1024 })
    .optional()
    .describe(
      'The Cloud Billing detailed (resource-level) export table, "project.dataset.table": vps reads provider costs from it',
    ),
  billingExportLocation: field
    .string({ pattern: '^[A-Za-z][A-Za-z0-9-]{0,62}$' })
    .optional()
    .describe('The BigQuery location of the export dataset (US, EU, us-central1, …)'),
});

/** The validated account configuration. */
export interface GcpConfig {
  projectId: string;
  zones: string[];
  credentials?: SecretRef;
  impersonate?: string;
  federationAudience?: string;
  network?: string;
  subnet?: string;
  imageProject?: string;
  diskGiB?: number;
  discoverLabel?: string;
  /** `project.dataset.table` of the detailed billing export (provider costs, D10). */
  billingExport?: string;
  billingExportLocation?: string;
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
  /**
   * Default 10000. How long each network call of the federated-account check (`checkAccount`: STS,
   * IAM Credentials, the project read) may take before account creation is refused with a
   * retryable UNAVAILABLE `timeout`.
   */
  checkTimeoutMs?: number;
  /**
   * Default 30000. How long a provider-cost query (the BigQuery billing export) may wait for its job
   * to finish within one call; past it the read fails with a retryable UNAVAILABLE `jobTimeout`.
   */
  costQueryBudgetMs?: number;
  /** Default 1000. The pause between reads of an unfinished cost query. */
  costQueryPollMs?: number;
}
