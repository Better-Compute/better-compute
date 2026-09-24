import {
  notImplemented,
  type CapacityPort,
  type CommandQueue,
  type DesiredState,
  type EventPublisher,
  type InventoryPort,
  type LeaseProvider,
  type ModuleContext,
  type RegistryView,
} from '@better-compute/core';
import type { ResolvedOptions } from './options.js';

// The ports a module reaches through its context. P0 has the store, the clock, IAM and the
// registry; the runtimes behind the others land in v0.1 and answer NOT_IMPLEMENTED until then.

const later = (feature: string) => () => Promise.reject(notImplemented(feature, 'v0.1'));

const leases: LeaseProvider = {
  acquire: later('Leases'),
  release: later('Leases'),
  fence: later('Leases'),
};
const commands: CommandQueue = {
  enqueue: later('The command queue'),
  cancel: later('The command queue'),
};
const desired: DesiredState = { invalidate: later('Desired state') };
const capacity: CapacityPort = {
  reserve: later('The capacity module'),
  release: later('The capacity module'),
};
const inventory: InventoryPort = { get: later('Inventory storage') };
const events: EventPublisher = { publish: later('The event outbox') };

/** The context every module's `api()` and every method handler builds on. */
export function createModuleContext(
  options: ResolvedOptions,
  registry: RegistryView,
): ModuleContext {
  return Object.freeze({
    sql: options.database,
    clock: options.clock,
    leases,
    iam: options.iam,
    registry,
    commands,
    desired,
    capacity,
    inventory,
    events,
    log: options.log,
  });
}
