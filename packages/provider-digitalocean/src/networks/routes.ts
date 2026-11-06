import { isIPv4 } from 'node:net';
import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderResourceState,
  type ProviderRouteRef,
  type ProviderRouteSpec,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoDroplet, DoVpc } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { inIpv4Cidr } from '../edge/addresses.js';
import { deploymentHash, deploymentTag, parseMachineId } from '../ids.js';
import { carries } from '../storage/volumes.js';
import type { DoNatGateway } from './nat.js';
import { vpcForNetwork } from './vpcs.js';

// VPC routes (P4, preview). DigitalOcean's VPC Routes API is a public preview whose shape is
// unverified (DO-D23): routes live under `/vpcs/{vpc}/routes`, each with a name, a destination
// CIDR and a next hop (`nat_gateway` by id, `droplet` by id, or `ip`). The provider offers
// `ensureRoute`/`deleteRoute` only on an account with `previews: true`.
//
// A subnet is a VPC (DO-D9), so a route of a subnet is a route of its VPC. DO gives a route no tags,
// so the name carries the ownership, as a NAT gateway's does: vps's name plus this deployment's
// hash; a route without that suffix is never changed or deleted. Every next hop is checked before
// any write: a NAT gateway must be one of ours that serves the VPC, a Droplet one of this
// deployment's in the VPC, an address inside the VPC's range. A route is immutable: another
// destination or next hop under the same name is `INVALID_STATE` (`replace`). Teardown is ordered:
// `deleteSubnet` deletes our routes of the VPC first and stays `pending` while any route is left.

/** A VPC route as this provider reads it (shape unverified). */
export interface DoVpcRoute {
  id: string;
  name: string;
  vpc_uuid?: string;
  destination: string;
  next_hop: { type: 'nat_gateway' | 'droplet' | 'ip' | string; id?: string | number; ip?: string };
  status?: 'PENDING' | 'ACTIVE' | 'ERROR' | string;
  created_at?: string;
}

type DoNextHop = { type: 'nat_gateway'; id: string } | { type: 'droplet'; id: number } | { type: 'ip'; ip: string };

const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,49}[a-z0-9])?$/;

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'UNSUPPORTED',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** An IPv4 CIDR whose base is its network address (`10.0.0.0/8`, not `10.1.0.0/8`). */
export function isIpv4Network(cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  if (base === undefined || bits === undefined || !isIPv4(base)) return false;
  if (!inIpv4Cidr(base, cidr)) return false;
  const n = Number(bits);
  const value = base.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  return value % 2 ** (32 - n) === 0;
}

/** Oldest first: by creation time, then by id. */
function byAge(a: DoVpcRoute, b: DoVpcRoute): number {
  const at = Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '');
  return Number.isFinite(at) && at !== 0 ? at : a.id.localeCompare(b.id);
}

function sameHop(route: DoVpcRoute, hop: DoNextHop): boolean {
  const found = route.next_hop;
  if (found?.type !== hop.type) return false;
  return hop.type === 'ip' ? found.ip === hop.ip : String(found.id) === String(hop.id);
}

function hopText(hop: DoVpcRoute['next_hop']): string {
  return hop.type === 'ip' ? `ip:${String(hop.ip)}` : `${hop.type}:${String(hop.id)}`;
}

function routeState(route: DoVpcRoute): ProviderResourceState {
  const outputs = { destination: route.destination, nextHop: hopText(route.next_hop) };
  if (route.status === 'ERROR')
    return {
      id: route.id,
      state: 'error',
      outputs,
      message: `DigitalOcean reports route ${route.id} ERROR`,
    };
  return { id: route.id, state: route.status === 'PENDING' ? 'pending' : 'ready', outputs };
}

export class DoRoutes {
  protected readonly client: DoClient;
  protected readonly config: DoConfig;
  protected readonly log: Logger | undefined;
  protected readonly deploymentTag: string;
  /** `-<hash12>`: the suffix every route name of ours ends with. */
  protected readonly suffix: string;

