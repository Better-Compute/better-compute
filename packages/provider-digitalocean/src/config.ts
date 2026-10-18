import { field, manifest, type SecretRef } from '@better-compute/core';

/** A DigitalOcean account's configuration: the token is a SecretRef, never a value. */
export const doConfig = manifest({
  token: field
    .secret()
    .describe('A personal access token, as a secret reference, with the scopes in the README'),
  regions: field
    .list(field.string(), { min: 1 })
    .describe('Region slugs the provider works in: offers and discovery are limited to these'),
  vpc: field
    .string()
    .optional()
    .describe(
      "VPC name or uuid that create uses when it gets no network; absent means the region's default VPC",
    ),
  defaultSshKey: field
    .string()
    .optional()
    .describe('Fingerprint of an account SSH key that is added to every Droplet'),
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
    .describe('Discovery yields only Droplets that carry this tag'),
  previews: field
    .boolean()
    .default(false)
    .describe('Offer products that DigitalOcean still marks as previews'),
});

/** The validated account configuration. */
export interface DoConfig {
  token: SecretRef;
  regions: string[];
  vpc?: string;
  defaultSshKey?: string;
  monitoring?: boolean;
  ipv6?: boolean;
  allowSpot?: boolean;
  discoverTag?: string;
  previews?: boolean;
}

export interface DoProviderOptions {
  /** The fetch implementation (tests pass an emulating one). */
  fetch?: typeof fetch;
  /** Default `https://api.digitalocean.com/v2`. A code-level option: it never comes from tenant config. */
  endpoint?: string;
  /** Trust-domain string, hashed into the deployment tag. Default `default`. */
  deployment?: string;
  /** How long a call may wait for a DigitalOcean action. Default 0, at most 20 000. */
  inCallWaitMs?: number;
  /** Request budget per token. Defaults 250 per minute and 5000 per hour (DigitalOcean's limits). */
  budget?: { perMinute?: number; perHour?: number };
}
