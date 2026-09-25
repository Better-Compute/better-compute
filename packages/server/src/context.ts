import type { ModuleContext, RegistryView } from '@better-compute/core';
import { cachesFor, publicCaches } from './caches.js';
import type { ResolvedOptions } from './options.js';
import type { RuntimePorts } from './runtime/index.js';

// The ports a module reaches through its context (PLAN.md §5.4). The store (with after-commit
// hooks), the clock, IAM and the registry come from the options; leases, the work queue, desired
// state, commands, events and the authz projection from the worker runtime (./runtime). Capacity
// and inventory are backed by the built-in modules (the capacity module's quota + inline placer,
// the latest inventory snapshot); `options.ports` overrides them. `afterCommit` is the store's
// commit hook (best-effort side effects once the outermost transaction commits) and `caches` the
// envelope's authentication and read-decision caches, for invalidation (the IAM bridge's inbox).

/** The context every module's `api()`, reconciler and method handler builds on. */
export function createModuleContext(
  options: ResolvedOptions,
  registry: RegistryView,
  ports: RuntimePorts,
): ModuleContext {
  // The same caches the envelope reads (one per resolved options object).
  const caches = publicCaches(cachesFor(options, { now: () => options.clock.now() }));
  return Object.freeze({
    sql: options.database,
    clock: options.clock,
    iam: options.iam,
    registry,
    log: options.log,
    leases: ports.leases,
    work: ports.work,
    desired: ports.desired,
    commands: ports.commands,
    events: ports.events,
    authz: ports.authz,
    capacity: ports.capacity,
    inventory: ports.inventory,
    afterCommit: (hook: () => void | Promise<void>) => options.afterCommit(hook),
    caches,
  });
}
