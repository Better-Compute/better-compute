import { ComputeError, type Json, type ProfileDocument, type ProfileStep, type SqlTx } from '@better-compute/core';
import type { HardwareProfile } from './module-types.js';
import type { MetalNodeRow } from './store.js';

// What a node's BMC driver can do, checked before a workflow needs it (PLAN.md §3.5, §5.4). Redfish is
// built into bcd's site agent and serves every operation metal sends; other drivers are bcx plugins
// the site agent hosts (bcx-ipmi: power and the boot device only). A profile step that needs an
// operation the driver lacks fails the verb up front (`UNSUPPORTED`, reason `bmc-driver-unsupported`,
// naming the step, operations and driver) instead of failing with DRIVER_ERROR mid-workflow. An
// optional step (out-of-band inspection: the ramdisk inspects in band later) is skipped instead.
// A driver this table does not know is not checked in advance: its site agent answers at run time.

/** Every BMC operation metal sends (the site agent's allowlist, daemon/internal/agent/site.go). */
export const bmcOperationNames = [
  'power.getPower',
  'power.setPower',
  'management.setBootDevice',
  'management.rotateCredential',
  'inspect.inspect',
  'virtual-media.insert',
  'virtual-media.eject',
  'firmware.components',
  'firmware.update',
  'bios.getSettings',
  'bios.applySettings',
  'raid.getLayout',
  'raid.applyLayout',
] as const;
export type BmcOperationName = (typeof bmcOperationNames)[number];

/**
 * Not an operation: the driver's `inspect.inspect` reports the machine's PXE MACs (Redfish does; IPMI
 * cannot name host NICs). Without it the ramdisk can only boot a machine enrolled with its `macs`.
 */
export const inspectFindsMacs = 'inspect.macs';

/** BMC driver id → the operations it serves (`metal({ bmcDrivers })` adds drivers or replaces these). */
export type BmcDriverCapabilities = Readonly<Record<string, readonly string[]>>;

/** The drivers metal knows: Redfish (built into bcd) and bcx-ipmi (daemon/cmd/bcx-ipmi, FRU inspection since 7818f19). */
export const builtinBmcDrivers: BmcDriverCapabilities = Object.freeze({
  redfish: [...bmcOperationNames, inspectFindsMacs],
  ipmi: ['power.getPower', 'power.setPower', 'management.setBootDevice', 'inspect.inspect'],
});

/** A driver's concern (`power`, `inspect`, …): the part of an operation before its dot. */
const concernOf = (operation: string) => operation.slice(0, operation.indexOf('.'));

/**
 * The operations `driver` serves, or `undefined` when it is not known (then nothing is checked in
 * advance). `reported`: the kinds the site's agents say their hosted driver serves (`siteDriverKinds`);
 * they narrow the table to those concerns, and make a driver the table does not know checkable.
 */
export function servedBmcOperations(
  driver: string,
  configured: BmcDriverCapabilities = {},
  reported?: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  const list = Object.hasOwn(configured, driver) ? configured[driver] : Object.hasOwn(builtinBmcDrivers, driver) ? builtinBmcDrivers[driver] : undefined;
  if (!reported) return list ? new Set(list) : undefined;
  return new Set((list ?? bmcOperationNames).filter((operation) => reported.has(concernOf(operation))));
}

/** Whether `driver` serves `operation`: `undefined` when the driver is not known. */
export function servesBmcOperation(
  driver: string,
  operation: string,
  configured?: BmcDriverCapabilities,
  reported?: ReadonlySet<string>,
): boolean | undefined {
  return servedBmcOperations(driver, configured, reported)?.has(operation);
}

/** Drivers built into bcd's site agent, which Hello.drivers never lists. */
const agentBuiltinDrivers: ReadonlySet<string> = new Set(['redfish']);

/**
 * The kinds (concerns) the site agents of `siteId` report `driver` serves: each Hello writes
 * `bc.dev/driver-kind.<driver>.<kind>` labels (14ceb1e). `undefined` when no agent reports the driver
 * (an older agent, or a built-in driver), so the table decides alone.
 */
export async function siteDriverKinds(tx: SqlTx, siteId: string, driver: string): Promise<ReadonlySet<string> | undefined> {
  if (agentBuiltinDrivers.has(driver)) return undefined;
  const prefix = `bc.dev/driver-kind.${driver}.`;
  const { rows } = await tx.query<{ kind: string }>(
    `SELECT DISTINCT substr(l.key, $3::int) AS kind
       FROM node_labels l JOIN nodes agent ON agent.id = l.node_id
      WHERE agent.site_id = $1 AND agent.role = 'site' AND agent.deleted_at IS NULL AND starts_with(l.key, $2)`,
    [siteId, prefix, prefix.length + 1],
  );
  return rows.length ? new Set(rows.map((row) => row.kind)) : undefined;
}

/** The BMC operations a step needs; `optional` steps are skipped when the driver lacks them. */
export interface BmcNeed {
  operations: readonly BmcOperationName[];
  optional?: boolean;
}

type NeedNode = Pick<MetalNodeRow, 'hardware_profile' | 'pool_policy'>;

