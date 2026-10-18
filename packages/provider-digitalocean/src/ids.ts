import { createHash } from 'node:crypto';
import { ComputeError } from '@better-compute/core';

/**
 * The tag keys better-compute puts on the Droplets it manages. DigitalOcean has no labels, only
 * flat tags, so a label travels as the tag `<key>:<value>`. The first five keys match the ones
 * `autoAttachLabels` (vps discovery) and provider-gcp use.
 */
export const labels = {
  managed: 'better-compute-managed',
  instance: 'better-compute-instance',
  tenant: 'better-compute-tenant',
  pool: 'better-compute-pool',
  owner: 'better-compute-owner',
  deployment: 'better-compute-deployment',
  key: 'better-compute-key',
} as const;

function invalid(message: string, reason: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message, undefined, {
    provider: 'digitalocean',
    reason,
  });
}

/** A machine's id: the Droplet id, as a decimal string. */
export function machineId(dropletId: number): string {
  return String(dropletId);
}

/** The Droplet id in a machine id; anything that is not a positive integer is `INVALID_INPUT`. */
export function parseMachineId(id: string): number {
  const dropletId = /^[1-9][0-9]{0,18}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(dropletId))
    throw invalid(`${JSON.stringify(id)} is not a DigitalOcean machine id`, 'machineId');
  return dropletId;
}

const regionPattern = /^[a-z][a-z0-9]*$/;
const sizePattern = /^[a-z0-9][a-z0-9._-]*$/;

/** An offer's id: `region/size`, plus `@spot` for spot capacity. */
export function offerId(region: string, size: string, spot?: boolean): string {
  return spot ? `${region}/${size}@spot` : `${region}/${size}`;
}

/** Splits an offer id; anything that is not an offer id is `INVALID_INPUT`. */
export function parseOfferId(id: string): { region: string; size: string; spot: boolean } {
  const slash = id.indexOf('/');
  const region = slash > 0 ? id.slice(0, slash) : '';
  const rest = slash > 0 ? id.slice(slash + 1) : '';
  const spot = rest.endsWith('@spot');
  const size = spot ? rest.slice(0, -'@spot'.length) : rest;
  if (!regionPattern.test(region) || !sizePattern.test(size))
    throw invalid(`${JSON.stringify(id)} is not a DigitalOcean offer id`, 'offerId');
  return { region, size, spot };
}

/** A Droplet name: `bc-` plus the lowercased instance id, `[a-z0-9-]`, at most 63 characters. */
export function dropletName(instanceId: string): string {
  const cleaned = instanceId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '');
  return `bc-${cleaned}`.slice(0, 63).replace(/-+$/, '');
}

const base32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 in lowercase, without padding. */
function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += base32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += base32[(acc << (5 - bits)) & 31];
  return out;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

const plainValue = /^[a-z0-9_-]{1,200}$/;

/**
 * The tag for a label. The value is lowercased; if what is left is `[a-z0-9_-]` and at most 200
 * characters it is kept, otherwise it becomes `x` plus 26 base32 characters of its SHA-256 (a hash
 * of the original value, so `Ann@x.com` and `ann@x.com` stay apart). A `:` never survives: it
 * would make the tag ambiguous to decode.
 */
export function tagFor(key: string, value: string): string {
  const lower = value.toLowerCase();
  const encoded = plainValue.test(lower) ? lower : `x${base32Lower(sha256(value)).slice(0, 26)}`;
  return `${key.toLowerCase()}:${encoded}`;
}

const managedPrefix = 'better-compute-';

/**
 * The labels in a Droplet's tags: the `better-compute-*` ones, split at the first colon and
 * lowercased (DO matches tags case-insensitively). The last of a duplicated key wins.
 */
export function labelsFromTags(tags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const colon = tag.indexOf(':');
    if (colon <= 0) continue;
    const key = tag.slice(0, colon).toLowerCase();
    if (key.startsWith(managedPrefix)) out[key] = tag.slice(colon + 1).toLowerCase();
  }
  return out;
}

/** The tag naming the deployment a Droplet belongs to; the deployment is hashed to stay short. */
export function deploymentTag(deployment: string): string {
  return tagFor(labels.deployment, sha256(deployment).toString('hex').slice(0, 12));
}

/** The tag carrying a create call's idempotency key (hashed), so a retry finds its Droplet. */
export function keyTag(idempotencyKey: string): string {
  return tagFor(labels.key, sha256(idempotencyKey).toString('hex').slice(0, 24));
}

/** The tag that makes a Droplet a member of a (virtual) network; DO has none of its own. */
export function networkMemberTag(network: string): string {
  return `bc-net-${sha256(network).toString('hex').slice(0, 16)}`;
}

/** Whether a tag is one better-compute wrote. */
export function isManagedTag(tag: string): boolean {
  return tag.startsWith(managedPrefix) || tag.startsWith('bc-');
}
