import { createHash } from 'node:crypto';
import { ComputeError, type ProviderFirewallSpec } from '@better-compute/core';
import { networkMemberTag } from '../ids.js';

// Tenant firewall rules as DO Cloud Firewalls (DO-D10). A DO firewall has no network and no
// priority, so its name carries both (ruling R6): the rule `bc-r1` of network `bc-n1` at priority
// 900 is the firewall `bc-r1.n<net16>.p900`, where net16 is 16 hex digits of the network's
// SHA-256. A rule is found by the prefix `bc-r1.`, a network's rules by `.n<net16>.`; that keeps
// the priority check and the network teardown stateless. DO applies every firewall that matches a
// Droplet and a deny always wins, so a ruleset in which an allow outranks an overlapping deny
// can't be expressed and is refused (`refusePriorityInversion`, ruling R7). The refusal falls on
// the allow: a deny always applies, so the inversion fails closed.

/** A rule of a DO firewall (`firewall_rule.yml`). `ports` is `"n"`, `"a-b"` or `"0"` (all). */
export interface DoFirewallRule {
  protocol: 'tcp' | 'udp' | 'icmp';
  ports: string;
  action?: 'allow' | 'deny';
  sources?: DoFirewallTargets;
  destinations?: DoFirewallTargets;
}

/** Where a rule's traffic comes from or goes to. */
export interface DoFirewallTargets {
  addresses?: string[];
  droplet_ids?: number[];
  load_balancer_uids?: string[];
  kubernetes_ids?: string[];
  tags?: string[];
}

/** What `POST /firewalls` and `PUT /firewalls/{id}` take. */
export interface DoFirewallBody {
  name: string;
  inbound_rules: DoFirewallRule[];
  outbound_rules: DoFirewallRule[];
  droplet_ids: number[];
  tags: string[];
}

/** A DO firewall (`GET /firewalls`). `status` is `waiting`, `succeeded` or `failed`. */
export interface DoFirewall extends Partial<DoFirewallBody> {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  pending_changes?: { droplet_id: number; removing: boolean; status: string }[];
}

/** Everywhere: what a rule without addresses means. */
export const anywhere: readonly string[] = ['0.0.0.0/0', '::/0'];

const ruleNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const tagPattern = /^[a-z0-9:_-]{1,255}$/;
const firewallNamePattern = /^([a-z0-9][a-z0-9-]*)\.n([0-9a-f]{16})\.p([0-9]{1,5})$/;
const maxPriority = 65_535;

