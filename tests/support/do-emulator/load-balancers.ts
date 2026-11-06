import { isoSeconds } from './actions.js';
import type { DoEmulator, RouteContext, RouteResult } from './index.js';
import { fixture, type DoState, type Json } from './state.js';
import { defaultVpc, uuidFrom } from './vpcs.js';

// Load balancers under `/v2/load_balancers`: create (202), list (paged), read, replace (PUT) and
// delete over `state.loadBalancers`. A new load balancer is `new`, with no address, for
// `emulator.loadBalancerReads` reads (default 1; a list entry counts), then `active` with an
// address from TEST-NET-1 (an internal one gets one from its VPC's range). Names are not unique, as
// far as DO says (unverified), so the emulator accepts duplicates.
//
// What DO validates and the provider must not trip over: a regional load balancer names a region
// and at least one forwarding rule; it targets `droplet_ids` or a `tag`, never both, and every
// Droplet must be in its region (the 422 `must be in the same region`); an `https`/`http2` entry
// names a certificate that exists unless it passes TLS through; `firewall` entries are `ip:` or
// `cidr:`. A global load balancer has no region and targets regional load balancers
// (`target_load_balancer_ids`) or Droplets, with `glb_settings`. A replace (PUT) keeps the type,
// region, VPC and network (changing one is a 422) and resets every other field the body leaves out
// to its default, as a replace does. A regional load balancer a global one targets can't be
// deleted (the 422 `is in use`). Over `loadBalancerLimit` load balancers, a create is the 422
// `load balancer limit`.

const template = fixture('load-balancers').load_balancer as Json;
const protocols = new Set(['http', 'https', 'http2', 'http3', 'tcp', 'udp']);
const tlsEntries = new Set(['https', 'http2', 'http3']);

const readsLeft = new WeakMap<DoState, Map<string, number>>();

function readsOf(state: DoState): Map<string, number> {
  let map = readsLeft.get(state);
  if (!map) {
    map = new Map();
    readsLeft.set(state, map);
  }
  return map;
}

function unprocessable(message: string): RouteResult {
  return {
    status: 422,
    body: { id: 'unprocessable_entity', message, request_id: 'emulated-lb' },
  };
}

function region(state: DoState, slug: string): Json | undefined {
  return state.regions.find((r) => r.slug === slug);
}

/** The mutable part of a body, with DO's defaults for what it leaves out. */
function mutable(body: Json): Json {
  return {
    forwarding_rules: structuredClone(body.forwarding_rules ?? []).map((rule: Json) => ({
      certificate_id: '',
      tls_passthrough: false,
      ...rule,
    })),
    health_check: {
      protocol: 'http',
      port: 80,
      path: '/',
      check_interval_seconds: 10,
      response_timeout_seconds: 5,
      healthy_threshold: 5,
      unhealthy_threshold: 3,
      ...structuredClone(body.health_check ?? {}),
    },
    sticky_sessions: structuredClone(body.sticky_sessions ?? { type: 'none' }),
    redirect_http_to_https: body.redirect_http_to_https ?? false,
    enable_proxy_protocol: body.enable_proxy_protocol ?? false,
    enable_backend_keepalive: body.enable_backend_keepalive ?? false,
    http_idle_timeout_seconds: body.http_idle_timeout_seconds ?? 60,
    firewall: { deny: [], allow: [], ...structuredClone(body.firewall ?? {}) },
    droplet_ids: [...(body.droplet_ids ?? [])],
    tag: body.tag ?? '',
    ...(body.type === 'GLOBAL'
      ? {
          domains: structuredClone(body.domains ?? []),
          glb_settings: structuredClone(body.glb_settings ?? {}),
          target_load_balancer_ids: [...(body.target_load_balancer_ids ?? [])],
        }
      : {}),
  };
}

