import { isIP } from 'node:net';
import type { CloudInterface, SystemSection } from '@better-compute/protocol';

// The system section's `cloud` (PLAN.md §10.1; DigitalOcean program P3): what bcd read from the
// cloud's instance metadata service on a Droplet. It is node-reported and unsigned, so it is
// inventory only (advisory, like every tenant-controlled node's inventory): never an identity,
// never a join or attestation input, never a placement label. bcd already drops anything malformed;
// this normalizes again, because the control plane does not trust the node to have done so.

/** A cloud instance as inventory shows it. */
export interface CloudInstanceInfo {
  /** `digitalocean`. */
  provider: string;
  /** The provider's instance id (a Droplet id, decimal). */
  instanceId: string;
  /** Region slug (`nyc3`). */
  region: string;
  /** Sorted, unique, at most {@link maxCloudTags}. */
  tags: string[];
  /** Sorted by network, then MAC; at most {@link maxCloudInterfaces}. */
  interfaces: CloudInterfaceInfo[];
}

export interface CloudInterfaceInfo {
  network: 'public' | 'private';
  /** Lowercase. */
  mac: string;
  ipv4?: { address: string; netmask?: string; gateway?: string };
  ipv6?: { address: string; prefixLength: number; gateway?: string };
}

export const maxCloudTags = 128;
export const maxCloudInterfaces = 16;

const providerPattern = /^[a-z][a-z0-9-]{0,31}$/;
const regionPattern = /^[a-z][a-z0-9-]{0,31}$/;
// DigitalOcean tag names: letters, digits, colons, dashes and underscores, at most 255.
const tagPattern = /^[A-Za-z0-9:_-]{1,255}$/;
const macPattern = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
/** Instance ids per provider; a provider without one here is refused. */
const instanceIdPatterns: Readonly<Record<string, RegExp>> = { digitalocean: /^[1-9][0-9]{0,19}$/ };

const optional = (value: string): string | undefined => (value === '' ? undefined : value);

function cloudInterface(nic: CloudInterface): CloudInterfaceInfo | undefined {
  if (nic.network !== 'public' && nic.network !== 'private') return undefined;
  const mac = nic.mac.toLowerCase();
  if (!macPattern.test(mac)) return undefined;
  const info: CloudInterfaceInfo = { network: nic.network, mac };
  if (isIP(nic.ipv4Address) === 4) {
    const ipv4: NonNullable<CloudInterfaceInfo['ipv4']> = { address: nic.ipv4Address };
    const netmask = optional(nic.ipv4Netmask);
    const gateway = optional(nic.ipv4Gateway);
    if (netmask && isIP(netmask) === 4) ipv4.netmask = netmask;
    if (gateway && isIP(gateway) === 4) ipv4.gateway = gateway;
    info.ipv4 = ipv4;
  }
  if (isIP(nic.ipv6Address) === 6 && nic.ipv6PrefixLength >= 1 && nic.ipv6PrefixLength <= 128) {
    const ipv6: NonNullable<CloudInterfaceInfo['ipv6']> = { address: nic.ipv6Address, prefixLength: nic.ipv6PrefixLength };
    const gateway = optional(nic.ipv6Gateway);
    if (gateway && isIP(gateway) === 6) ipv6.gateway = gateway;
    info.ipv6 = ipv6;
  }
  return info;
}

/**
 * The cloud instance a node's system section names, or undefined: off a cloud, from a daemon that
 * does not report it, or when the provider, instance id or region is malformed. Malformed tags and
 * interfaces are dropped; what is left is sorted and capped.
 */
export function cloudInstanceOf(system: SystemSection | undefined): CloudInstanceInfo | undefined {
  const cloud = system?.cloud;
  if (!cloud) return undefined;
  const idPattern = instanceIdPatterns[cloud.provider];
  if (!providerPattern.test(cloud.provider) || !idPattern?.test(cloud.instanceId) || !regionPattern.test(cloud.region))
    return undefined;
  const tags = [...new Set(cloud.tags.filter((tag) => tagPattern.test(tag)))].sort().slice(0, maxCloudTags);
  const interfaces = cloud.interfaces
    .map(cloudInterface)
    .filter((nic): nic is CloudInterfaceInfo => nic !== undefined)
    .sort((a, b) => (a.network === b.network ? (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0) : a.network < b.network ? -1 : 1))
    .slice(0, maxCloudInterfaces);
  return { provider: cloud.provider, instanceId: cloud.instanceId, region: cloud.region, tags, interfaces };
}