function fail(code: 'INVALID_INPUT' | 'UNSUPPORTED', message: string, reason: string) {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** 16 hex digits of the network's SHA-256: the `n` part of its rules' names. */
export function networkHash(network: string): string {
  return createHash('sha256').update(network).digest('hex').slice(0, 16);
}

/** The network's base firewall: no inbound rules, everything outbound (DO-D10). */
export function baseFirewallName(network: string): string {
  return `bc-base-${networkHash(network)}`;
}

/** The DO firewall name of a rule: `<name>.n<net16>.p<priority>` (ruling R6). */
export function firewallName(name: string, network: string, priority: number): string {
  return `${name}.n${networkHash(network)}.p${priority}`;
}

/** A rule's name and priority from its DO firewall's name; undefined for any other firewall. */
export function parseFirewallName(
  name: string,
): { rule: string; net16: string; priority: number } | undefined {
  const match = firewallNamePattern.exec(name);
  if (!match) return undefined;
  return { rule: match[1]!, net16: match[2]!, priority: Number(match[3]) };
}

/** The body of a network's base firewall: deny all ingress, allow all egress, on its members. */
export function baseFirewallBody(network: string): DoFirewallBody {
  const out = (protocol: DoFirewallRule['protocol']): DoFirewallRule => ({
    protocol,
    ports: '0',
    destinations: { addresses: [...anywhere] },
  });
  return {
    name: baseFirewallName(network),
    inbound_rules: [],
    outbound_rules: [out('tcp'), out('udp'), out('icmp')],
    droplet_ids: [],
    tags: [networkMemberTag(network)],
  };
}

// ------------------------------------------------------------------------------- addresses

interface Range {
  v6: boolean;
  start: bigint;
  end: bigint;
}

function parseV4(text: string): bigint | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function parseV6(text: string): bigint | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string): string[] | undefined => {
    if (half === '') return [];
    const out: string[] = [];
    const parts = half.split(':');
    for (const [i, part] of parts.entries()) {
      // A trailing dotted quad is two groups.
      if (i === parts.length - 1 && part.includes('.')) {
        const v4 = parseV4(part);
        if (v4 === undefined) return undefined;
        out.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) out.push(part);
      else return undefined;
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  let value = 0n;
  for (const group of [...head, ...Array<string>(missing).fill('0'), ...tail])
    value = (value << 16n) | BigInt(`0x${group}`);
  return value;
}

/** An address or CIDR as a range of addresses; undefined when it is neither. */
export function cidrRange(cidr: string): Range | undefined {
  const [address = '', prefixText, extra] = cidr.split('/');
  if (extra !== undefined) return undefined;
  const v6 = address.includes(':');
  const bits = v6 ? 128 : 32;
  const value = v6 ? parseV6(address) : parseV4(address);
  if (value === undefined) return undefined;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (prefixText !== undefined && !/^[0-9]{1,3}$/.test(prefixText)) return undefined;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return undefined;
  const size = 1n << BigInt(bits - prefix);
  const start = value - (value % size);
  return { v6, start, end: start + size - 1n };
}

/** Whether two address lists share an address; one that doesn't parse is taken to overlap. */
function addressesIntersect(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a)
    for (const y of b) {
      const rx = cidrRange(x);
      const ry = cidrRange(y);
      if (!rx || !ry) return true;
      if (rx.v6 === ry.v6 && rx.start <= ry.end && ry.start <= rx.end) return true;
    }
  return false;
}

// ------------------------------------------------------------------------------- compile

/** A port spec as an inclusive range; undefined when it is not `n` or `a-b` within 1–65535. */
function portRange(port: string): [number, number] | undefined {
  const match = /^([0-9]{1,5})(?:-([0-9]{1,5}))?$/.exec(port);
  if (!match) return undefined;
  const lo = Number(match[1]);
  const hi = match[2] === undefined ? lo : Number(match[2]);
  if (lo < 1 || hi > 65_535 || lo > hi) return undefined;
  return [lo, hi];
}

