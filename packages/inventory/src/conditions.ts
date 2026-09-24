// Node condition types raised from inventory and health (PLAN.md §10.1). `NoSchedule` conditions are
// mirrored into `nodes.no_schedule_reasons` in the same transaction as the condition itself.

/**
 * Every condition type of the §10.1 table:
 * - v0.1: `GpuCountMismatch`, `GpuModelUnknown` (`NoSchedule`, alert);
 * - v0.2: `Xid48` (quarantine the atom), `Xid79` and `Xid95` (cordon, drain and reboot within the
 *   disruption budget), `RowRemapPending` (drain and GPU reset), `RowRemapFailed` (RMA),
 *   `EccUncorrectable`, `NvlinkDegraded` and `PcieReplayHigh` (taint the device);
 * - v0.3: `DiskPressure`, `MemoryPressure`, `CpuPressure` (`NoSchedule` on VPS hosts);
 * - `DriverMismatch`, `DaemonOutdated`, `CertExpiring`, `ClockSkew`, `DuplicateIdentity` (alert,
 *   taint), raised by the controllers that detect them.
 */
export const nodeConditionTypes = [
  'GpuCountMismatch',
  'GpuModelUnknown',
  'Xid48',
  'Xid79',
  'Xid95',
  'RowRemapPending',
  'RowRemapFailed',
  'EccUncorrectable',
  'NvlinkDegraded',
  'PcieReplayHigh',
  'DiskPressure',
  'MemoryPressure',
  'CpuPressure',
  'DriverMismatch',
  'DaemonOutdated',
  'CertExpiring',
  'ClockSkew',
  'DuplicateIdentity',
] as const;
/** A condition type from the §10.1 table (`Condition.type` also carries others, such as `NodeUnreachable`). */
export type NodeConditionType = (typeof nodeConditionTypes)[number];

/** Whether `type` is one of the §10.1 condition types. */
export function isNodeConditionType(type: string): type is NodeConditionType {
  return (nodeConditionTypes as readonly string[]).includes(type);
}

/** The events an inventory diff emits (§10.1); device ids are stable (GPU UUID, disk WWN, MAC). */
export const inventoryChangeTypes = [
  'gpu.missing',
  'gpu.added',
  'disk.replaced',
  'driver.changed',
  'mig.layout.changed',
] as const;
export type InventoryChangeType = (typeof inventoryChangeTypes)[number];
