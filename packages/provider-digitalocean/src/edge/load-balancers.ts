import { isIP } from 'node:net';
import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderLoadBalancerRule,
  type ProviderLoadBalancers,
  type ProviderLoadBalancerSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoDroplet } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { deploymentHash, deploymentTag, labels, parseMachineId } from '../ids.js';
import { vpcForNetwork } from '../networks/vpcs.js';
import { carries } from '../storage/volumes.js';

// Load balancers (P4). DO gives a load balancer no tags (unverified) and keeps no name unique, so
// the name carries the ownership: vps's name plus this deployment's hash (`<name>-<hash12>`). An
// ensure finds its load balancer by the id it returned before, else by that exact name; two of
// ours with one name (two racing creates) converge on the oldest, and the others are deleted one by
// one (DO-D4, DO-D16). Every call that writes refuses a load balancer whose name is not ours.
//
// Targets are explicit Droplet ids, never a tag: a tag target follows every Droplet that carries
// the tag on the account, which nothing here bounds to one tenant. Each target must be an instance
// of this deployment (its deployment tag and an instance tag) in the load balancer's region, which
// is checked before any write; so a load balancer reaches only better-compute's own machines.
//
// DO provisions a load balancer in the background (`new`, then `active` with an address). A
// change is one replace (PUT) of the whole configuration: it carries what the spec sets and keeps
// every field the spec leaves alone (size, timeouts, a health check vps does not set), and is not
// sent while the load balancer is still `new`. Type, region, VPC and network don't change in place.

/** A forwarding rule as DO writes it. */
export interface DoForwardingRule {
  entry_protocol: string;
  entry_port: number;
  target_protocol: string;
  target_port: number;
  certificate_id?: string;
  tls_passthrough?: boolean;
}

/** A load balancer (`GET /load_balancers/{id}`): the members this provider reads or keeps. */
export interface DoLoadBalancer {
  id: string;
  name: string;
  ip?: string;
  ipv6?: string;
  status: 'new' | 'active' | 'errored' | string;
  created_at: string;
  type?: 'REGIONAL' | 'REGIONAL_NETWORK' | 'GLOBAL' | string;
  region?: { slug: string } | null;
  vpc_uuid?: string;
  network?: 'EXTERNAL' | 'INTERNAL' | string;
  network_stack?: string;
  size_unit?: number;
  forwarding_rules?: DoForwardingRule[];
  health_check?: Record<string, unknown>;
  sticky_sessions?: { type: string; cookie_name?: string; cookie_ttl_seconds?: number };
  redirect_http_to_https?: boolean;
  enable_proxy_protocol?: boolean;
  enable_backend_keepalive?: boolean;
  http_idle_timeout_seconds?: number;
  disable_lets_encrypt_dns_records?: boolean;
  firewall?: { allow?: string[]; deny?: string[] };
  droplet_ids?: number[];
  tag?: string;
  domains?: { name: string; is_managed?: boolean; certificate_id?: string }[];
  glb_settings?: Record<string, unknown>;
  target_load_balancer_ids?: string[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,49}[a-z0-9])?$/;
const cookiePattern = /^[A-Za-z0-9_-]{1,64}$/;
const protocols = new Set(['http', 'https', 'http2', 'tcp', 'udp']);
const tlsEntries = new Set(['https', 'http2']);
const checkProtocols = new Set(['http', 'https', 'tcp']);
const instanceTagPrefix = `${labels.instance}:`;
/** DO answers a load balancer with this many Droplets; more is refused before any request. */
export const maxLoadBalancerTargets = 1000;
/** Up to this many targets are read one by one; more are found by one tag list first. */
const directReads = 3;

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'UNSUPPORTED' | 'NOT_FOUND',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** The DO name of a load balancer: vps's name plus this deployment's hash. */
export function loadBalancerName(name: string, deployment: string): string {
  return `${name}-${deploymentHash(deployment)}`;
}

/** A load balancer id as DO writes it (a uuid); anything else is `INVALID_INPUT`. */
export function parseLoadBalancerId(id: string): string {
  if (!uuidPattern.test(id))
    throw fail(
      'INVALID_INPUT',
      `${JSON.stringify(id)} is not a DigitalOcean load balancer id`,
      'loadBalancerId',
    );
  return id.toLowerCase();
}

