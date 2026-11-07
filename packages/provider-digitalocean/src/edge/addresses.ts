import { isIPv4, isIPv6 } from 'node:net';
import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderAddresses,
  type ProviderAddressExpectation,
  type ProviderAddressSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoAction, DoDroplet } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { deploymentTag, labels, parseMachineId, tagFor } from '../ids.js';
import { carries } from '../storage/volumes.js';

// Reserved IPv4 and IPv6 addresses as provider addresses (P2). The address is its own id. DO
// gives a reserved IP no name and no tags, so nothing at DO says it is ours: the control plane's
// row is the record (DO-D6), `ensureAddress` finds an address only by the id an earlier ensure
// returned (`spec.id`), and an ensure without one reserves a new address. An answer to a reserve
// that never arrives is not retried here: the error stands and the address, if DO made it, is
// left for the operator (logged), which is cheaper than handing a tenant somebody else's address.
//
// The `fingerprint` output tells one reservation of an IP apart from a later one: a reserved
// IPv6's `reserved_at`. A reserved IPv4 has none. Its `project_id` is not one: every reserved IP
// better-compute makes lands in the account's default project, as do the owner's own, so a
// re-reservation of the same IP shows the same project. For IPv4 the control plane's own record
// is the only guard (vps keeps one live row per address, and an address gone at DO is lost for
// good there); this provider never presents the project as a fingerprint.
//
// What the provider can check, it does, before any write. An address only goes to a Droplet in
// its region that belongs to an instance of this deployment; one assigned to another Droplet is
// `CONFLICT` (DO's assign would move it silently); one assigned to a Droplet that is not this
// deployment's is never unassigned; an assigned address is never deleted. Assign and unassign
// are DO actions: a call reports `pending`/`deleting` while one runs (v4 shows it as `locked`; v6
// answers a second action with the 422 `has a pending event`) and starts nothing more.

export type AddressFamily = 'ipv4' | 'ipv6';

/** A reserved IPv4 address (`GET /reserved_ips/{ip}`). `locked` while an action runs. */
export interface DoReservedIp {
  ip: string;
  region: { slug: string; name?: string };
  droplet: DoDroplet | null;
  locked?: boolean;
  project_id?: string;
}

/** A reserved IPv6 address (`GET /reserved_ipv6/{ip}`). */
export interface DoReservedIpv6 {
  ip: string;
  region_slug: string;
  reserved_at?: string;
  droplet?: DoDroplet | null;
}

const instanceTagPrefix = `${labels.instance}:`;

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'UNSUPPORTED' | 'CONFLICT' | 'NOT_FOUND',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** An address id: a v4 or v6 address, by its family. Anything else is `INVALID_INPUT`. */
export function parseAddressId(id: string): { ip: string; family: AddressFamily } {
  if (isIPv4(id)) return { ip: id, family: 'ipv4' };
  if (isIPv6(id)) return { ip: id.toLowerCase(), family: 'ipv6' };
  throw fail('INVALID_INPUT', `${JSON.stringify(id)} is not a reserved IP address`, 'addressId');
}

/** One reserved address, either family, as this provider reads it. */
interface Address {
  ip: string;
  family: AddressFamily;
  region: string;
  droplet: DoDroplet | undefined;
  locked: boolean;
  /**
   * What tells this reservation apart from a later one at the same IP (reserved IPs carry no tags): IPv6 only, see
   * `fingerprintOf`.
   */
  fingerprint: string | undefined;
}

/**
 * A reserved IPv6's reservation time; undefined for a reserved IPv4, which has nothing that tells one reservation
 * from a later one (its project is shared by every reservation in the project), and when DO did not say.
 */
function fingerprintOf(found: { reserved_at?: string }): string | undefined {
  if (typeof found.reserved_at === 'string' && found.reserved_at !== '') return `reserved:${found.reserved_at}`;
  return undefined;
}

const state = (
  id: string,
  value: ProviderResourceState['state'],
  outputs?: Record<string, string>,
): ProviderResourceState => ({ id, state: value, ...(outputs ? { outputs } : {}) });

