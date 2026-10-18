import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ProviderFirewallSpec,
  type ProviderNetworks,
  type ProviderNetworkSpec,
  type ProviderNetworkState,
  type ProviderSubnetSpec,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { assignTag, ensureTag, hasTag, unassignTag } from '../compute/tags.js';
import type { DoDroplet } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import {
  deploymentTag,
  isManagedTag,
  labels,
  networkMemberTag,
  parseMachineId,
  tagFor,
} from '../ids.js';
import {
  baseFirewallBody,
  baseFirewallName,
  compileDoFirewall,
  networkHash,
  refusePriorityInversion,
  sameFirewall,
  specOfDoFirewall,
  type DoFirewall,
  type DoFirewallBody,
} from './firewalls.js';
import { accountVpcs, checkSubnet, networkDescription, networkOfVpc, vpcLookup } from './vpcs.js';

export * from './firewalls.js';
export * from './vpcs.js';

// Tenant networking on DigitalOcean (DO-D9, DO-D10). A network is no DO object of its own: it is
// its base firewall, which targets the network's member tag (`bc-net-<net16>`), denies all ingress
// (it has no inbound rules) and allows all egress. Each subnet is a VPC; each firewall rule is a
// DO Cloud Firewall whose name carries the rule, its network and its priority (ruling R6). A
// Droplet joins the network by its member tag, which create and setTags put on it.
//
// Every call is short. A VPC exists as soon as its create returns. A firewall is applied by DO in
// the background: its `status` is `waiting` until it is, so ensureNetwork and ensureFirewall
// report `pending` and the reconciler asks again. DO firewall names are not unique, so two
// racing creates both land; the next call keeps the oldest and deletes the others.

const state = (id: string, value: ProviderNetworkState['state'], message?: string) =>
  ({ id, state: value, ...(message !== undefined ? { message } : {}) }) as ProviderNetworkState;

const managedPrefix = 'bc-';
const setTagPattern = /^bc-[a-z0-9:_-]{1,252}$/;
const instanceTagPrefix = `${labels.instance}:`;

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'UNSUPPORTED',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** Oldest first: by creation time, then by id. */
function byAge(a: DoFirewall, b: DoFirewall): number {
  const at = Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '');
  return Number.isFinite(at) && at !== 0 ? at : a.id.localeCompare(b.id);
}

/** A firewall's state: DO applies it in the background (research S3). */
function firewallState(id: string, firewall: DoFirewall | undefined): ProviderNetworkState {
  switch (firewall?.status) {
    case 'succeeded':
      return state(id, 'ready');
    case 'failed': {
      const droplets = (firewall.pending_changes ?? [])
        .filter((change) => change.status === 'failed')
        .map((change) => change.droplet_id);
      return state(
        id,
        'error',
        `DigitalOcean failed to apply firewall ${firewall.name}${droplets.length ? ` to Droplets ${droplets.join(', ')}` : ''}`,
      );
    }
    default:
      return state(id, 'pending');
  }
}

export class DoNetworks implements ProviderNetworks {
  readonly #client: DoClient;
  readonly #config: DoConfig;
  readonly #deploymentTag: string;

  constructor(client: DoClient, config: DoConfig, deployment: string) {
    this.#client = client;
    this.#config = config;
    this.#deploymentTag = deploymentTag(deployment);
  }

  // ------------------------------------------------------------------------------ firewalls