  constructor(client: DoClient, config: DoConfig, deployment: string, log?: Logger) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.deploymentTag = deploymentTag(deployment);
    this.suffix = `-${deploymentHash(deployment)}`;
  }

  isOurs(route: DoVpcRoute): boolean {
    return (
      typeof route.name === 'string' &&
      route.name.endsWith(this.suffix) &&
      namePattern.test(route.name.slice(0, -this.suffix.length))
    );
  }

  protected validate(ref: ProviderRouteRef): void {
    if (typeof ref.name !== 'string' || !namePattern.test(ref.name))
      throw fail(
        'INVALID_INPUT',
        `route name ${JSON.stringify(ref.name)} is not [a-z0-9-], at most 51 characters`,
        'name',
      );
    if (!this.config.regions.includes(ref.region))
      throw fail('INVALID_INPUT', `region ${ref.region} is not one this account uses`, 'region');
  }

  protected async list(vpc: DoVpc, signal: AbortSignal): Promise<DoVpcRoute[]> {
    const out: DoVpcRoute[] = [];
    for await (const route of this.client.pages<DoVpcRoute>(
      `/vpcs/${encodeURIComponent(vpc.id)}/routes`,
      'routes',
      { signal, budget: 'observe' },
    ))
      out.push(route);
    return out.sort(byAge);
  }

  protected async remove(vpc: DoVpc, route: DoVpcRoute, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request(
        'DELETE',
        `/vpcs/${encodeURIComponent(vpc.id)}/routes/${encodeURIComponent(route.id)}`,
        { signal, budget: 'mutate' },
      );
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log?.info('digitalocean.routeDeleted', { route: route.id, vpc: vpc.id });
  }

  /** The DO next hop for the spec's, checked to be this deployment's and inside the VPC. */
  protected async nextHop(
    spec: ProviderRouteSpec,
    vpc: DoVpc,
    signal: AbortSignal,
  ): Promise<DoNextHop> {
    const hop = spec.nextHop;
    if (hop?.kind === 'address') {
      if (typeof hop.id !== 'string' || !isIPv4(hop.id))
        throw fail('INVALID_INPUT', `next hop ${JSON.stringify(hop.id)} is not an IPv4 address`, 'nextHop');
      if (vpc.ip_range === undefined || !inIpv4Cidr(hop.id, vpc.ip_range))
        throw fail(
          'INVALID_INPUT',
          `next hop ${hop.id} is not inside subnet ${spec.subnet} (${vpc.ip_range ?? 'no range'})`,
          'nextHop',
        );
      return { type: 'ip', ip: hop.id };
    }
    if (hop?.kind === 'natGateway') {
      if (typeof hop.id !== 'string' || !/^[0-9a-f-]{1,64}$/i.test(hop.id))
        throw fail('INVALID_INPUT', `next hop ${JSON.stringify(hop.id)} is not a NAT gateway id`, 'nextHop');
      let gateway: DoNatGateway;
      try {
        gateway = (
          await this.client.request<{ nat_gateway: DoNatGateway }>(
            'GET',
            `/nat_gateways/${encodeURIComponent(hop.id)}`,
            { signal, budget: 'observe' },
          )
        ).nat_gateway;
      } catch (error) {
        if (isComputeError(error, 'NOT_FOUND'))
          throw fail('INVALID_STATE', `NAT gateway ${hop.id} does not exist`, 'nextHop');
        throw error;
      }
      // A gateway of ours carries the same deployment suffix (natGatewayName).
      const ours =
        gateway.name.endsWith(this.suffix) &&
        namePattern.test(gateway.name.slice(0, -this.suffix.length));
      if (!ours || !gateway.vpcs.some((v) => v.vpc_uuid === vpc.id))
        throw fail(
          'INVALID_STATE',
          `NAT gateway ${hop.id} is not one of this deployment's that serves subnet ${spec.subnet}`,
          'nextHop',
        );
      return { type: 'nat_gateway', id: gateway.id };
    }
    if (hop?.kind === 'machine') {
      const dropletId = parseMachineId(hop.id);
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
          throw fail('INVALID_STATE', `Droplet ${dropletId} does not exist`, 'nextHop');
        throw error;
      }
      if (!carries(droplet.tags ?? [], this.deploymentTag) || droplet.vpc_uuid !== vpc.id)
        throw fail(
          'INVALID_STATE',
          `Droplet ${dropletId} is not a machine of this deployment in subnet ${spec.subnet}`,
          'nextHop',
        );
      return { type: 'droplet', id: dropletId };
    }
    throw fail(
      'INVALID_INPUT',
      `next hop kind ${JSON.stringify((hop as { kind?: unknown } | undefined)?.kind)} is not natGateway, machine or address`,
      'nextHop',
    );
  }

  async ensure(spec: ProviderRouteSpec, ctx: CallContext): Promise<ProviderResourceState> {
    this.validate(spec);
    if (typeof spec.destination !== 'string' || !isIpv4Network(spec.destination))
      throw fail(
        'INVALID_INPUT',
        `destination ${JSON.stringify(spec.destination)} is not an IPv4 network CIDR`,
        'destination',
      );
    const { signal } = ctx;
    const vpc = await vpcForNetwork(
      this.client,
      { network: spec.network, subnet: spec.subnet },
      spec.region,
      signal,
    );
    const hop = await this.nextHop(spec, vpc, signal);
    const doName = `${spec.name}${this.suffix}`;
    const [oldest, ...younger] = (await this.list(vpc, signal)).filter(
      (route) => route.name === doName && this.isOurs(route),
    );
    for (const twin of younger) await this.remove(vpc, twin, signal);
    if (oldest) {
      if (oldest.destination !== spec.destination || !sameHop(oldest, hop))
        throw fail(
          'INVALID_STATE',
          `route ${spec.name} goes to ${oldest.destination} via ${hopText(oldest.next_hop)}; a route is not changed in place, replace it`,
          'replace',
        );
      return routeState(oldest);
    }
    const reply = await this.client.request<{ route: DoVpcRoute }>(
      'POST',
      `/vpcs/${encodeURIComponent(vpc.id)}/routes`,
      {
        body: { name: doName, destination: spec.destination, next_hop: hop },
        signal,
        budget: 'mutate',
      },
    );
    this.log?.info('digitalocean.routeCreated', { route: reply.route.id, name: doName, vpc: vpc.id });
    return routeState(reply.route);
  }

  async delete(ref: ProviderRouteRef, ctx: CallContext): Promise<ProviderResourceState> {
    this.validate(ref);
    const { signal } = ctx;
    let vpc: DoVpc;
    try {
      vpc = await vpcForNetwork(
        this.client,
        { network: ref.network, subnet: ref.subnet },
        ref.region,
        signal,
      );
    } catch (error) {
      // No subnet, no route: a subnet that is gone took its routes with it.
      if (isComputeError(error, 'INVALID_STATE') && error.details?.reason === 'noSubnet')
        return { id: `${ref.region}/${ref.subnet}/${ref.name}`, state: 'deleted' };
      throw error;
    }
    const doName = `${ref.name}${this.suffix}`;
    const ours = (await this.list(vpc, signal)).filter(
      (route) => route.name === doName && this.isOurs(route),
    );
    for (const route of ours) await this.remove(vpc, route, signal);
    return { id: ours[0]?.id ?? `${ref.region}/${ref.subnet}/${ref.name}`, state: 'deleted' };
  }

  /**
   * Before a VPC is deleted: deletes every route of ours in it. Returns every route the VPC held
   * (ours, now deleted, and anyone else's, untouched): while there are any, the VPC stays.
   */
  async release(vpc: DoVpc, signal: AbortSignal): Promise<DoVpcRoute[]> {
    const routes = await this.list(vpc, signal);
    for (const route of routes) if (this.isOurs(route)) await this.remove(vpc, route, signal);
    return routes;
  }
}