/** What DO refuses in a body, as a 422; undefined when it is acceptable. */
function refusal(
  state: DoState,
  body: Json,
  type: string,
  regionSlug: string | undefined,
): RouteResult | undefined {
  if (typeof body.name !== 'string' || body.name === '') return unprocessable('Name is required');
  const rules = body.forwarding_rules;
  if (type !== 'GLOBAL' && (!Array.isArray(rules) || rules.length === 0))
    return unprocessable('Forwarding rules are required');
  for (const rule of (rules ?? []) as Json[]) {
    if (!protocols.has(rule.entry_protocol) || !protocols.has(rule.target_protocol))
      return unprocessable('Forwarding rule protocol is invalid');
    if (tlsEntries.has(rule.entry_protocol) && !rule.tls_passthrough) {
      if (!rule.certificate_id)
        return unprocessable('A certificate is required for an https forwarding rule');
      if (!state.certificates.has(rule.certificate_id))
        return unprocessable('The certificate was not found');
    }
  }
  const droplets = (body.droplet_ids ?? []) as unknown[];
  if (droplets.length > 0 && body.tag) return unprocessable('Specify droplet_ids or tag, not both');
  for (const id of droplets) {
    const droplet = state.droplets.get(Number(id));
    if (!droplet) return unprocessable(`Droplet ${String(id)} was not found`);
    if (type !== 'GLOBAL' && droplet.region.slug !== regionSlug)
      return unprocessable('Droplets must be in the same region as the load balancer');
  }
  for (const id of (body.target_load_balancer_ids ?? []) as string[]) {
    const target = state.loadBalancers.get(id);
    if (!target || target.type === 'GLOBAL')
      return unprocessable(`Target load balancer ${id} was not found`);
  }
  for (const entry of [...(body.firewall?.allow ?? []), ...(body.firewall?.deny ?? [])] as string[])
    if (!/^(ip|cidr):\S+$/.test(entry)) return unprocessable(`Firewall rule ${entry} is invalid`);
  return undefined;
}

/** A read of a load balancer: counts toward its provisioning. */
function afterRead(state: DoState, lb: Json): void {
  const reads = readsOf(state);
  const left = reads.get(lb.id);
  if (left === undefined) return;
  if (left > 1) {
    reads.set(lb.id, left - 1);
    return;
  }
  reads.delete(lb.id);
  lb.status = 'active';
  if (lb.type === 'GLOBAL') lb.ip = `192.0.2.${200 + (state.nextId() % 50)}`;
  else if (lb.network === 'INTERNAL') {
    const range = String(state.vpcs.get(lb.vpc_uuid)?.ip_range ?? '10.10.0.0/20');
    lb.ip = range.replace(/\.\d+\/\d+$/, `.${(state.nextId() % 200) + 10}`);
  } else lb.ip = `192.0.2.${(state.nextId() % 199) + 1}`;
}

/** Puts a load balancer in the account, as if made out of band; returns the stored resource. */
export function seedLoadBalancer(state: DoState, seed: Json): Json {
  const id = seed.id ?? uuidFrom(`lb:${state.nextId()}`);
  const type = seed.type ?? 'REGIONAL';
  const regionSlug = seed.region ?? 'nyc3';
  const lb: Json = {
    ...structuredClone(template),
    ...mutable({ ...seed, type }),
    id,
    name: seed.name ?? `lb-${id.slice(0, 8)}`,
    type,
    status: seed.status ?? 'active',
    ip: seed.ip ?? `192.0.2.${(state.nextId() % 199) + 1}`,
    created_at: seed.created_at ?? isoSeconds(state.now()),
    network: seed.network ?? 'EXTERNAL',
    ...(type === 'GLOBAL'
      ? { region: null, vpc_uuid: '' }
      : {
          region: structuredClone(region(state, regionSlug) ?? { slug: regionSlug }),
          vpc_uuid: seed.vpc_uuid ?? defaultVpc(state, regionSlug).id,
        }),
  };
  state.loadBalancers.set(id, lb);
  return lb;
}