/** Oldest first: by creation time (whole seconds at DO), then by id. */
function byAge(a: DoLoadBalancer, b: DoLoadBalancer): number {
  const at = Date.parse(a.created_at) - Date.parse(b.created_at);
  return Number.isFinite(at) && at !== 0 ? at : a.id.localeCompare(b.id);
}

function validPort(port: unknown): boolean {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

function positive(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

/** A source range as a DO firewall entry: `ip:` for an address, `cidr:` for a prefix. */
function rangeEntry(range: string): string {
  const slash = range.indexOf('/');
  const address = slash < 0 ? range : range.slice(0, slash);
  const family = isIP(address);
  const bits = slash < 0 ? undefined : Number(range.slice(slash + 1));
  if (
    family === 0 ||
    (bits !== undefined &&
      (!/^\d{1,3}$/.test(range.slice(slash + 1)) || bits > (family === 4 ? 32 : 128)))
  )
    throw fail(
      'INVALID_INPUT',
      `${JSON.stringify(range)} is not an address or CIDR`,
      'sourceRanges',
    );
  return slash < 0 ? `ip:${range}` : `cidr:${range}`;
}

function ruleBody(rule: ProviderLoadBalancerRule): DoForwardingRule {
  return {
    entry_protocol: rule.entryProtocol,
    entry_port: rule.entryPort,
    target_protocol: rule.targetProtocol,
    target_port: rule.targetPort,
    ...(rule.certificate !== undefined ? { certificate_id: rule.certificate } : {}),
    ...(rule.tlsPassthrough ? { tls_passthrough: true } : {}),
  };
}

/** A rule as compared: DO answers `""` and `false` for what a body leaves out. */
function ruleKey(rule: DoForwardingRule): string {
  return JSON.stringify([
    rule.entry_protocol,
    rule.entry_port,
    rule.target_protocol,
    rule.target_port,
    rule.certificate_id || '',
    rule.tls_passthrough === true,
  ]);
}

const sorted = <T>(values: readonly T[]): T[] =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The part of a load balancer the spec sets. */
interface Desired {
  forwarding_rules: DoForwardingRule[];
  health_check?: Record<string, unknown>;
  sticky_sessions: { type: string; cookie_name?: string; cookie_ttl_seconds?: number };
  redirect_http_to_https: boolean;
  firewall: { allow: string[]; deny: string[] };
  droplet_ids: number[];
}

function desiredOf(spec: ProviderLoadBalancerSpec, droplets: readonly number[]): Desired {
  const check = spec.healthCheck;
  return {
    forwarding_rules: spec.forwarding.map(ruleBody),
    ...(check
      ? {
          health_check: {
            protocol: check.protocol,
            port: check.port,
            ...(check.path !== undefined ? { path: check.path } : {}),
            ...(check.intervalSeconds !== undefined
              ? { check_interval_seconds: check.intervalSeconds }
              : {}),
            ...(check.timeoutSeconds !== undefined
              ? { response_timeout_seconds: check.timeoutSeconds }
              : {}),
            ...(check.healthyThreshold !== undefined
              ? { healthy_threshold: check.healthyThreshold }
              : {}),
            ...(check.unhealthyThreshold !== undefined
              ? { unhealthy_threshold: check.unhealthyThreshold }
              : {}),
          },
        }
      : {}),
    sticky_sessions: spec.stickySessions
      ? {
          type: 'cookies',
          cookie_name: spec.stickySessions.cookieName,
          cookie_ttl_seconds: spec.stickySessions.ttlSeconds,
        }
      : { type: 'none' },
    redirect_http_to_https: spec.redirectHttpToHttps === true,
    firewall: {
      allow: (spec.sourceRanges?.allow ?? []).map(rangeEntry),
      deny: (spec.sourceRanges?.deny ?? []).map(rangeEntry),
    },
    droplet_ids: sorted(droplets),
  };
}

/** Whether DO's load balancer differs from what the spec sets (only what it sets). */
function differs(lb: DoLoadBalancer, want: Desired): boolean {
  const rules = (rules: readonly DoForwardingRule[]) => sorted(rules.map(ruleKey)).join('|');
  if (rules(lb.forwarding_rules ?? []) !== rules(want.forwarding_rules)) return true;
  if (want.health_check)
    for (const [key, value] of Object.entries(want.health_check))
      if (lb.health_check?.[key] !== value) return true;
  const sticky = lb.sticky_sessions ?? { type: 'none' };
  if (sticky.type !== want.sticky_sessions.type) return true;
  if (
    want.sticky_sessions.type === 'cookies' &&
    (sticky.cookie_name !== want.sticky_sessions.cookie_name ||
      sticky.cookie_ttl_seconds !== want.sticky_sessions.cookie_ttl_seconds)
  )
    return true;
  if ((lb.redirect_http_to_https === true) !== want.redirect_http_to_https) return true;
  const list = (values: readonly string[] | undefined) => sorted(values ?? []).join(',');
  if (list(lb.firewall?.allow) !== list(want.firewall.allow)) return true;
  if (list(lb.firewall?.deny) !== list(want.firewall.deny)) return true;
  if (lb.tag) return true;
  return sorted(lb.droplet_ids ?? []).join(',') !== want.droplet_ids.join(',');
}

/** A load balancer's outputs (plain values only). */
export function loadBalancerOutputs(lb: DoLoadBalancer): Record<string, string> {
  const global = lb.type === 'GLOBAL';
  return {
    scope: global ? 'global' : 'regional',
    ...(!global && lb.region?.slug ? { region: lb.region.slug } : {}),
    ...(lb.ip ? { address: lb.ip } : {}),
    ...(lb.ipv6 ? { addressV6: lb.ipv6 } : {}),
  };
}

const state = (
  id: string,
  value: ProviderResourceState['state'],
  outputs?: Record<string, string>,
  message?: string,
): ProviderResourceState => ({
  id,
  state: value,
  ...(outputs ? { outputs } : {}),
  ...(message !== undefined ? { message } : {}),
});

/** A load balancer's state by its status: `new` is pending, `errored` an error. */
function statusState(
  lb: DoLoadBalancer,
  settled: 'ready' | 'updating' = 'ready',
): ProviderResourceState {
  if (lb.status === 'errored')
    return state(
      lb.id,
      'error',
      loadBalancerOutputs(lb),
      `DigitalOcean reports load balancer ${lb.id} errored`,
    );
  if (lb.status === 'active') return state(lb.id, settled, loadBalancerOutputs(lb));
  return state(lb.id, 'pending', loadBalancerOutputs(lb));
}

export class DoLoadBalancers implements ProviderLoadBalancers {
  protected readonly client: DoClient;
  protected readonly config: DoConfig;
  protected readonly log: Logger;
  protected readonly deploymentTag: string;
  /** `-<hash12>`: the suffix every load balancer name of ours ends with. */
  protected readonly suffix: string;

  constructor(client: DoClient, config: DoConfig, deployment: string, log: Logger) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.deploymentTag = deploymentTag(deployment);
    this.suffix = `-${deploymentHash(deployment)}`;
  }

  /** Whether better-compute may act on the load balancer: its name is one of this deployment's. */
  protected owned(lb: DoLoadBalancer): boolean {
    if (!lb.name.endsWith(this.suffix)) return false;
    return namePattern.test(lb.name.slice(0, -this.suffix.length));
  }

  protected refuseForeign(lb: DoLoadBalancer, name?: string): void {
    if (!this.owned(lb) || (name !== undefined && lb.name !== name))
      throw fail(
        'INVALID_STATE',
        `load balancer ${lb.id} is not ${name !== undefined && this.owned(lb) ? 'this one' : 'managed by this better-compute deployment'}; it is never changed by it`,
        'notManaged',
      );
  }

  /** The load balancer, or undefined when it does not exist. */
  protected async loadBalancer(
    id: string,
    signal: AbortSignal,
  ): Promise<DoLoadBalancer | undefined> {
    try {
      const reply = await this.client.request<{ load_balancer: DoLoadBalancer }>(
        'GET',
        `/load_balancers/${encodeURIComponent(id)}`,
        { signal, budget: 'observe' },
      );
      return reply.load_balancer;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  /** The load balancers with this exact (DO) name, oldest first. */
  protected async named(doName: string, signal: AbortSignal): Promise<DoLoadBalancer[]> {
    const out: DoLoadBalancer[] = [];
    for await (const lb of this.client.pages<DoLoadBalancer>('/load_balancers', 'load_balancers', {
      signal,
      budget: 'observe',
    }))
      if (lb.name === doName) out.push(lb);
    return out.sort(byAge);
  }

  /** The oldest of ours with the name; every younger one is deleted (a racing create's twin). */
  protected async survivor(
    doName: string,
    signal: AbortSignal,
  ): Promise<DoLoadBalancer | undefined> {
    const [oldest, ...younger] = (await this.named(doName, signal)).filter((lb) => this.owned(lb));
    for (const twin of younger) {
      try {
        await this.client.request('DELETE', `/load_balancers/${encodeURIComponent(twin.id)}`, {
          signal,
          budget: 'mutate',
        });
        this.log.info('digitalocean.loadBalancerDuplicateDeleted', {
          loadBalancer: twin.id,
          kept: oldest?.id,
        });
      } catch (error) {
        if (!isComputeError(error, 'NOT_FOUND')) throw error;
      }
    }
    return oldest;
  }

  // ------------------------------------------------------------------------------- validation

  /** Refuses what DO would refuse, before any request. */
  protected validate(spec: ProviderLoadBalancerSpec): void {
    if (typeof spec.name !== 'string' || !namePattern.test(spec.name))
      throw fail(
        'INVALID_INPUT',
        `load balancer name ${JSON.stringify(spec.name)} is not [a-z0-9-], at most 51 characters`,
        'name',
      );
    if (spec.id !== undefined) parseLoadBalancerId(spec.id);
    if (spec.scope === 'global')
      throw fail(
        'UNSUPPORTED',
        'global load balancers are not supported on DigitalOcean yet',
        'globalLoadBalancer',
      );
    if (spec.scope !== 'regional')
      throw fail('INVALID_INPUT', `scope ${String(spec.scope)} is not regional or global`, 'scope');
    if (spec.region === undefined || !this.config.regions.includes(spec.region))
      throw fail(
        'INVALID_INPUT',
        `a regional load balancer names a region this account uses (got ${String(spec.region)})`,
        'region',
      );
    if (spec.domains !== undefined)
      throw fail('INVALID_INPUT', 'only a global load balancer serves domains', 'domains');
    if (spec.targets.loadBalancers !== undefined)
      throw fail(
        'INVALID_INPUT',
        'a regional load balancer targets machines, not load balancers',
        'targets',
      );
    if (!Array.isArray(spec.forwarding) || spec.forwarding.length === 0)
      throw fail('INVALID_INPUT', 'a load balancer has at least one forwarding rule', 'forwarding');
    for (const rule of spec.forwarding) this.validateRule(rule);
    const check = spec.healthCheck;
    if (check) {
      if (
        !checkProtocols.has(check.protocol) ||
        !validPort(check.port) ||
        (check.path !== undefined && (check.protocol === 'tcp' || !check.path.startsWith('/'))) ||
        ![
          check.intervalSeconds,
          check.timeoutSeconds,
          check.healthyThreshold,
          check.unhealthyThreshold,
        ].every(positive)
      )
        throw fail(
          'INVALID_INPUT',
          'the health check is not one DigitalOcean takes',
          'healthCheck',
        );
    }
    const sticky = spec.stickySessions;
    if (
      sticky &&
      (!cookiePattern.test(sticky.cookieName) ||
        !positive(sticky.ttlSeconds) ||
        sticky.ttlSeconds === undefined)
    )
      throw fail(
        'INVALID_INPUT',
        'sticky sessions need a cookie name and a positive TTL',
        'stickySessions',
      );
    for (const range of [...(spec.sourceRanges?.allow ?? []), ...(spec.sourceRanges?.deny ?? [])])
      rangeEntry(range);
    const machines = spec.targets.machines ?? [];
    if (machines.length > maxLoadBalancerTargets)
      throw fail(
        'INVALID_INPUT',
        `a load balancer targets at most ${maxLoadBalancerTargets} machines`,
        'targets',
      );
    for (const machine of machines) parseMachineId(machine);
  }

  protected validateRule(rule: ProviderLoadBalancerRule): void {
    if (!protocols.has(rule.entryProtocol) || !protocols.has(rule.targetProtocol))
      throw fail(
        'INVALID_INPUT',
        `forwarding protocol ${rule.entryProtocol}->${rule.targetProtocol} is not one DigitalOcean takes`,
        'protocol',
      );
    if (!validPort(rule.entryPort) || !validPort(rule.targetPort))
      throw fail('INVALID_INPUT', 'a forwarding port is from 1 to 65535', 'port');
    if (rule.tlsPassthrough) {
      if (
        rule.entryProtocol !== 'https' ||
        rule.targetProtocol !== 'https' ||
        rule.certificate !== undefined
      )
        throw fail(
          'INVALID_INPUT',
          'TLS passthrough is https to https, without a certificate',
          'certificate',
        );
      return;
    }
    if (tlsEntries.has(rule.entryProtocol) && rule.certificate === undefined)
      throw fail(
        'INVALID_INPUT',
        `an ${rule.entryProtocol} entry needs a certificate (or TLS passthrough)`,
        'certificate',
      );
    if (
      rule.certificate !== undefined &&
      (!tlsEntries.has(rule.entryProtocol) || !uuidPattern.test(rule.certificate))
    )
      throw fail(
        'INVALID_INPUT',
        'only an https or http2 entry takes a certificate, by its id',
        'certificate',
      );
  }

  // ---------------------------------------------------------------------------------- targets

  /** Whether a Droplet belongs to an instance of this deployment. */
  protected instanceOf(droplet: DoDroplet): boolean {
    const tags = droplet.tags ?? [];
    return (
      carries(tags, this.deploymentTag) &&
      tags.some((t) => t.toLowerCase().startsWith(instanceTagPrefix))
    );
  }

  /**
   * The target Droplets' ids, each checked: it exists, is an instance of this deployment, and is in
   * `region`. A few are read one by one; more are found by one list of this deployment's tag, and
   * any it leaves out (GPU Droplets, research S2) are read one by one.
   */
  protected async targetDroplets(
    machines: readonly string[],
    region: string,
    signal: AbortSignal,
  ): Promise<number[]> {
    const wanted = [...new Set(machines.map(parseMachineId))];
    const found = new Map<number, DoDroplet>();
    if (wanted.length > directReads) {
      const set = new Set(wanted);
      for await (const droplet of this.client.pages<DoDroplet>('/droplets', 'droplets', {
        query: { tag_name: this.deploymentTag },
        signal,
        budget: 'observe',
      }))
        if (set.has(droplet.id)) found.set(droplet.id, droplet);
    }
    for (const id of wanted) {
      if (found.has(id)) continue;
      try {
        const reply = await this.client.request<{ droplet: DoDroplet }>('GET', `/droplets/${id}`, {
          signal,
          budget: 'observe',
        });
        found.set(id, reply.droplet);
      } catch (error) {
        if (isComputeError(error, 'NOT_FOUND'))
          throw fail('NOT_FOUND', `target Droplet ${id} does not exist`, 'machine');
        throw error;
      }
    }
    for (const id of wanted) {
      const droplet = found.get(id)!;
      if (!this.instanceOf(droplet))
        throw fail(
          'INVALID_STATE',
          `Droplet ${id} does not belong to an instance of this better-compute deployment; a load balancer never targets it`,
          'notInstance',
        );
      if (droplet.region.slug !== region)
        throw fail(
          'INVALID_INPUT',
          `Droplet ${id} is in ${droplet.region.slug}; a load balancer in ${region} targets only its region`,
          'region',
        );
    }
    return wanted;
  }

  // ------------------------------------------------------------------------- ensure, get, find

  async ensureLoadBalancer(
    spec: ProviderLoadBalancerSpec,
    ctx: CallContext,
  ): Promise<ProviderResourceState> {
    this.validate(spec);
    const { signal } = ctx;
    const region = spec.region!;
    const doName = `${spec.name}${this.suffix}`;
    // Before any write: the targets, and the VPC a network names.
    const droplets = await this.targetDroplets(spec.targets.machines ?? [], region, signal);
    const vpc = spec.network
      ? (await vpcForNetwork(this.client, spec.network, region, signal)).id
      : undefined;
    const want = desiredOf(spec, droplets);
    const network = spec.internal ? 'INTERNAL' : 'EXTERNAL';

    let current: DoLoadBalancer | undefined;
    if (spec.id !== undefined) {
      current = await this.loadBalancer(parseLoadBalancerId(spec.id), signal);
      if (current) this.refuseForeign(current, doName);
    }
    current ??= await this.survivor(doName, signal);

    if (!current) {
      const body = {
        name: doName,
        type: 'REGIONAL',
        region,
        network,
        ...(vpc !== undefined ? { vpc_uuid: vpc } : {}),
        ...want,
      };
      const reply = await this.client.request<{ load_balancer: DoLoadBalancer }>(
        'POST',
        '/load_balancers',
        {
          body,
          signal,
          budget: 'mutate',
        },
      );
      const made = reply.load_balancer;
      this.log.info('digitalocean.loadBalancerCreated', { loadBalancer: made.id, name: doName });
      return statusState(made);
    }

    // What doesn't change in place.
    const replace = (what: string) =>
      fail(
        'INVALID_STATE',
        `load balancer ${current!.id} differs in ${what}, which DigitalOcean does not change in place; replace it`,
        'replace',
      );
    if (current.type === 'GLOBAL') throw replace('scope');
    if (current.region?.slug !== region) throw replace('region');
    if ((current.network ?? 'EXTERNAL') !== network) throw replace('network (internal)');
    if (vpc !== undefined && current.vpc_uuid !== vpc) throw replace('network');

    if (current.status !== 'active' || !differs(current, want)) return statusState(current);
    const body = {
      name: current.name,
      type: current.type ?? 'REGIONAL',
      region,
      network,
      ...(current.vpc_uuid ? { vpc_uuid: current.vpc_uuid } : {}),
      ...(current.size_unit !== undefined ? { size_unit: current.size_unit } : {}),
      ...(current.network_stack !== undefined ? { network_stack: current.network_stack } : {}),
      ...(current.enable_proxy_protocol !== undefined
        ? { enable_proxy_protocol: current.enable_proxy_protocol }
        : {}),
      ...(current.enable_backend_keepalive !== undefined
        ? { enable_backend_keepalive: current.enable_backend_keepalive }
        : {}),
      ...(current.http_idle_timeout_seconds !== undefined
        ? { http_idle_timeout_seconds: current.http_idle_timeout_seconds }
        : {}),
      ...(current.disable_lets_encrypt_dns_records !== undefined
        ? { disable_lets_encrypt_dns_records: current.disable_lets_encrypt_dns_records }
        : {}),
      // The spec's health check over DO's: fields the spec leaves out keep their value.
      ...(current.health_check || want.health_check
        ? { health_check: { ...(current.health_check ?? {}), ...(want.health_check ?? {}) } }
        : {}),
      forwarding_rules: want.forwarding_rules,
      sticky_sessions: want.sticky_sessions,
      redirect_http_to_https: want.redirect_http_to_https,
      firewall: want.firewall,
      droplet_ids: want.droplet_ids,
    };
    const reply = await this.client.request<{ load_balancer: DoLoadBalancer }>(
      'PUT',
      `/load_balancers/${encodeURIComponent(current.id)}`,
      { body, signal, budget: 'mutate' },
    );
    this.log.info('digitalocean.loadBalancerUpdated', { loadBalancer: current.id });
    return statusState(reply.load_balancer ?? current, 'updating');
  }

  async getLoadBalancer(id: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    if (!uuidPattern.test(id)) return undefined;
    const lb = await this.loadBalancer(id.toLowerCase(), ctx.signal);
    return lb ? statusState(lb) : undefined;
  }

  async findLoadBalancer(
    name: string,
    ctx: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    if (!namePattern.test(name)) return undefined;
    const [oldest] = (await this.named(`${name}${this.suffix}`, ctx.signal)).filter((lb) =>
      this.owned(lb),
    );
    return oldest ? statusState(oldest) : undefined;
  }

  // ----------------------------------------------------------------------------------- delete

  async deleteLoadBalancer(id: string, ctx: CallContext): Promise<ProviderResourceState> {
    const lbId = parseLoadBalancerId(id);
    const { signal } = ctx;
    const lb = await this.loadBalancer(lbId, signal);
    if (!lb) return state(lbId, 'deleted');
    this.refuseForeign(lb);
    try {
      await this.client.request('DELETE', `/load_balancers/${encodeURIComponent(lb.id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log.info('digitalocean.loadBalancerDeleted', { loadBalancer: lb.id });
    return state(lb.id, 'deleted');
  }
}
