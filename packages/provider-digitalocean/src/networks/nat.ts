import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderNatGatewaySpec,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoVpc } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { deploymentHash } from '../ids.js';
import { vpcForNetwork } from './vpcs.js';

// VPC NAT gateways (P4). A subnet is a DO VPC (DO-D9), so a NAT gateway serves one VPC: it carries
// the egress of the subnet's Droplets, which then need no public address of their own (isolated
// pools, and DOKS isolated workers in P5). DO gives a gateway no tags and keeps no name unique, so
// the name carries the ownership, as a load balancer's does: vps's name plus this deployment's
// hash; two of ours with one name converge on the oldest, and the others are deleted by id.
//
// Teardown is ordered: a VPC a gateway serves can't be deleted, so `deleteSubnet` first deletes the
// gateways of ours that serve it and reports `pending`; a gateway that is not ours keeps the subnet
// `pending` and is never touched.

/** A NAT gateway (`GET /nat_gateways/{id}`): the members this provider reads. */
export interface DoNatGateway {
  id: string;
  name: string;
  type?: string;
  state: 'NEW' | 'UPDATING' | 'ACTIVE' | 'INVALID' | string;
  region: string;
  size?: number;
  vpcs: { vpc_uuid: string; gateway_ip?: string; default_gateway?: boolean }[];
  egresses?: { public_gateways?: { ipv4: string }[] };
  created_at?: string;
}

const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,49}[a-z0-9])?$/;

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** The DO name of a NAT gateway: vps's name plus this deployment's hash. */
export function natGatewayName(name: string, deployment: string): string {
  return `${name}-${deploymentHash(deployment)}`;
}

/** Oldest first: by creation time, then by id. */
function byAge(a: DoNatGateway, b: DoNatGateway): number {
  const at = Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '');
  return Number.isFinite(at) && at !== 0 ? at : a.id.localeCompare(b.id);
}

function serves(gateway: DoNatGateway, vpcId: string): boolean {
  return gateway.vpcs.some((vpc) => vpc.vpc_uuid === vpcId);
}

/** A gateway's state and plain outputs; `vpcId` picks the gateway address reported. */
function gatewayState(gateway: DoNatGateway, vpcId?: string): ProviderResourceState {
  const egress = (gateway.egresses?.public_gateways ?? []).map((g) => g.ipv4).filter(Boolean);
  const inside = gateway.vpcs.find((vpc) => vpc.vpc_uuid === vpcId) ?? gateway.vpcs[0];
  const outputs = {
    region: gateway.region,
    ...(egress.length ? { address: egress.join(',') } : {}),
    ...(inside?.gateway_ip ? { gateway: inside.gateway_ip } : {}),
  };
  if (gateway.state === 'ACTIVE') return { id: gateway.id, state: 'ready', outputs };
  if (gateway.state === 'INVALID')
    return {
      id: gateway.id,
      state: 'error',
      outputs,
      message: `DigitalOcean reports NAT gateway ${gateway.id} INVALID`,
    };
  return { id: gateway.id, state: 'pending', outputs };
}

export class DoNatGateways {
  protected readonly client: DoClient;
  protected readonly config: DoConfig;
  protected readonly log: Logger | undefined;
  /** `-<hash12>`: the suffix every gateway name of ours ends with. */
  protected readonly suffix: string;

  constructor(client: DoClient, config: DoConfig, deployment: string, log?: Logger) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.suffix = `-${deploymentHash(deployment)}`;
  }

  protected owned(gateway: DoNatGateway): boolean {
    return (
      gateway.name.endsWith(this.suffix) &&
      namePattern.test(gateway.name.slice(0, -this.suffix.length))
    );
  }

  protected validate(name: string, region: string): void {
    if (typeof name !== 'string' || !namePattern.test(name))
      throw fail(
        'INVALID_INPUT',
        `NAT gateway name ${JSON.stringify(name)} is not [a-z0-9-], at most 51 characters`,
        'name',
      );
    if (!this.config.regions.includes(region))
      throw fail('INVALID_INPUT', `region ${region} is not one this account uses`, 'region');
  }

  /** The account's gateways in `region` (with `name`, only that DO name), oldest first. */
  protected async list(
    region: string,
    signal: AbortSignal,
    name?: string,
  ): Promise<DoNatGateway[]> {
    const out: DoNatGateway[] = [];
    for await (const gateway of this.client.pages<DoNatGateway>('/nat_gateways', 'nat_gateways', {
      query: { region, ...(name !== undefined ? { name } : {}) },
      signal,
      budget: 'observe',
    }))
      if (gateway.region === region && (name === undefined || gateway.name === name))
        out.push(gateway);
    return out.sort(byAge);
  }

  protected async remove(gateway: DoNatGateway, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request('DELETE', `/nat_gateways/${encodeURIComponent(gateway.id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log?.info('digitalocean.natGatewayDeleted', { natGateway: gateway.id });
  }

  async ensure(spec: ProviderNatGatewaySpec, ctx: CallContext): Promise<ProviderResourceState> {
    this.validate(spec.name, spec.region);
    const { signal } = ctx;
    const vpc: DoVpc = await vpcForNetwork(
      this.client,
      { network: spec.network, subnet: spec.subnet },
      spec.region,
      signal,
    );
    const doName = `${spec.name}${this.suffix}`;
    const [oldest, ...younger] = (await this.list(spec.region, signal, doName)).filter((g) =>
      this.owned(g),
    );
    for (const twin of younger) await this.remove(twin, signal);
    if (oldest) {
      if (!serves(oldest, vpc.id))
        throw fail(
          'INVALID_STATE',
          `NAT gateway ${oldest.id} serves another VPC than subnet ${spec.subnet}; replace it`,
          'replace',
        );
      return gatewayState(oldest, vpc.id);
    }
    const reply = await this.client.request<{ nat_gateway: DoNatGateway }>(
      'POST',
      '/nat_gateways',
      {
        body: {
          name: doName,
          type: 'PUBLIC',
          region: spec.region,
          size: 1,
          vpcs: [{ vpc_uuid: vpc.id, default_gateway: true }],
        },
        signal,
        budget: 'mutate',
      },
    );
    this.log?.info('digitalocean.natGatewayCreated', {
      natGateway: reply.nat_gateway.id,
      name: doName,
    });
    return gatewayState(reply.nat_gateway, vpc.id);
  }

  async delete(region: string, name: string, ctx: CallContext): Promise<ProviderResourceState> {
    this.validate(name, region);
    const ours = (await this.list(region, ctx.signal, `${name}${this.suffix}`)).filter((g) =>
      this.owned(g),
    );
    for (const gateway of ours) await this.remove(gateway, ctx.signal);
    return { id: ours[0]?.id ?? `${region}/${name}`, state: 'deleted' };
  }

  /**
   * Before a VPC is deleted: deletes every gateway of ours that serves it. Returns the gateways that
   * served it (ours, now deleted, and anyone else's, untouched): while there are any, the VPC stays.
   */
  async release(vpc: DoVpc, signal: AbortSignal): Promise<DoNatGateway[]> {
    const serving = (await this.list(vpc.region, signal)).filter((g) => serves(g, vpc.id));
    for (const gateway of serving) if (this.owned(gateway)) await this.remove(gateway, signal);
    return serving;
  }

  /** Whether a gateway is one of ours (for messages). */
  isOurs(gateway: DoNatGateway): boolean {
    return this.owned(gateway);
  }
}
