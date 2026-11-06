import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderPeeringSide,
  type ProviderPeeringSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoVpc } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { deploymentHash } from '../ids.js';
import { vpcForNetwork } from './vpcs.js';

// VPC peerings (P4). A subnet is a DO VPC (DO-D9), so DO peers subnets: both sides of a peering
// name a subnet and its region, and both must be subnets of this deployment's networks (a VPC that
// is not one is never peered). Two subnets of one network don't reach each other on DO without a
// peering. The name carries the ownership (vps's name plus this deployment's hash), two of ours with
// one name converge on the oldest, and a peering of ours under the name between other VPCs is
// `INVALID_STATE` (`replace`). A delete is asynchronous at DO (`DELETING`): `deleting`, then
// `deleted` once it is gone. As with NAT gateways, a subnet goes only after its peerings of ours.

/** A VPC peering (`GET /vpc_peerings/{id}`). */
export interface DoVpcPeering {
  id: string;
  name: string;
  vpc_ids: string[];
  status: 'PROVISIONING' | 'ACTIVE' | 'DELETING' | string;
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

/** The DO name of a peering: vps's name plus this deployment's hash. */
export function peeringName(name: string, deployment: string): string {
  return `${name}-${deploymentHash(deployment)}`;
}

function byAge(a: DoVpcPeering, b: DoVpcPeering): number {
  const at = Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '');
  return Number.isFinite(at) && at !== 0 ? at : a.id.localeCompare(b.id);
}

function peeringState(peering: DoVpcPeering): ProviderResourceState {
  const outputs = { networks: [...peering.vpc_ids].sort().join(',') };
  if (peering.status === 'ACTIVE') return { id: peering.id, state: 'ready', outputs };
  if (peering.status === 'DELETING') return { id: peering.id, state: 'deleting', outputs };
  return { id: peering.id, state: 'pending', outputs };
}

export class DoPeerings {
  protected readonly client: DoClient;
  protected readonly config: DoConfig;
  protected readonly log: Logger | undefined;
  /** `-<hash12>`: the suffix every peering name of ours ends with. */
  protected readonly suffix: string;

  constructor(client: DoClient, config: DoConfig, deployment: string, log?: Logger) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.suffix = `-${deploymentHash(deployment)}`;
  }

  isOurs(peering: DoVpcPeering): boolean {
    return (
      peering.name.endsWith(this.suffix) &&
      namePattern.test(peering.name.slice(0, -this.suffix.length))
    );
  }

  protected validateName(name: string): void {
    if (typeof name !== 'string' || !namePattern.test(name))
      throw fail(
        'INVALID_INPUT',
        `peering name ${JSON.stringify(name)} is not [a-z0-9-], at most 51 characters`,
        'name',
      );
  }

  /** A side's VPC: it names a subnet of this deployment's network, in a region this account uses. */
  protected async side(side: ProviderPeeringSide, signal: AbortSignal): Promise<DoVpc> {
    if (side.subnet === undefined || side.region === undefined)
      throw fail(
        'INVALID_INPUT',
        'DigitalOcean peers subnets: each side of a peering names its subnet and region',
        'subnet',
      );
    if (!this.config.regions.includes(side.region))
      throw fail('INVALID_INPUT', `region ${side.region} is not one this account uses`, 'region');
    return vpcForNetwork(
      this.client,
      { network: side.network, subnet: side.subnet },
      side.region,
      signal,
    );
  }

  protected async list(signal: AbortSignal): Promise<DoVpcPeering[]> {
    const out: DoVpcPeering[] = [];
    for await (const peering of this.client.pages<DoVpcPeering>('/vpc_peerings', 'vpc_peerings', {
      signal,
      budget: 'observe',
    }))
      out.push(peering);
    return out.sort(byAge);
  }

  protected async remove(peering: DoVpcPeering, signal: AbortSignal): Promise<void> {
    if (peering.status === 'DELETING') return;
    try {
      await this.client.request('DELETE', `/vpc_peerings/${encodeURIComponent(peering.id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log?.info('digitalocean.peeringDeleted', { peering: peering.id });
  }

  async ensure(spec: ProviderPeeringSpec, ctx: CallContext): Promise<ProviderResourceState> {
    this.validateName(spec.name);
    const { signal } = ctx;
    const left = await this.side(spec, signal);
    const right = await this.side(spec.peer, signal);
    if (left.id === right.id)
      throw fail('INVALID_INPUT', 'a peering joins two different subnets', 'peer');
    const doName = `${spec.name}${this.suffix}`;
    const [oldest, ...younger] = (await this.list(signal)).filter(
      (p) => p.name === doName && this.isOurs(p),
    );
    for (const twin of younger) await this.remove(twin, signal);
    if (oldest) {
      const joins = new Set(oldest.vpc_ids);
      if (joins.size !== 2 || !joins.has(left.id) || !joins.has(right.id))
        throw fail(
          'INVALID_STATE',
          `peering ${oldest.id} joins other subnets than ${spec.subnet} and ${spec.peer.subnet}; replace it`,
          'replace',
        );
      return peeringState(oldest);
    }
    const reply = await this.client.request<{ vpc_peering: DoVpcPeering }>(
      'POST',
      '/vpc_peerings',
      {
        body: { name: doName, vpc_ids: [left.id, right.id] },
        signal,
        budget: 'mutate',
      },
    );
    this.log?.info('digitalocean.peeringCreated', { peering: reply.vpc_peering.id, name: doName });
    return peeringState(reply.vpc_peering);
  }

  async delete(name: string, ctx: CallContext): Promise<ProviderResourceState> {
    this.validateName(name);
    const doName = `${name}${this.suffix}`;
    const ours = (await this.list(ctx.signal)).filter((p) => p.name === doName && this.isOurs(p));
    if (ours.length === 0) return { id: name, state: 'deleted' };
    for (const peering of ours) await this.remove(peering, ctx.signal);
    return { id: ours[0]!.id, state: 'deleting' };
  }

  /** Before a VPC is deleted: deletes the peerings of ours that join it; returns every one that does. */
  async release(vpc: DoVpc, signal: AbortSignal): Promise<DoVpcPeering[]> {
    const joining = (await this.list(signal)).filter((p) => p.vpc_ids.includes(vpc.id));
    for (const peering of joining) if (this.isOurs(peering)) await this.remove(peering, signal);
    return joining;
  }
}