/** One (protocol, ports) per DO rule: `all` is tcp, udp and icmp; ICMP and "every port" are `"0"`. */
function expand(
  spec: ProviderFirewallSpec,
): { protocol: DoFirewallRule['protocol']; ports: string }[] {
  const out: { protocol: DoFirewallRule['protocol']; ports: string }[] = [];
  for (const rule of spec.rules) {
    const protocols: DoFirewallRule['protocol'][] =
      rule.protocol === 'all' ? ['tcp', 'udp', 'icmp'] : [rule.protocol];
    for (const protocol of protocols) {
      if (protocol === 'icmp' || !rule.ports?.length) {
        out.push({ protocol, ports: '0' });
        continue;
      }
      for (const ports of rule.ports) out.push({ protocol, ports });
    }
  }
  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = `${entry.protocol}/${entry.ports}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The DO firewall of a rule (pure). `network` is the rule's network: it names the firewall and,
 * when the rule names no targets, the rule targets the network's member tag. Refuses what DO can't
 * express or would read differently: a bad name, priority, port, address or tag (`INVALID_INPUT`),
 * and addresses on the wrong side of the rule (`UNSUPPORTED`: DO inbound rules have only sources,
 * outbound rules only destinations).
 */
export function compileDoFirewall(spec: ProviderFirewallSpec, network: string): DoFirewallBody {
  if (!ruleNamePattern.test(spec.name))
    throw fail(
      'INVALID_INPUT',
      `firewall rule name ${JSON.stringify(spec.name)} is not [a-z0-9-], at most 63 characters`,
      'firewallName',
    );
  if (!Number.isInteger(spec.priority) || spec.priority < 0 || spec.priority > maxPriority)
    throw fail(
      'INVALID_INPUT',
      `firewall rule ${spec.name}: priority ${spec.priority} is not a whole number from 0 to ${maxPriority}`,
      'priority',
    );
  const ingress = spec.direction === 'ingress';
  if (ingress ? spec.destinations?.length : spec.sources?.length)
    throw fail(
      'UNSUPPORTED',
      `firewall rule ${spec.name}: a DigitalOcean ${ingress ? 'inbound' : 'outbound'} rule can't name ${ingress ? 'destinations' : 'sources'}`,
      'firewallAddresses',
    );
  if (spec.rules.length === 0)
    throw fail('INVALID_INPUT', `firewall rule ${spec.name} names no protocol`, 'rules');
  for (const rule of spec.rules)
    for (const port of rule.protocol === 'icmp' ? [] : (rule.ports ?? []))
      if (!portRange(port))
        throw fail(
          'INVALID_INPUT',
          `firewall rule ${spec.name}: ${JSON.stringify(port)} is not a port or a port range`,
          'ports',
        );
  const addresses = [...((ingress ? spec.sources : spec.destinations) ?? anywhere)];
  for (const address of addresses)
    if (!cidrRange(address))
      throw fail(
        'INVALID_INPUT',
        `firewall rule ${spec.name}: ${JSON.stringify(address)} is not an address or a CIDR`,
        'address',
      );
  const tags = [...(spec.targetTags ?? [networkMemberTag(network)])];
  for (const tag of tags)
    if (!tagPattern.test(tag))
      throw fail(
        'INVALID_INPUT',
        `firewall rule ${spec.name}: ${JSON.stringify(tag)} is not a DigitalOcean tag`,
        'tag',
      );
  const rules = expand(spec).map(
    ({ protocol, ports }): DoFirewallRule => ({
      protocol,
      ports,
      action: spec.action,
      ...(ingress ? { sources: { addresses } } : { destinations: { addresses } }),
    }),
  );
  return {
    name: firewallName(spec.name, network, spec.priority),
    inbound_rules: ingress ? rules : [],
    outbound_rules: ingress ? [] : rules,
    droplet_ids: [],
    tags: [...new Set(tags)],
  };
}

/**
 * The rule a DO firewall of ours holds, read back from it: the name and priority from its name,
 * the rest from its rules. A firewall that targets only the network's member tag targets the
 * whole network, as a rule without targets does. Undefined for a firewall that isn't a rule.
 */
export function specOfDoFirewall(
  firewall: DoFirewall,
  network: string,
): ProviderFirewallSpec | undefined {
  const parsed = parseFirewallName(firewall.name);
  if (!parsed) return undefined;
  const inbound = firewall.inbound_rules ?? [];
  const outbound = firewall.outbound_rules ?? [];
  const ingress = inbound.length > 0;
  const list = ingress ? inbound : outbound;
  if (list.length === 0) return undefined;
  const addresses = new Set<string>();
  for (const rule of list)
    for (const address of (ingress ? rule.sources : rule.destinations)?.addresses ?? [])
      addresses.add(address);
  const tags = firewall.tags ?? [];
  const member = networkMemberTag(network);
  return {
    network,
    name: parsed.rule,
    direction: ingress ? 'ingress' : 'egress',
    action: list.some((rule) => rule.action === 'deny') ? 'deny' : 'allow',
    priority: parsed.priority,
    rules: list.map((rule) => ({
      protocol: rule.protocol,
      ...(rule.protocol !== 'icmp' && rule.ports !== '0' && rule.ports !== 'all'
        ? { ports: [rule.ports] }
        : {}),
    })),
    ...(ingress ? { sources: [...addresses] } : { destinations: [...addresses] }),
    ...(tags.length > 0 && !(tags.length === 1 && tags[0] === member) ? { targetTags: tags } : {}),
  };
}

// ------------------------------------------------------------------------------- priority

