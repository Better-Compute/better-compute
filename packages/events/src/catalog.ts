// The event catalog (PLAN.md §9.3): the families of event types the control plane and its modules publish through
// the outbox, with the subject each one names. Webhook subscriptions are checked against it, so a typo such as
// `nodes.*` or `node.adoptedd` is refused instead of silently never matching, and `webhooks.eventTypes` lists it.
// Families are patterns because several modules build types from states (`reservation.<state>`,
// `node.provision.<state>`, `rollout.<action>`). Hosts add their plugins' families with `extraEvents`.

import { matchesEventType } from './outbox.js';

export interface EventFamily {
  /** An event type or a family: `node.adopted`, `reservation.*`. */
  type: string;
  /** What `subject` names: `node/{id}`. */
  subject: string;
  /** The module that publishes it. */
  module: string;
  description: string;
}

export const eventCatalog: readonly EventFamily[] = Object.freeze([
  {
    type: 'site.*',
    subject: 'site/{id}',
    module: 'server',
    description: 'Sites created, updated and deleted',
  },
  {
    type: 'project.*',
    subject: 'project/{id}',
    module: 'server',
    description: 'Projects created and changed',
  },
  {
    type: 'pool.*',
    subject: 'pool/{id}',
    module: 'capacity',
    description: 'Pools created, updated, offered, unoffered and archived',
  },
  {
    type: 'quota.updated',
    subject: 'pool/{id}',
    module: 'capacity',
    description: 'A tenant quota on a pool changed',
  },
  {
    type: 'reservation.*',
    subject: 'reservation/{id}',
    module: 'capacity',
    description:
      'Reservation lifecycle (placed, active, released, ended, …) and awaiting-confirmation',
  },
  {
    type: 'node.*',
    subject: 'node/{id}',
    module: 'server',
    description:
      'Node lifecycle and connectivity: joined, acceptance.*, adopted, connected, disconnected, unreachable, lost, drained, deleted, status, command.queued, ssh-cert.issued, report-failed',
  },
  {
    type: 'node.inventory.changed',
    subject: 'node/{id}',
    module: 'inventory',
    description: 'A node reported a different inventory',
  },
  {
    type: 'node.gpu.*',
    subject: 'node/{id}',
    module: 'inventory',
    description: 'A GPU appeared or went missing',
  },
  {
    type: 'node.mig.*',
    subject: 'node/{id}',
    module: 'inventory',
    description: 'A MIG layout changed',
  },
  {
    type: 'node.disk.*',
    subject: 'node/{id}',
    module: 'inventory',
    description: 'A disk was replaced',
  },
  {
    type: 'node.driver.*',
    subject: 'node/{id}',
    module: 'inventory',
    description: 'A driver changed',
  },
  {
    type: 'node.enrolled',
    subject: 'node/{id}',
    module: 'metal',
    description: 'A bare-metal machine enrolled',
  },
  {
    type: 'node.provision.*',
    subject: 'node/{id}',
    module: 'metal',
    description: 'Provisioning state transitions of a bare-metal node',
  },
  {
    type: 'command.settled',
    subject: 'command/{id}',
    module: 'gateway',
    description: 'A command reached a terminal state',
  },
  {
    type: 'workflow.*',
    subject: 'workflow/{id}',
    module: 'provision',
    description: 'Provisioning workflow transitions',
  },
  {
    type: 'instance.*',
    subject: 'instance/{id}',
    module: 'vps',
    description: 'VPS instance lifecycle',
  },
  {
    type: 'fleet.*',
    subject: 'fleet/{id}',
    module: 'fleet',
    description: 'FleetConfig converged or drifted',
  },
  {
    type: 'rollout.*',
    subject: 'rollout/{id}',
    module: 'rollout',
    description: 'Daemon rollouts started, paused, resumed, aborted, completed',
  },
  {
    type: 'tunnel.*',
    subject: 'tunnel/{id}',
    module: 'server',
    description: 'Tunnels issued and closed',
  },
  {
    type: 'security.*',
    subject: 'varies',
    module: 'server',
    description: 'Join tokens, site tokens, refused joins, revoked certificates, secrets',
  },
  {
    type: 'webhook.ping',
    subject: 'webhook/{id}',
    module: 'events',
    description: 'A test delivery from webhooks.ping',
  },
]);

/** The literal part of a pattern before its trailing `.*` (or all of it); `*` has none. */
const literal = (pattern: string): string =>
  pattern === '*' ? '' : pattern.endsWith('.*') ? pattern.slice(0, -2) : pattern;

/**
 * Whether a subscription pattern can match anything the catalog publishes: `*`, an exact type a family covers, or
 * a family that overlaps one (`node.*` and `node.gpu.*` both overlap the `node.*` family).
 */
export function isKnownEventPattern(
  pattern: string,
  catalog: readonly EventFamily[] = eventCatalog,
): boolean {
  if (pattern === '*') return true;
  if (!pattern.endsWith('.*'))
    return catalog.some((family) => matchesEventType(family.type, pattern));
  const prefix = literal(pattern);
  return catalog.some((family) => {
    const other = literal(family.type);
    // Either family contains the other: `node.*` ⊇ `node.gpu.*`, and `node.gpu.*` ⊆ the `node.*` family.
    return (
      other === prefix ||
      other.startsWith(`${prefix}.`) ||
      (family.type.endsWith('.*') && prefix.startsWith(`${other}.`))
    );
  });
}

/** The catalog family an event type belongs to (the most specific one), if any. */
export function eventFamilyOf(
  type: string,
  catalog: readonly EventFamily[] = eventCatalog,
): EventFamily | undefined {
  return catalog
    .filter((family) => matchesEventType(family.type, type))
    .sort((a, b) => literal(b.type).length - literal(a.type).length)[0];
}