  async #firewalls(signal: AbortSignal): Promise<DoFirewall[]> {
    const out: DoFirewall[] = [];
    for await (const firewall of this.#client.pages<DoFirewall>('/firewalls', 'firewalls', {
      signal,
      budget: 'observe',
    }))
      out.push(firewall);
    return out;
  }

  async #deleteFirewall(firewall: DoFirewall, signal: AbortSignal): Promise<void> {
    try {
      await this.#client.request('DELETE', `/firewalls/${encodeURIComponent(firewall.id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }

  /**
   * Makes the firewall `body` describes out of `found`, the DO firewalls that are this one: the
   * oldest is kept (and `PUT` when it differs), the rest are deleted; none means a create. The tags
   * it targets are made first, as a Droplet create would make them.
   */
  async #apply(
    id: string,
    found: readonly DoFirewall[],
    body: DoFirewallBody,
    signal: AbortSignal,
  ): Promise<ProviderNetworkState> {
    const [kept, ...duplicates] = [...found].sort(byAge);
    for (const duplicate of duplicates) await this.#deleteFirewall(duplicate, signal);
    if (kept && sameFirewall(kept, body)) return firewallState(id, kept);
    for (const tag of body.tags) await ensureTag(this.#client, tag, signal);
    const reply = kept
      ? await this.#client.request<{ firewall?: DoFirewall }>(
          'PUT',
          `/firewalls/${encodeURIComponent(kept.id)}`,
          { body, signal, budget: 'mutate' },
        )
      : await this.#client.request<{ firewall?: DoFirewall }>('POST', '/firewalls', {
          body,
          signal,
          budget: 'mutate',
        });
    return firewallState(id, reply.firewall);
  }

  async ensureNetwork(
    spec: ProviderNetworkSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    // The MTU of a DO VPC is not documented (research S3): only the Ethernet default is promised.
    if (spec.mtu !== undefined && spec.mtu !== 1500)
      throw fail(
        'UNSUPPORTED',
        `network ${spec.name}: DigitalOcean VPCs don't offer an MTU of ${spec.mtu}`,
        'mtu',
      );
    const name = baseFirewallName(spec.name);
    const found = (await this.#firewalls(context.signal)).filter((f) => f.name === name);
    return this.#apply(spec.name, found, baseFirewallBody(spec.name), context.signal);
  }

  async ensureFirewall(
    spec: ProviderFirewallSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const { signal } = context;
    if (spec.disabled) {
      await this.deleteFirewall(spec.name, context);
      return state(spec.name, 'ready');
    }
    const body = compileDoFirewall(spec, spec.network);
    const all = await this.#firewalls(signal);
    const prefix = `${spec.name}.`;
    const network = `.n${networkHash(spec.network)}.`;
    // The network's other rules, read back from DO: this rule must not outrank a deny among them.
    for (const firewall of all) {
      if (firewall.name.startsWith(prefix) || !firewall.name.includes(network)) continue;
      const other = specOfDoFirewall(firewall, spec.network);
      if (other) refusePriorityInversion([spec, other]);
    }
    return this.#apply(
      spec.name,
      all.filter((f) => f.name.startsWith(prefix)),
      body,
      signal,
    );
  }

  /** Deletes every DO firewall of the rule (any network, any priority). Gone is `deleted`. */
  async deleteFirewall(name: string, context: CallContext): Promise<ProviderNetworkState> {
    const prefix = `${name}.`;
    for (const firewall of await this.#firewalls(context.signal))
      if (firewall.name.startsWith(prefix)) await this.#deleteFirewall(firewall, context.signal);
    return state(name, 'deleted');
  }

  // ------------------------------------------------------------------------------ subnets

  async ensureSubnet(
    spec: ProviderSubnetSpec,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const { signal } = context;
    checkSubnet(spec);
    if (!this.#config.regions.includes(spec.region))
      throw fail(
        'INVALID_INPUT',
        `subnet ${spec.name} is in ${spec.region}, which this account does not use`,
        'region',
      );
    const id = `${spec.region}/${spec.name}`;
    const named = async () =>
      (await accountVpcs(this.#client, signal, { fresh: true })).find((v) => v.name === spec.name);
    const existing = await named();
    if (existing) return this.#compareSubnet(id, existing, spec);
    try {
      await this.#client.request('POST', '/vpcs', {
        body: {
          name: spec.name,
          region: spec.region,
          ip_range: spec.cidr,
          description: networkDescription(spec.network),
        },
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      // A VPC name is unique in the account: one made since our read (or long ago) is compared.
      if (!isComputeError(error, 'CONFLICT')) throw error;
      const raced = await named();
      if (!raced) throw error;
      return this.#compareSubnet(id, raced, spec);
    }
    // A VPC exists once its create returns.
    return state(id, 'ready');
  }

  #compareSubnet(
    id: string,
    vpc: { region: string; ip_range?: string; description?: string; name: string },
    spec: ProviderSubnetSpec,
  ): ProviderNetworkState {
    if (
      vpc.region !== spec.region ||
      vpc.ip_range !== spec.cidr ||
      networkOfVpc(vpc) !== spec.network
    )
      throw fail(
        'INVALID_STATE',
        `VPC ${vpc.name} exists in ${vpc.region} with range ${vpc.ip_range ?? 'unknown'} for ${networkOfVpc(vpc) ?? 'no network'}, not in ${spec.region} with ${spec.cidr} for ${spec.network}`,
        'subnetDrift',
      );
    return state(id, 'ready');
  }

  /** Deletes the subnet's VPC. One that still has members is `pending`: DO refuses until they go. */
  async deleteSubnet(
    region: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderNetworkState> {
    const { signal } = context;
    const id = `${region}/${name}`;
    const vpc = (await accountVpcs(this.#client, signal, { fresh: true })).find(
      (v) => v.name === name && v.region === region,
    );
    if (!vpc) return state(id, 'deleted');
    if (networkOfVpc(vpc) === undefined)
      throw fail(
        'INVALID_STATE',
        `VPC ${name} is not a subnet of a better-compute network and is never deleted by it`,
        'notManaged',
      );
    try {
      await this.#client.request('DELETE', `/vpcs/${encodeURIComponent(vpc.id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return state(id, 'deleted');
      if (isComputeError(error, 'CONFLICT')) return state(id, 'pending', error.message);
      throw error;
    }
    return state(id, 'deleted');
  }

  /**
   * A network goes once its subnets have: until then it is `deleting` and keeps its base
   * firewall, which still guards the Droplets in them. Then the base firewall goes, with any rule
   * firewall of the network that is left.
   */
  async deleteNetwork(name: string, context: CallContext): Promise<ProviderNetworkState> {
    const { signal } = context;
    const vpcs = await accountVpcs(this.#client, signal, { fresh: true });
    if (vpcs.some((vpc) => networkOfVpc(vpc) === name)) return state(name, 'deleting');
    const base = baseFirewallName(name);
    const rules = `.n${networkHash(name)}.`;
    for (const firewall of await this.#firewalls(signal))
      if (firewall.name === base || firewall.name.includes(rules))
        await this.#deleteFirewall(firewall, signal);
    return state(name, 'deleted');
  }

  // ------------------------------------------------------------------------------ tags

  /**
   * Replaces the Droplet's `bc-` tags with `tags`, plus the member tag of the network its VPC
   * belongs to; every other tag stays, `better-compute-*` included. The Droplet must carry this
   * deployment's tag and an instance tag, which with `instanceId` must name it (ruling R3). Tags
   * are added before old ones go, so a firewall never loses the Droplet in between.
   */
  async setTags(
    machineId: string,
    tags: readonly string[],
    context: CallContext,
    instanceId?: string,
  ): Promise<void> {
    const { signal } = context;
    for (const tag of tags)
      if (!setTagPattern.test(tag))
        throw fail(
          'INVALID_INPUT',
          `${JSON.stringify(tag)} is not a managed network tag (bc- and DigitalOcean tag characters)`,
          'tag',
        );
    const dropletId = parseMachineId(machineId);
    let droplet: DoDroplet;
    try {
      ({ droplet } = await this.#client.request<{ droplet: DoDroplet }>(
        'GET',
        `/droplets/${dropletId}`,
        { signal, budget: 'observe' },
      ));
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
      throw new ComputeError('NOT_FOUND', `Droplet ${machineId} does not exist`, undefined, {
        provider: 'digitalocean',
        id: machineId,
      });
    }
    const instanceTags = (droplet.tags ?? []).filter((t) =>
      t.toLowerCase().startsWith(instanceTagPrefix),
    );
    const owned =
      hasTag(droplet, this.#deploymentTag) &&
      (instanceId === undefined
        ? instanceTags.length > 0
        : hasTag(droplet, tagFor(labels.instance, instanceId)));
    if (!owned)
      throw fail(
        'INVALID_STATE',
        `Droplet ${machineId} does not belong to ${instanceId === undefined ? 'an instance' : `instance ${instanceId}`} of this better-compute deployment; its tags are not touched`,
        'notInstance',
      );

    const wanted = new Set(tags);
    if (droplet.vpc_uuid) {
      const vpc = await vpcLookup(this.#client, signal)(droplet.vpc_uuid);
      const network = vpc && networkOfVpc(vpc);
      if (network !== undefined) wanted.add(networkMemberTag(network));
    }
    for (const tag of wanted)
      if (!hasTag(droplet, tag)) await assignTag(this.#client, tag, droplet.id, signal);
    for (const tag of droplet.tags ?? [])
      if (isManagedTag(tag) && tag.startsWith(managedPrefix) && !wanted.has(tag.toLowerCase()))
        await unassignTag(this.#client, tag, droplet.id, signal);
  }
}
