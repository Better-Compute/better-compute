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
    description: 'Projects created, changed and archived (project.archived: { projectId, name })',
  },
  {
    type: 'tenant.*',
    subject: 'tenant/{id}',
    module: 'server',
    description:
      'IAM tenant mirrored as suspended, deleted or active again (tenant.state-changed: { tenantId, state, previous, reason }); a deleted tenant fully released by every module (tenant.torn-down)',
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
    type: 'quota.budget-exceeded',
    subject: 'pool/{id}',
    module: 'capacity',
    description:
      "A tenant's IAM budget was spent and the pool offer's onBudgetExceeded applied (notify, stop-new or drain)",
  },
  {
    type: 'reservation.*',
    subject: 'reservation/{id}',
    module: 'capacity',
    description:
      'Reservation lifecycle (placed, active, released, ended, …) and awaiting-confirmation',
  },
  {
    type: 'reservation.reassigned',
    subject: 'reservation/{id}',
    module: 'capacity',
    description:
      "An offboarded identity's reservation moved to its successor (§12.7): { reservationId, from, to, reason }",
  },
  {
    type: 'node.*',
    subject: 'node/{id}',
    module: 'server',
    description:
      'Node lifecycle and connectivity: joined, acceptance.*, adopted, connected, disconnected, unreachable, lost, drained, deleted, status, command.queued, ssh-cert.issued, report-failed',
  },
  {
    type: 'node.command.cancel-requested',
    subject: 'node/{id}',
    module: 'server',
    description: 'Cancelling a command was requested ({ nodeId, commandId, kind, state })',
  },
  {
    type: 'node.condition.changed',
    subject: 'node/{id}',
    module: 'inventory',
    description:
      'A hygiene or pressure condition was raised or cleared (DriverMismatch, CertExpiring, DaemonOutdated, Cpu/Memory/DiskPressure): { condition, status, reason, noSchedule }',
  },
  {
    type: 'node.remediation.*',
    subject: 'node/{id}',
    module: 'provision',
    description: 'Health remediation started, succeeded or escalated to an operator',
  },
  {
    type: 'pool.remediation.paused',
    subject: 'node/{id}',
    module: 'provision',
    description:
      'The remediation circuit breaker held a pool back (too many nodes turned unhealthy)',
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
    type: 'node.pxe-mac.discovered',
    subject: 'node/{id}',
    module: 'metal',
    description:
      'PXE discovery found the MAC of a machine enrolled without MACs, first seen under its product UUID right after metal power-cycled it: a candidate for metal.confirmMac, or bound at once on a pool that trusts its provisioning network ({ nodeId, mac, productUuid, siteId, agentNodeId, bound })',
  },
  {
    type: 'node.pxe-mac.confirmed',
    subject: 'node/{id}',
    module: 'metal',
    description: "An operator bound a machine's PXE MAC with metal.confirmMac ({ nodeId, mac, discovered, requestId })",
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
    type: 'provider.machine.*',
    subject: 'provider-account/{id}',
    module: 'vps',
    description:
      'Machines a provider account can see (vps.discovery): discovered { accountId, externalId, machineType, gpus }, changed { accountId, externalId, changes }, gone { accountId, externalId, instanceId? }',
  },
  {
    type: 'sandbox.*',
    subject: 'sandbox/{id}',
    module: 'vps',
    description:
      'Sandbox lifecycle (§3.7): created, ready (its instance first runs), extended, expiring (once, before expiry: { expiresAt }), expired (before the delete), withdrawn (its agent or delegation ended, or its owner left without a successor: { reason }), reassigned ({ from, to, reason }), deleted; data { templateId, instanceId, poolId }',
  },
  {
    type: 'sandbox.snapshot.*',
    subject: 'sandbox/{id}',
    module: 'vps',
    description:
      'A sandbox snapshot settled: ready { snapshotId, includeMemory, sha256, sizeBytes } or failed { snapshotId, reason }',
  },
  {
    type: 'provider.reservation.*',
    subject: 'provider-account/{id}',
    module: 'vps',
    description:
      'Provider capacity reservations seen by the vps.reservations worker: detected { accountId, reservationId, machineType, gpus?, total, state, startsAt? }, changed (+ free, inUse, changes), ready (a scheduled or creating reservation became ready), gone (+ poolId, flavorId when it was bound)',
  },
  {
    type: 'network.*',
    subject: 'network/{id}',
    module: 'vps',
    description:
      'Tenant networks (VPCs): created, ready, error, deleting, deleted; network.subnet.ready and network.rule.ready/error when a subnet or firewall rule converges; data { networkId, ... }',
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