function outputs(address: Address): Record<string, string> {
  return {
    address: address.ip,
    family: address.family,
    region: address.region,
    ...(address.droplet ? { assignedTo: String(address.droplet.id) } : {}),
    ...(address.fingerprint ? { fingerprint: address.fingerprint } : {}),
  };
}

const paths: Readonly<Record<AddressFamily, string>> = {
  ipv4: '/reserved_ips',
  ipv6: '/reserved_ipv6',
};

export class DoAddresses implements ProviderAddresses {
  protected readonly client: DoClient;
  protected readonly config: DoConfig;
  protected readonly log: Logger;
  protected readonly deploymentTag: string;

  constructor(client: DoClient, config: DoConfig, deployment: string, log: Logger) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.deploymentTag = deploymentTag(deployment);
  }

  protected path(family: AddressFamily, ip: string): string {
    return `${paths[family]}/${encodeURIComponent(ip)}`;
  }

  /** The address, or undefined when it does not exist. */
  protected async address(id: string, signal: AbortSignal): Promise<Address | undefined> {
    const { ip, family } = parseAddressId(id);
    try {
      if (family === 'ipv4') {
        const { reserved_ip: found } = await this.client.request<{ reserved_ip: DoReservedIp }>(
          'GET',
          this.path(family, ip),
          { signal, budget: 'observe' },
        );
        return {
          ip: found.ip,
          family,
          region: found.region.slug,
          droplet: found.droplet ?? undefined,
          locked: found.locked === true,
          // A reserved IPv4 has no fingerprint (its project is no reservation's own).
          fingerprint: undefined,
        };
      }
      const { reserved_ipv6: found } = await this.client.request<{
        reserved_ipv6: DoReservedIpv6;
      }>('GET', this.path(family, ip), { signal, budget: 'observe' });
      return {
        ip: found.ip.toLowerCase(),
        family,
        region: found.region_slug,
        droplet: found.droplet ?? undefined,
        locked: false,
        fingerprint: fingerprintOf(found),
      };
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  protected async existing(id: string, signal: AbortSignal): Promise<Address> {
    const address = await this.address(id, signal);
    if (!address)
      throw new ComputeError('NOT_FOUND', `reserved IP ${id} does not exist`, undefined, {
        provider: 'digitalocean',
        id,
        reason: 'addressGone',
      });
    return address;
  }

  /**
   * Refuses an address that is not the one vps recorded (reserved IPs carry no tags, DO-D16): another region, or
   * another reservation at the same IP (its fingerprint differs, or DO no longer shows one).
   */
  protected refuseStranger(address: Address, expected: ProviderAddressExpectation | undefined): void {
    if (!expected) return;
    const region = expected.region !== undefined && expected.region !== address.region;
    const fingerprint =
      expected.fingerprint !== undefined && expected.fingerprint !== address.fingerprint;
    if (region || fingerprint)
      throw fail(
        'INVALID_STATE',
        `reserved IP ${address.ip} is not the address this better-compute deployment reserved (${region ? 'another region' : 'another reservation'}); it is never changed by it`,
        'notManaged',
      );
  }

  /** Whether a Droplet belongs to an instance of this deployment (with `instanceId`, that one). */
  protected instanceOf(droplet: DoDroplet, instanceId?: string): boolean {
    const tags = droplet.tags ?? [];
    if (!carries(tags, this.deploymentTag)) return false;
    return instanceId === undefined
      ? tags.some((t) => t.toLowerCase().startsWith(instanceTagPrefix))
      : carries(tags, tagFor(labels.instance, instanceId));
  }

  /**
   * Starts an assign or unassign. A 422 `has a pending event` means one still runs: undefined,
   * which the caller reports as busy.
   */
  protected async act(
    address: Address,
    body: { type: 'assign'; droplet_id: number } | { type: 'unassign' },
    signal: AbortSignal,
  ): Promise<DoAction | undefined> {
    try {
      const reply = await this.client.request<{ action?: DoAction }>(
        'POST',
        `${this.path(address.family, address.ip)}/actions`,
        { body, signal, budget: 'mutate' },
      );
      this.log.info('digitalocean.addressAction', {
        address: address.ip,
        type: body.type,
        action: reply.action?.id,
      });
      return reply.action;
    } catch (error) {
      if (isComputeError(error, 'CONFLICT') && error.details?.reason === 'actionPending')
        return undefined;
      throw error;
    }
  }

  // ------------------------------------------------------------------------------- ensure, get

  async ensureAddress(spec: ProviderAddressSpec, ctx: CallContext): Promise<ProviderResourceState> {
    if (spec.family !== 'ipv4' && spec.family !== 'ipv6')
      throw fail(
        'INVALID_INPUT',
        `address family ${String(spec.family)} is not ipv4 or ipv6`,
        'family',
      );
    if ((spec.source !== undefined && spec.source !== 'pool') || spec.prefix !== undefined)
      throw fail(
        'UNSUPPORTED',
        'reserved IPs from your own prefix (BYOIP) are not supported on DigitalOcean yet',
        'byoip',
      );
    if (!this.config.regions.includes(spec.region))
      throw fail('INVALID_INPUT', `region ${spec.region} is not one this account uses`, 'region');
    const { signal } = ctx;
    if (spec.id !== undefined) {
      const { family } = parseAddressId(spec.id);
      if (family !== spec.family)
        throw fail('INVALID_INPUT', `${spec.id} is not an ${spec.family} address`, 'family');
      const address = await this.existing(spec.id, signal);
      if (spec.fingerprint !== undefined) this.refuseStranger(address, { fingerprint: spec.fingerprint });
      if (address.region !== spec.region)
        throw fail(
          'INVALID_STATE',
          `reserved IP ${address.ip} is in ${address.region}, not ${spec.region}; an address does not move between regions`,
          'region',
        );
      return state(address.ip, 'ready', outputs(address));
    }
    let ip: string | undefined;
    let fingerprint: string | undefined;
    try {
      if (spec.family === 'ipv4') {
        const reply = await this.client.request<{ reserved_ip?: DoReservedIp }>(
          'POST',
          paths.ipv4,
          { body: { region: spec.region }, signal, budget: 'mutate' },
        );
        ip = reply.reserved_ip?.ip;
      } else {
        const reply = await this.client.request<{ reserved_ipv6?: DoReservedIpv6 }>(
          'POST',
          paths.ipv6,
          { body: { region_slug: spec.region }, signal, budget: 'mutate' },
        );
        ip = reply.reserved_ipv6?.ip.toLowerCase();
        fingerprint = reply.reserved_ipv6 ? fingerprintOf(reply.reserved_ipv6) : undefined;
      }
    } catch (error) {
      if (isComputeError(error, 'UNAVAILABLE'))
        this.log.warn('digitalocean.reserveUnconfirmed', {
          region: spec.region,
          family: spec.family,
          name: spec.name,
        });
      throw error;
    }
    if (ip === undefined || parseAddressId(ip).family !== spec.family)
      throw new ComputeError(
        'PROVIDER_ERROR',
        'DigitalOcean accepted a reserved IP but returned no address',
        undefined,
        { provider: 'digitalocean', reason: 'badBody' },
      );
    this.log.info('digitalocean.addressReserved', { address: ip, name: spec.name });
    return state(ip, 'ready', {
      address: ip,
      family: spec.family,
      region: spec.region,
      ...(fingerprint ? { fingerprint } : {}),
    });
  }

  async getAddress(id: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    if (!isIPv4(id) && !isIPv6(id)) return undefined;
    const address = await this.address(id, ctx.signal);
    if (!address) return undefined;
    return state(address.ip, address.locked ? 'updating' : 'ready', outputs(address));
  }

  // ----------------------------------------------------------------------- assign, unassign

  async assignAddress(
    addressId: string,
    machineId: string,
    ctx: CallContext,
    instanceId?: string,
  ): Promise<ProviderResourceState> {
    parseAddressId(addressId);
    const dropletId = parseMachineId(machineId);
    const { signal } = ctx;
    const address = await this.existing(addressId, signal);
    if (address.droplet?.id === dropletId)
      return state(address.ip, address.locked ? 'pending' : 'ready', outputs(address));
    if (address.droplet)
      throw fail(
        'CONFLICT',
        `reserved IP ${address.ip} is assigned to Droplet ${address.droplet.id}; unassign it first`,
        'assignedElsewhere',
      );
    if (address.locked) return state(address.ip, 'pending', outputs(address));
    let droplet: DoDroplet;
    try {
      droplet = (
        await this.client.request<{ droplet: DoDroplet }>('GET', `/droplets/${dropletId}`, {
          signal,
          budget: 'observe',
        })
      ).droplet;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND'))
        throw fail('NOT_FOUND', `Droplet ${dropletId} does not exist`, 'machine');
      throw error;
    }
    if (droplet.region.slug !== address.region)
      throw fail(
        'INVALID_INPUT',
        `reserved IP ${address.ip} is in ${address.region} and Droplet ${droplet.id} in ${droplet.region.slug}: an address is assigned only in its region`,
        'region',
      );
    if (!this.instanceOf(droplet, instanceId))
      throw fail(
        'INVALID_STATE',
        instanceId === undefined
          ? `Droplet ${droplet.id} does not belong to an instance of this better-compute deployment`
          : `Droplet ${droplet.id} does not belong to instance ${instanceId}`,
        'notInstance',
      );
    const action = await this.act(address, { type: 'assign', droplet_id: dropletId }, signal);
    if (action?.status === 'completed') {
      const fresh = await this.address(address.ip, signal);
      if (fresh?.droplet?.id === dropletId) return state(fresh.ip, 'ready', outputs(fresh));
    }
    if (action?.status === 'errored')
      return {
        ...state(address.ip, 'error', outputs(address)),
        message: `DigitalOcean's assign of reserved IP ${address.ip} errored; the next call tries again`,
      };
    return state(address.ip, 'pending', outputs(address));
  }

  async unassignAddress(addressId: string, ctx: CallContext): Promise<ProviderResourceState> {
    parseAddressId(addressId);
    const { signal } = ctx;
    const address = await this.address(addressId, signal);
    if (!address) return state(addressId, 'deleted');
    if (!address.droplet)
      return state(address.ip, address.locked ? 'deleting' : 'deleted', outputs(address));
    if (!this.instanceOf(address.droplet))
      throw fail(
        'INVALID_STATE',
        `reserved IP ${address.ip} is assigned to Droplet ${address.droplet.id}, which is not an instance of this better-compute deployment; it is never unassigned by it`,
        'notInstance',
      );
    if (address.locked) return state(address.ip, 'deleting', outputs(address));
    const action = await this.act(address, { type: 'unassign' }, signal);
    if (action?.status === 'completed') {
      const fresh = await this.address(address.ip, signal);
      if (!fresh?.droplet) return state(address.ip, 'deleted');
    }
    if (action?.status === 'errored')
      return {
        ...state(address.ip, 'error', outputs(address)),
        message: `DigitalOcean's unassign of reserved IP ${address.ip} errored; the next call tries again`,
      };
    return state(address.ip, 'deleting', outputs(address));
  }

  async deleteAddress(
    addressId: string,
    ctx: CallContext,
    expected?: ProviderAddressExpectation,
  ): Promise<ProviderResourceState> {
    const { ip, family } = parseAddressId(addressId);
    const { signal } = ctx;
    const address = await this.address(ip, signal);
    if (!address) return state(ip, 'deleted');
    this.refuseStranger(address, expected);
    if (address.droplet)
      throw fail(
        'INVALID_STATE',
        `reserved IP ${address.ip} is assigned to Droplet ${address.droplet.id}; unassign it first`,
        'assigned',
      );
    if (address.locked) return state(address.ip, 'deleting', outputs(address));
    try {
      await this.client.request('DELETE', this.path(family, address.ip), {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log.info('digitalocean.addressReleased', { address: address.ip });
    return state(address.ip, 'deleted');
  }
}
