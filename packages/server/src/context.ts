import type { ComputeModule, ModuleContext, RegistryView } from '@better-compute/core';
import { cachesFor, publicCaches } from './caches.js';
import type { ResolvedOptions } from './options.js';
import { pkiPort, secretBroker, workflowsOf } from './ports.js';
import type { RuntimePorts } from './runtime/index.js';

// The ports a module reaches through its context (PLAN.md §5.4). The store (with after-commit
// hooks), the clock, IAM and the registry come from the options; leases, the work queue, desired
// state, commands, events and the authz projection from the worker runtime (./runtime). Capacity
// and inventory are backed by the built-in modules (the capacity module's quota + inline placer,
// the latest inventory snapshot); `options.ports` overrides them. `afterCommit` is the store's
// commit hook (best-effort side effects once the outermost transaction commits) and `caches` the
// envelope's authentication and read-decision caches, for invalidation (the IAM bridge's inbox).
// `secrets` is the broker over the configured stores (default: sealed in the database under the
// deployment secret), `pki` mints join tokens in the caller's transaction, and `workflows` is the
// engine of the hosted module that runs workflows (`provisionModule()`), when there is one.

/** The context every module's `api()`, reconciler and method handler builds on. */
export function createModuleContext(
  options: ResolvedOptions,
  registry: RegistryView,
  ports: RuntimePorts,
  modules: readonly ComputeModule[] = [],
): ModuleContext {
  // The same caches the envelope reads (one per resolved options object).
  const caches = publicCaches(cachesFor(options, { now: () => options.clock.now() }));
  const workflows = workflowsOf(modules, {
    work: ports.work,
    events: ports.events,
    commands: ports.commands,
  });
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
    typePrefix: options.typePrefix,
    secrets: secretBroker(options.secretStores),
    pki: pkiPort(undefined, options.workloadIssuer),
    ...(workflows ? { workflows } : {}),
  });
}