/** What metal's own steps need from the BMC for `node` (none for steps that send no BMC operation). */
export function stepBmcNeed(
  step: Pick<ProfileStep, 'use' | 'with'>,
  node: NeedNode,
  hardwareProfiles: Readonly<Record<string, HardwareProfile>> = {},
): BmcNeed | undefined {
  const profile = node.hardware_profile ? hardwareProfiles[node.hardware_profile] : undefined;
  const bios = profile?.bios && Object.keys(profile.bios).length > 0;
  const raid = profile?.raid && profile.raid.volumes.length > 0;
  switch (step.use) {
    case 'power.getPower':
      return { operations: ['power.getPower'] };
    case 'power.setPower':
      return { operations: ['power.setPower'] };
    case 'management.setBootDevice':
      return { operations: ['management.setBootDevice'] };
    // Optional: the ramdisk inspects in band (it needs the PXE MACs, given at enroll).
    case 'inspect.oob':
      return { operations: ['inspect.inspect'], optional: true };
    case 'metal.ensureRamdisk':
      return { operations: ['management.setBootDevice', 'power.setPower'] };
    case 'media.insert':
      return { operations: ['virtual-media.insert'] };
    case 'media.eject':
      return { operations: ['virtual-media.eject'] };
    case 'metal.firmwareCheck':
      // firmware.update only on drift with reflash remediation: checked when it happens.
      return { operations: ['firmware.components'] };
    case 'metal.rotateBmcCredential':
      return { operations: ['management.rotateCredential'] };
    case 'bios.apply':
      return bios ? { operations: ['bios.getSettings', 'bios.applySettings', 'power.setPower'] } : undefined;
    case 'bios.verify':
      return bios ? { operations: ['bios.getSettings'] } : undefined;
    case 'raid.apply':
      return raid ? { operations: ['raid.applyLayout', 'raid.getLayout'] } : undefined;
    default:
      return undefined;
  }
}

/** What a check reads: the module's hardware profiles and BMC drivers, and what the site's agents report. */
export interface CapabilityOptions {
  hardwareProfiles?: Readonly<Record<string, HardwareProfile>>;
  bmcDrivers?: BmcDriverCapabilities;
  /** `siteDriverKinds` for the node's site and driver. */
  reportedKinds?: ReadonlySet<string> | undefined;
}

/** One step whose BMC operations the driver lacks. */
export interface UnmetBmcNeed {
  profile: string;
  step: string;
  operations: string[];
}

/**
 * The steps of `profiles` that need BMC operations `node`'s driver does not serve. Optional steps, and
 * steps that may fail (`onFailure: 'continue'`), are left out: they never stop the workflow. Empty for a
 * driver not in the table.
 */
export function unmetBmcNeeds(
  profiles: readonly ProfileDocument[],
  node: NeedNode & Pick<MetalNodeRow, 'bmc_driver'>,
  options: CapabilityOptions = {},
): UnmetBmcNeed[] {
  const served = servedBmcOperations(node.bmc_driver, options.bmcDrivers, options.reportedKinds);
  if (!served) return [];
  const unmet: UnmetBmcNeed[] = [];
  for (const profile of profiles)
    for (const step of [...(profile.steps ?? []), ...(profile.cleanup ?? [])]) {
      if (step.onFailure === 'continue') continue;
      const need = stepBmcNeed(step, node, options.hardwareProfiles);
      if (!need || need.optional) continue;
      const missing = need.operations.filter((operation) => !served.has(operation));
      if (missing.length) unmet.push({ profile: `${profile.id}@${profile.version}`, step: step.use, operations: missing });
    }
  return unmet;
}

/** The error for unmet needs: `UNSUPPORTED`, reason `bmc-driver-unsupported`, naming what is missing. */
export function bmcDriverUnsupported(driver: string, unmet: readonly UnmetBmcNeed[], extra?: string): ComputeError {
  const what = unmet.map((need) => `${need.step} needs ${need.operations.join(', ')}`).join('; ');
  return new ComputeError(
    'UNSUPPORTED',
    `The ${driver} BMC driver cannot run this: ${what}${extra ? `. ${extra}` : ''}`,
    undefined,
    { reason: 'bmc-driver-unsupported', driver, unmet: unmet.map((need) => ({ ...need })) as unknown as Json },
  );
}

/** Throws `bmcDriverUnsupported` when `profiles` need what `node`'s driver lacks. */
export function assertBmcNeeds(
  profiles: readonly ProfileDocument[],
  node: NeedNode & Pick<MetalNodeRow, 'bmc_driver'>,
  options: CapabilityOptions = {},
): void {
  const unmet = unmetBmcNeeds(profiles, node, options);
  if (unmet.length) throw bmcDriverUnsupported(node.bmc_driver, unmet);
}

/**
 * A machine the ramdisk will boot (a pool with an agent) needs its PXE MACs: from out-of-band inspection
 * when the driver reports them, else given at enroll. `UNSUPPORTED` (`bmc-driver-unsupported`) otherwise.
 * Only the table says whether inspection finds MACs: a driver it does not know is not checked.
 */
export function assertPxeMacsKnowable(
  node: Pick<MetalNodeRow, 'bmc_driver' | 'macs' | 'pool_agent'>,
  options: Pick<CapabilityOptions, 'bmcDrivers' | 'reportedKinds'> = {},
): void {
  if (node.pool_agent === 'none' || node.macs.length > 0) return;
  if (!servedBmcOperations(node.bmc_driver, options.bmcDrivers)) return;
  const served = servedBmcOperations(node.bmc_driver, options.bmcDrivers, options.reportedKinds)!;
  if (served.has(inspectFindsMacs)) return;
  throw bmcDriverUnsupported(
    node.bmc_driver,
    [{ profile: 'metal-inspect', step: 'metal.ensureRamdisk', operations: [inspectFindsMacs] }],
    'It cannot report the PXE MACs the ramdisk boots from: enroll the machine with macs',
  );
}

/** Result codes with which a site agent says its driver lacks an operation. */
export const unsupportedBmcCodes: ReadonlySet<string> = new Set(['unsupported-driver', 'unsupported-operation']);
