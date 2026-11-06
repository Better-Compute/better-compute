import { field, manifest, type SecretRef } from '@better-compute/core';
import type { DoOAuthOptions } from './ops/oauth.js';

/**
 * A DigitalOcean account's configuration: the credential is a SecretRef, never a value. An account holds exactly one
 * of `token` (a personal access token) and `refreshToken` (an OAuth connection, P9).
 */
export const doConfig = manifest({
  token: field
    .secret()
    .optional()
    .describe('A personal access token, as a secret reference, with the scopes in the README'),
  refreshToken: field
    .secret()
    .optional()
    .describe(
      'An OAuth refresh token from "Connect a DigitalOcean account", as a secret reference; rotated on every exchange',
    ),
  regions: field
    .list(field.string(), { min: 1 })
    .describe('Region slugs the provider works in: offers and discovery are limited to these'),
  vpc: field
    .string()
    .optional()
    .describe(
      "VPC name or uuid that create uses when it gets no network; absent means the region's default VPC",
    ),
  sshKeyFingerprint: field
    .string()
    .optional()
    .describe(
      'MD5 fingerprint of an account SSH key that is added to every Droplet (a fingerprint, not a secret)',
    ),
  monitoring: field
    .boolean()
    .default(true)
    .describe('Install the DigitalOcean metrics agent on new Droplets'),
  ipv6: field.boolean().default(false).describe('Give new Droplets an IPv6 address'),
  allowSpot: field
    .boolean()
    .default(false)
    .describe('Offer Spot capacity where DigitalOcean has it'),
  discoverTag: field
    .string()
    .optional()
    .describe(
      'Discovery yields only Droplets that carry this tag (lower-case [a-z0-9:_-], at most 255)',
    ),
  previews: field
    .boolean()
    .default(false)
    .describe('Offer products that DigitalOcean still marks as previews'),
  costs: field
    .boolean()
    .default(false)
    .describe(
      'Read the invoices into provider costs (vps.costs); the token needs the billing:read scope',
    ),
  projectPerTenant: field
    .boolean()
    .default(false)
    .describe(
      'Assign each new Droplet to the project bc-<tenant>, made on first use (project:read, project:create, project:update)',
    ),
});

/** The validated account configuration. */
export interface DoConfig {
  token?: SecretRef;
  refreshToken?: SecretRef;
  regions: string[];
  vpc?: string;
  sshKeyFingerprint?: string;
  monitoring?: boolean;
  ipv6?: boolean;
  allowSpot?: boolean;
  discoverTag?: string;
  previews?: boolean;
  costs?: boolean;
  projectPerTenant?: boolean;
}

export interface DoProviderOptions {
  /** The fetch implementation (tests pass an emulating one). */
  fetch?: typeof fetch;
  /** Default `https://api.digitalocean.com/v2`. A code-level option: it never comes from tenant config. */
  endpoint?: string;
  /** Trust-domain string, hashed into the deployment tag. Default `default`. */
  deployment?: string;
  /**
   * How long a call may wait for a DigitalOcean action. Default 0, at most 20 000. Accepted and
   * checked, but it has no effect yet: every call starts its action and returns.
   */
  inCallWaitMs?: number;
  /** (P9) OAuth accounts: the platform OAuth app and the hook that writes rotated refresh tokens back. */
  oauth?: DoOAuthOptions;
  /** Request budget per token. Defaults 250 per minute and 5000 per hour (DigitalOcean's limits). */
  budget?: { perMinute?: number; perHour?: number };
}