/** The traffic a rule matches, per protocol, as port ranges (ICMP has no ports). */
function traffic(spec: ProviderFirewallSpec): { protocol: string; lo: number; hi: number }[] {
  return expand(spec).map(({ protocol, ports }) => {
    const range = ports === '0' ? undefined : portRange(ports);
    return { protocol, lo: range?.[0] ?? 0, hi: range?.[1] ?? 65_535 };
  });
}

/** Whether two rules can match the same packet (ruling R7). */
function overlap(a: ProviderFirewallSpec, b: ProviderFirewallSpec): boolean {
  if (a.network !== b.network || a.direction !== b.direction) return false;
  const ta = traffic(a);
  const tb = traffic(b);
  if (!ta.some((x) => tb.some((y) => x.protocol === y.protocol && x.lo <= y.hi && y.lo <= x.hi)))
    return false;
  const side = (rule: ProviderFirewallSpec) =>
    (rule.direction === 'ingress' ? rule.sources : rule.destinations) ?? anywhere;
  if (!addressesIntersect(side(a), side(b))) return false;
  // Explicit targets with no tag in common are disjoint; no targets is the whole network.
  if (a.targetTags && b.targetTags && !a.targetTags.some((tag) => b.targetTags!.includes(tag)))
    return false;
  return true;
}

/**
 * Refuses a ruleset that DO would read differently (ruling R7). With priorities, a rule of lower
 * number wins; on DO a deny always wins. So an `allow` that outranks an overlapping `deny` (a
 * lower priority number) would lose the traffic its priority grants: `UNSUPPORTED`, `reason
 * 'firewallPriority'`. Disabled rules take no part. Pure.
 */
export function refusePriorityInversion(rules: readonly ProviderFirewallSpec[]): void {
  const live = rules.filter((rule) => !rule.disabled);
  for (const allow of live) {
    if (allow.action !== 'allow') continue;
    for (const deny of live) {
      if (deny.action !== 'deny' || allow.priority >= deny.priority) continue;
      if (!overlap(allow, deny)) continue;
      throw fail(
        'UNSUPPORTED',
        `firewall rule ${allow.name} (allow, priority ${allow.priority}) outranks the overlapping rule ${deny.name} (deny, priority ${deny.priority}); on DigitalOcean a deny always wins, so this ruleset can't be expressed`,
        'firewallPriority',
      );
    }
  }
}

// ------------------------------------------------------------------------------- comparing

function normalTargets(targets: DoFirewallTargets | undefined): unknown {
  return {
    addresses: [...(targets?.addresses ?? [])].sort(),
    droplet_ids: [...(targets?.droplet_ids ?? [])].sort(),
    load_balancer_uids: [...(targets?.load_balancer_uids ?? [])].sort(),
    kubernetes_ids: [...(targets?.kubernetes_ids ?? [])].sort(),
    tags: [...(targets?.tags ?? [])].sort(),
  };
}

function normalRules(rules: readonly DoFirewallRule[] | undefined, inbound: boolean): string[] {
  return (rules ?? [])
    .map((rule) =>
      JSON.stringify({
        protocol: rule.protocol,
        // DO may write "every port" as "0" or "all"; ICMP has no ports.
        ports: rule.protocol === 'icmp' || rule.ports === 'all' ? '0' : rule.ports,
        action: rule.action ?? 'allow',
        targets: normalTargets(inbound ? rule.sources : rule.destinations),
      }),
    )
    .sort();
}

/** Whether a DO firewall already is what `body` describes. */
export function sameFirewall(found: DoFirewall, body: DoFirewallBody): boolean {
  const normal = (fw: Partial<DoFirewallBody> & { name?: string }) =>
    JSON.stringify({
      name: fw.name,
      inbound: normalRules(fw.inbound_rules, true),
      outbound: normalRules(fw.outbound_rules, false),
      droplet_ids: [...(fw.droplet_ids ?? [])].sort(),
      tags: [...(fw.tags ?? [])].map((t) => t.toLowerCase()).sort(),
    });
  return normal(found) === normal(body);
}
