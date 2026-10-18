import { isoSeconds } from './actions.js';
import type { DoEmulator, RouteContext } from './index.js';
import { fixture, type DoState, type Json } from './state.js';
import { hasTag } from './tags.js';
import { uuidFrom } from './vpcs.js';

// Cloud Firewalls under `/v2/firewalls`: list (paged), read, create, replace (`PUT`, which takes
// the whole firewall, name included) and delete over `state.firewalls`. Names are not unique, as
// in the spec. DO applies a firewall in the background: a create or a replace answers `waiting`,
// and the firewall answers `waiting` to its next `emulator.firewallReads` reads (list entries
// count) before it turns `succeeded`; `failFirewall` makes one `failed`. Bodies follow
// `firewall.yml` and `firewall_rule.yml` (research S3): protocol tcp/udp/icmp, ports "n", "a-b"
// or "0" (ICMP only "0"), action allow/deny, inbound `sources`, outbound `destinations`. The
// tags a firewall targets must exist as tag objects: whether DO needs that is unverified, so the
// emulator takes the strict reading.

/** The shape of a `firewall` body, from the fixture. */
const template = fixture('firewalls').firewall as Json;

/** Reads left before a waiting firewall turns `succeeded`, per emulator state. */
const pending = new WeakMap<DoState, Map<string, number>>();

function pendingOf(state: DoState): Map<string, number> {
  let map = pending.get(state);
  if (!map) {
    map = new Map();
    pending.set(state, map);
  }
  return map;
}

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9.-]+$/;
const portsPattern = /^(0|[1-9][0-9]{0,4}(-[1-9][0-9]{0,4})?)$/;

function validTargets(targets: unknown): boolean {
  if (typeof targets !== 'object' || targets === null) return false;
  const t = targets as Json;
  for (const key of ['addresses', 'load_balancer_uids', 'kubernetes_ids', 'tags'])
    if (
      t[key] !== undefined &&
      !(Array.isArray(t[key]) && t[key].every((v: unknown) => typeof v === 'string'))
    )
      return false;
  return t.droplet_ids === undefined || Array.isArray(t.droplet_ids);
}

function validRules(rules: unknown, side: 'sources' | 'destinations'): boolean {
  if (rules === undefined) return true;
  if (!Array.isArray(rules)) return false;
  return rules.every(
    (rule: Json) =>
      ['tcp', 'udp', 'icmp'].includes(rule?.protocol) &&
      (rule.protocol === 'icmp'
        ? rule.ports === undefined || rule.ports === '0'
        : typeof rule.ports === 'string' && portsPattern.test(rule.ports)) &&
      (rule.action === undefined || rule.action === 'allow' || rule.action === 'deny') &&
      validTargets(rule[side]),
  );
}

/** The firewall a create or replace stores, or the error fixture that refuses it. */
function accept(
  emulator: DoEmulator,
  context: RouteContext,
  base: Json,
): { firewall: Json } | { error: ReturnType<DoEmulator['error']> } {
  const body = context.body ?? {};
  if (typeof body.name !== 'string' || !namePattern.test(body.name))
    return { error: emulator.error('422-unknown') };
  if (
    !validRules(body.inbound_rules, 'sources') ||
    !validRules(body.outbound_rules, 'destinations')
  )
    return { error: emulator.error('422-unknown') };
  const tags = body.tags ?? [];
  if (
    !Array.isArray(tags) ||
    !tags.every((t) => typeof t === 'string' && context.state.tags.has(t.toLowerCase()))
  )
    return { error: emulator.error('422-unknown') };
  const dropletIds = body.droplet_ids ?? [];
  if (!Array.isArray(dropletIds) || !dropletIds.every((id) => context.state.droplets.has(id)))
    return { error: emulator.error('422-unknown') };
  return {
    firewall: {
      ...base,
      name: body.name,
      status: 'waiting',
      pending_changes: [],
      inbound_rules: structuredClone(body.inbound_rules ?? []),
      outbound_rules: structuredClone(body.outbound_rules ?? []),
      droplet_ids: [...dropletIds],
      tags: [...tags],
    },
  };
}

/** A read: a waiting firewall counts it, and turns `succeeded` once its reads are used up. */
function read(emulator: DoEmulator, state: DoState, firewall: Json): Json {
  const reads = pendingOf(state);
  if (firewall.status === 'waiting') {
    const left = reads.get(firewall.id) ?? emulator.firewallReads;
    if (left <= 0) {
      firewall.status = 'succeeded';
      reads.delete(firewall.id);
    } else reads.set(firewall.id, left - 1);
  }
  return structuredClone(firewall);
}

/**
 * Makes the firewalls whose name matches end `failed`, with a failed pending change for each
 * Droplet they target; returns how many it changed.
 */
export function failFirewall(state: DoState, name: string | RegExp): number {
  let count = 0;
  for (const firewall of state.firewalls.values()) {
    if (typeof name === 'string' ? firewall.name !== name : !name.test(firewall.name)) continue;
    firewall.status = 'failed';
    firewall.pending_changes = [...state.droplets.values()]
      .filter((d) => (firewall.tags as string[]).some((t) => hasTag(d, t)))
      .map((d) => ({ droplet_id: d.id, removing: false, status: 'failed' }));
    pendingOf(state).delete(firewall.id);
    count += 1;
  }
  return count;
}

export function registerFirewalls(emulator: DoEmulator): void {
  emulator.route('GET', /^\/firewalls$/, (context) => {
    const all = [...context.state.firewalls.values()].map((f) => read(emulator, context.state, f));
    return emulator.paged(context, 'firewalls', all);
  });

  emulator.route('GET', /^\/firewalls\/([^/]+)$/, (context) => {
    const firewall = context.state.firewalls.get(decodeURIComponent(context.match[1]!));
    if (!firewall) return emulator.error('not-found');
    return { status: 200, body: { firewall: read(emulator, context.state, firewall) } };
  });

  emulator.route('POST', /^\/firewalls$/, (context) => {
    const id = uuidFrom(`fw:${context.state.nextId()}`);
    const result = accept(emulator, context, {
      ...structuredClone(template),
      id,
      created_at: isoSeconds(context.state.now()),
    });
    if ('error' in result) return result.error;
    context.state.firewalls.set(id, result.firewall);
    pendingOf(context.state).set(id, emulator.firewallReads);
    return { status: 202, body: { firewall: structuredClone(result.firewall) } };
  });

  emulator.route('PUT', /^\/firewalls\/([^/]+)$/, (context) => {
    const id = decodeURIComponent(context.match[1]!);
    const stored = context.state.firewalls.get(id);
    if (!stored) return emulator.error('not-found');
    const result = accept(emulator, context, stored);
    if ('error' in result) return result.error;
    context.state.firewalls.set(id, result.firewall);
    pendingOf(context.state).set(id, emulator.firewallReads);
    return { status: 200, body: { firewall: structuredClone(result.firewall) } };
  });

  emulator.route('DELETE', /^\/firewalls\/([^/]+)$/, (context) => {
    const id = decodeURIComponent(context.match[1]!);
    if (!context.state.firewalls.delete(id)) return emulator.error('not-found');
    pendingOf(context.state).delete(id);
    return { status: 204 };
  });
}