function create(emulator: DoEmulator, context: RouteContext): RouteResult {
  const { state } = context;
  const body = context.body ?? {};
  const type = body.type ?? 'REGIONAL';
  if (!['REGIONAL', 'REGIONAL_NETWORK', 'GLOBAL'].includes(type))
    return unprocessable('Type is invalid');
  let regionSlug: string | undefined;
  let vpcUuid = '';
  if (type !== 'GLOBAL') {
    if (typeof body.region !== 'string' || !region(state, body.region))
      return unprocessable('Region is invalid');
    regionSlug = body.region;
    if (body.vpc_uuid) {
      const vpc = state.vpcs.get(body.vpc_uuid);
      if (!vpc) return unprocessable('VPC was not found');
      if (vpc.region !== regionSlug)
        return unprocessable('The VPC must be in the same region as the load balancer');
      vpcUuid = body.vpc_uuid;
    } else vpcUuid = defaultVpc(state, regionSlug).id;
  } else if (body.region) return unprocessable('A global load balancer has no region');
  const refused = refusal(state, body, type, regionSlug);
  if (refused) return refused;
  if (state.loadBalancers.size >= emulator.loadBalancerLimit)
    return emulator.error('422-load-balancer-limit');
  const id = uuidFrom(`lb:${state.nextId()}:${body.name}`);
  const lb: Json = {
    ...structuredClone(template),
    ...mutable({ ...body, type }),
    id,
    name: body.name,
    project_id: template.project_id,
    type,
    status: 'new',
    ip: '',
    ipv6: '',
    size_unit: body.size_unit ?? 1,
    created_at: isoSeconds(state.now()),
    network: body.network ?? 'EXTERNAL',
    network_stack: body.network_stack ?? 'IPV4',
    region: regionSlug ? structuredClone(region(state, regionSlug)) : null,
    vpc_uuid: vpcUuid,
  };
  state.loadBalancers.set(id, lb);
  readsOf(state).set(id, emulator.loadBalancerReads);
  if (emulator.loadBalancerReads === 0) afterRead(state, lb);
  return { status: 202, body: { load_balancer: structuredClone(lb) } };
}

function replace(context: RouteContext): RouteResult {
  const { state } = context;
  const lb = state.loadBalancers.get(context.match[1]!);
  if (!lb) return context.emulator.error('not-found');
  const body = context.body ?? {};
  const type = body.type ?? lb.type;
  if (type !== lb.type) return unprocessable('The load balancer type cannot be changed');
  if (lb.type !== 'GLOBAL' && body.region !== lb.region.slug)
    return unprocessable('The region cannot be changed');
  if (body.vpc_uuid !== undefined && body.vpc_uuid !== lb.vpc_uuid)
    return unprocessable('The VPC cannot be changed');
  if ((body.network ?? 'EXTERNAL') !== lb.network)
    return unprocessable('The network cannot be changed');
  const refused = refusal(state, body, lb.type, lb.region?.slug);
  if (refused) return refused;
  Object.assign(lb, mutable({ ...body, type: lb.type }), { name: body.name });
  return { status: 200, body: { load_balancer: structuredClone(lb) } };
}

export function registerLoadBalancers(emulator: DoEmulator): void {
  emulator.route('POST', /^\/load_balancers$/, (context) => create(emulator, context));
  emulator.route('GET', /^\/load_balancers$/, (context) => {
    const all = [...context.state.loadBalancers.values()];
    for (const lb of all) afterRead(context.state, lb);
    return emulator.paged(context, 'load_balancers', structuredClone(all));
  });
  emulator.route('GET', /^\/load_balancers\/([0-9a-f-]+)$/, (context) => {
    const lb = context.state.loadBalancers.get(context.match[1]!);
    if (!lb) return emulator.error('not-found');
    afterRead(context.state, lb);
    return { status: 200, body: { load_balancer: structuredClone(lb) } };
  });
  emulator.route('PUT', /^\/load_balancers\/([0-9a-f-]+)$/, replace);
  emulator.route('DELETE', /^\/load_balancers\/([0-9a-f-]+)$/, (context) => {
    const { state } = context;
    const id = context.match[1]!;
    if (!state.loadBalancers.has(id)) return emulator.error('not-found');
    const user = [...state.loadBalancers.values()].find((lb) =>
      ((lb.target_load_balancer_ids ?? []) as string[]).includes(id),
    );
    if (user)
      return unprocessable(`The load balancer is in use by global load balancer ${user.id}`);
    state.loadBalancers.delete(id);
    readsOf(state).delete(id);
    return { status: 204 };
  });
}
