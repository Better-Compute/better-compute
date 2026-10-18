import {
  ComputeError,
  isComputeError,
  type ExternalMachine,
  type Logger,
  type NetworkRef,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { untilAborted } from '../compute/abort.js';
import type { DoVpc } from '../compute/types.js';
import { cidrRange } from './firewalls.js';

// Subnets as DO VPCs (DO-D9). DO VPCs are regional and the contract's network is global, so each
// subnet is a VPC of its own, named as the subnet, whose description `bc:network=<network>` ties
// it to its network. The account's VPCs are read through a per-client cache that lives a minute:
// naming the network of a Droplet's VPC (ruling R2) and finding a tagged Droplet's network go by
// it; a call that must be right now (a create, a delete) reads afresh, which refreshes it too.

/** How long the VPC list is reused for naming networks. */
const vpcTtlMs = 60_000;
/** A load that no caller waits for any more still ends. */
const loadTimeoutMs = 60_000;

const descriptionPrefix = 'bc:network=';
/** DO's limit on a VPC description. */
const maxDescription = 255;
const vpcNamePattern = /^[a-zA-Z0-9.-]{1,255}$/;

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** The description that ties a VPC to its network. */
export function networkDescription(network: string): string {
  return `${descriptionPrefix}${network}`;
}

/** The network a VPC belongs to, by its description; undefined for a VPC that isn't ours. */
export function networkOfVpc(vpc: Pick<DoVpc, 'description'>): string | undefined {
  const description = vpc.description ?? '';
  return description.startsWith(descriptionPrefix) && description.length > descriptionPrefix.length
    ? description.slice(descriptionPrefix.length)
    : undefined;
}

/** The private ranges of RFC 1918, which DO's VPC ranges must lie in. */
const rfc1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((cidr) => cidrRange(cidr)!);

/**
 * Refuses, before any call, a subnet DO would refuse (research S3): its range must be an IPv4
 * CIDR in RFC 1918 with a prefix from /16 to /28, its name a VPC name, and its description fit.
 */
export function checkSubnet(spec: { name: string; network: string; cidr: string }): void {
  if (!vpcNamePattern.test(spec.name))
    throw fail(
      'INVALID_INPUT',
      `subnet name ${JSON.stringify(spec.name)} can't be a DigitalOcean VPC name`,
      'subnetName',
    );
  if (networkDescription(spec.network).length > maxDescription)
    throw fail('INVALID_INPUT', `network name ${spec.network} is too long`, 'networkName');
  const [address = '', prefixText = ''] = spec.cidr.split('/');
  const range = cidrRange(spec.cidr);
  const prefix = Number(prefixText);
  const inPrivate =
    range !== undefined &&
    !range.v6 &&
    rfc1918.some((block) => block.start <= range.start && range.end <= block.end);
  if (
    !range ||
    range.v6 ||
    !/^[0-9]{1,2}$/.test(prefixText) ||
    prefix < 16 ||
    prefix > 28 ||
    !inPrivate ||
    // The range must start at its network address, as DO stores it.
    cidrRange(address)!.start !== range.start
  )
    throw fail(
      'INVALID_INPUT',
      `subnet range ${JSON.stringify(spec.cidr)}: a DigitalOcean VPC range is an RFC 1918 IPv4 CIDR from /16 to /28`,
      'cidr',
    );
}

interface CacheEntry {
  loadedAt: number;
  vpcs: Promise<readonly DoVpc[]>;
}

/** Per client, so a test (or a second account) never sees another's VPCs. */
const caches = new WeakMap<DoClient, CacheEntry>();

async function load(client: DoClient, signal: AbortSignal): Promise<readonly DoVpc[]> {
  const vpcs: DoVpc[] = [];
  for await (const vpc of client.pages<DoVpc>('/vpcs', 'vpcs', { signal, budget: 'observe' }))
    vpcs.push(vpc);
  return vpcs;
}

/**
 * The account's VPCs. With `fresh` they are read now; otherwise a read from the last minute is
 * reused. Concurrent callers share one load, which runs on its own signal: one caller's abort
 * cancels only that caller's wait. A failed load is dropped so the next call retries.
 */
export function accountVpcs(
  client: DoClient,
  signal: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<readonly DoVpc[]> {
  const now = client.clock.now();
  const cached = caches.get(client);
  if (!options.fresh && cached && now - cached.loadedAt < vpcTtlMs)
    return untilAborted(cached.vpcs, signal);
  const entry: CacheEntry = {
    loadedAt: now,
    vpcs: load(client, AbortSignal.timeout(loadTimeoutMs)),
  };
  caches.set(client, entry);
  entry.vpcs.catch(() => {
    if (caches.get(client) === entry) caches.delete(client);
  });
  return untilAborted(entry.vpcs, signal);
}

/**
 * A VPC lookup for one call: by the cached list, which a miss refreshes at most once per call (a
 * VPC made in the last minute is found; a uuid that names no VPC costs one read, not one per
 * Droplet).
 */
export function vpcLookup(
  client: DoClient,
  signal: AbortSignal,
): (id: string) => Promise<DoVpc | undefined> {
  let refreshed = false;
  return async (id) => {
    const found = (await accountVpcs(client, signal)).find((vpc) => vpc.id === id);
    if (found || refreshed) return found;
    refreshed = true;
    return (await accountVpcs(client, signal, { fresh: true })).find((vpc) => vpc.id === id);
  };
}

/**
 * Names the network of each machine of one call (ruling R2): `toMachine` gives the VPC's uuid;
 * this makes it the network a VPC of ours belongs to, or else the VPC's name. A uuid that names
 * no VPC stays as it is. The name is for display (vps shows it as the machine's NIC), so a VPC
 * list that can't be read (a token without `vpc:read`, a 5xx) leaves the uuids of the rest of
 * the call as they are rather than failing a `get` or a `list`.
 */
export function networkNamer(
  client: DoClient,
  signal: AbortSignal,
  log: Logger,
): (machine: ExternalMachine) => Promise<ExternalMachine> {
  const lookup = vpcLookup(client, signal);
  let unreadable = false;
  return async (machine) => {
    const [first, ...rest] = machine.networks ?? [];
    if (!first || unreadable) return machine;
    let vpc: DoVpc | undefined;
    try {
      vpc = await lookup(first.network);
    } catch (error) {
      if (signal.aborted) throw error;
      unreadable = true;
      log.warn('digitalocean.vpcListUnreadable', {
        error: isComputeError(error) ? error.code : 'unknown',
      });
      return machine;
    }
    if (!vpc) return machine;
    return {
      ...machine,
      networks: [{ ...first, network: networkOfVpc(vpc) ?? vpc.name }, ...rest],
    };
  };
}

/**
 * The VPC a create on a tenant network joins. With `subnet`, the VPC of that name, which must be
 * the network's and in the offer's region; without, the network's VPC in that region.
 */
export async function vpcForNetwork(
  client: DoClient,
  ref: NetworkRef,
  region: string,
  signal: AbortSignal,
): Promise<DoVpc> {
  const vpcs = await accountVpcs(client, signal, { fresh: true });
  if (ref.subnet !== undefined) {
    const vpc = vpcs.find((v) => v.name === ref.subnet);
    if (!vpc) throw fail('INVALID_STATE', `subnet ${ref.subnet} does not exist (yet)`, 'noSubnet');
    if (vpc.region !== region)
      throw fail(
        'INVALID_INPUT',
        `subnet ${ref.subnet} is in ${vpc.region}, not in the offer's region ${region}`,
        'subnetRegion',
      );
    if (networkOfVpc(vpc) !== ref.network)
      throw fail(
        'INVALID_STATE',
        `VPC ${ref.subnet} is not a subnet of network ${ref.network}`,
        'subnetNetwork',
      );
    return vpc;
  }
  const inRegion = vpcs
    .filter((v) => v.region === region && networkOfVpc(v) === ref.network)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!inRegion[0])
    throw fail(
      'INVALID_STATE',
      `network ${ref.network} has no subnet in ${region}`,
      'noSubnetInRegion',
    );
  return inRegion[0];
}
