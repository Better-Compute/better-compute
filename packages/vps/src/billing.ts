/**
 * Billing rules for provider instances (platform compute billing, D4, D5, D8): which meters one running instance
 * records and how many units per hour. Pure: the usage reconciler multiplies each line by the hour fraction. Every
 * key is built from the lower-case shapes `meterCatalog` (@better-compute/core) defines, and the tests cross-check
 * that, so a rule cannot name a meter the rate card lacks.
 */
import {
  canonicalGpuModel,
  defaultMeterGpuModels,
  meterDiskTypes,
  type PoolPolicy,
} from '@better-compute/core';

/** `metered`: priced per resource; `platform-fee`: one managed-VM line (BYO cloud account); `none`: not billed. */
export type BillingMode = 'metered' | 'platform-fee' | 'none';

/** What a provider instance is billed on, resolved by the caller from the flavor, instance and offer. */
export interface BillableShape {
  vcpu: number;
  memoryGiB: number;
  gpus?: { model: string; count: number };
  spot: boolean;
  reserved: boolean;
  granted: boolean;
  /** The flavor's `billing.meter` (`flavor.<...>.hours`): one line that replaces the composed ones. */
  flavorMeter?: string;
  /** An attached public address (set on `running` intervals only): one `ip.public.hours` line. */
  publicIp?: boolean;
  /**
   * Attached disks, each as `disk.<type>.gib.hours` x `sizeGiB` (D9), running or stopped. Absent on intervals opened
   * before disks were captured: the usage reconciler derives them (`disksOf`) when it meters one.
   */
  disks?: readonly BillableDisk[];
}

/** One disk of a provider instance: a priced type (`disk.<type>.gib.hours`) and its size. */
export interface BillableDisk {
  type: string;
  sizeGiB: number;
}

export interface MeterLine {
  meter: string;
  perHour: number;
}

export interface MeterLinesOptions {
  /**
   * The GPU models the deployment's meter catalog names (default `defaultMeterGpuModels`); a model outside them
   * maps to `other`, so no window dead-letters on a meter the rate card lacks.
   */
  gpuModels?: readonly string[];
}

/**
 * The catalog slug of a GPU model: the family `canonicalGpuModel` finds among the catalog's models (a provider
 * string such as `nvidia-h100-80gb` included), else `other`. `meterCatalog` names its models the same way.
 */
function gpuSlug(model: string, known: readonly string[]): string {
  return canonicalGpuModel(model, known);
}

/**
 * Whether `caller` belongs to the IAM root tenant. Without the root tenant's id nobody is known to, so it fails
 * closed: what only the platform may set (flavor meters, pool billing modes) is refused.
 */
export function isRootCaller(
  caller: { tenantId: string } | undefined,
  rootTenantId: string | undefined,
): boolean {
  return caller !== undefined && rootTenantId !== undefined && caller.tenantId === rootTenantId;
}

/**
 * SQL for the account `billingModeOf` takes: the pool's provider account tenant when it is the pool owner's (ruling
 * R1), else NULL, over a `pools p` row joined to its `provider_accounts a`. Metering, estimates and admission all
 * resolve the pool's mode through it, so they never disagree.
 */
export const poolAccountTenantSql =
  'CASE WHEN a.tenant_id = p.owner_tenant_id THEN a.tenant_id END';

/**
 * The billing mode of a pool: an explicit `policy.billing.mode` wins; otherwise a `provider` pool whose owner is a
 * tenant other than the root is a BYO cloud account and pays a platform fee (B8: it is never charged `vm.*`
 * compute); everything else is metered. The owner is the pool's provider account's tenant, which by ruling R1 is
 * the pool's own owner, so a pool whose account did not resolve (`undefined`) falls back to `ownerTenantId`
 * and fails closed rather than open.
 */
export function billingModeOf(
  pool: { ownerTenantId: string; class: string; policy: PoolPolicy },
  account: { tenantId: string } | undefined,
  rootTenantId: string,
): BillingMode {
  const explicit = pool.policy.billing?.mode;
  if (explicit) return explicit;
  if (pool.class !== 'provider') return 'metered';
  const owner = account?.tenantId ?? pool.ownerTenantId;
  return owner === rootTenantId ? 'metered' : 'platform-fee';
}

/**
 * The meter lines one instance records per hour. Reserved instances use `vm.reserved.*` and never the spot variant;
 * granted instances record the informational `vm.grant.usage.hours` line only (D7); a flavor meter replaces the
 * composed compute lines. A `metered` instance adds the lines of what it holds beside its compute: an
 * `ip.public.hours` line while it runs with a public address (D9), granted and flavor-meter instances included
 * (a grant covers the VM, not its address or disks), then a `disk.<type>.gib.hours` line per disk type, in both
 * phases (a stopped VM keeps its disks). `platform-fee` and `none` never add them.
 */
export function meterLinesFor(
  shape: BillableShape,
  mode: BillingMode,
  phase: 'running' | 'stopped',
  options: MeterLinesOptions = {},
): MeterLine[] {
  // Precedence: none, then platform-fee (granted+platform-fee -> managed line), then (metered) the compute lines of
  // a running instance - granted, else the flavor meter, else composition - and the ancillary lines after them.
  if (mode === 'none') return [];
  if (mode === 'platform-fee')
    return phase === 'stopped' ? [] : [{ meter: 'vm.managed.hours', perHour: 1 }];
  const out: MeterLine[] = phase === 'running' ? computeLines(shape, options) : [];
  if (phase === 'running' && shape.publicIp === true)
    out.push({ meter: 'ip.public.hours', perHour: 1 });
  out.push(...diskLines(shape.disks ?? []));
  return out;
}

/** What the `DiskTypeUnknown` condition names for a disk whose type the provider could not read. */
export const unreadableDiskType = 'unreadable';

/** The disk type a boot disk is metered as when its type is unknown or absent. */
export const defaultDiskType = 'pd-balanced';

/** The priced disk types (`disk.<type>.gib.hours`). */
const pricedDiskTypes: ReadonlySet<string> = new Set(meterDiskTypes);

/** The meter key of a disk type, and `pd-balanced`'s for a type with no meter of its own. */
export function diskMeterOf(type: string): string {
  return `disk.${pricedDiskTypes.has(type) ? type : defaultDiskType}.gib.hours`;
}

/** One line per disk type: the sizes of its disks summed. */
function diskLines(disks: readonly BillableDisk[]): MeterLine[] {
  const sizes = new Map<string, number>();
  for (const disk of disks) {
    if (!(disk.sizeGiB > 0)) continue;
    const meter = diskMeterOf(disk.type);
    sizes.set(meter, (sizes.get(meter) ?? 0) + disk.sizeGiB);
  }
  return [...sizes].map(([meter, perHour]) => ({ meter, perHour }));
}

/** What a provider says about a machine's disks (`ExternalMachine.disks`, `bootDiskType`). */
export interface DiskRecord {
  disks?: readonly { type?: string | undefined; sizeGiB: number }[] | undefined;
  bootDiskType?: string | undefined;
}

/**
 * The disks an instance is billed for, and the provider types that have no meter (they are metered as
 * `pd-balanced`, and the caller raises the `DiskTypeUnknown` condition). The machine record's own disks when the
 * provider reports any; otherwise one boot disk of the flavor's `diskGiB`, of the type the record marks for the
 * machine family (`bootDiskType`, `hyperdisk-balanced` for the families that only take Hyperdisk) or `pd-balanced`.
 * The same rule at interval open and when the reconciler meters an interval that predates disks (ruling F7-3).
 */
export function disksOf(
  machine: DiskRecord | undefined,
  flavorDiskGiB: number,
): { disks: BillableDisk[]; unknownTypes: string[] } {
  const unknownTypes: string[] = [];
  // A fallback boot disk with no marked type is pd-balanced; a reported disk with no type, or one with no meter, is
  // metered as pd-balanced and named (the `DiskTypeUnknown` condition).
  const typed = (raw: string | undefined, reported: boolean): string => {
    if (raw === undefined || raw === '') {
      if (!reported) return defaultDiskType;
      raw = unreadableDiskType;
    }
    if (pricedDiskTypes.has(raw)) return raw;
    if (!unknownTypes.includes(raw)) unknownTypes.push(raw);
    return defaultDiskType;
  };
  const reported = (machine?.disks ?? []).filter(
    (disk) => Number.isFinite(disk.sizeGiB) && disk.sizeGiB > 0,
  );
  if (reported.length > 0)
    return {
      // Sorted, so the order a provider lists disks in never splits an interval (the shape is compared as JSON).
      disks: reported
        .map((disk) => ({ type: typed(disk.type, true), sizeGiB: disk.sizeGiB }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.sizeGiB - b.sizeGiB),
      unknownTypes,
    };
  if (!(flavorDiskGiB > 0)) return { disks: [], unknownTypes };
  return {
    disks: [{ type: typed(machine?.bootDiskType, false), sizeGiB: flavorDiskGiB }],
    unknownTypes,
  };
}

function computeLines(shape: BillableShape, options: MeterLinesOptions): MeterLine[] {
  if (shape.granted) return [{ meter: 'vm.grant.usage.hours', perHour: 1 }];
  if (shape.flavorMeter) return [{ meter: shape.flavorMeter, perHour: 1 }];

  const prefix = shape.reserved ? 'vm.reserved.' : 'vm.';
  const out: MeterLine[] = [];
  if (shape.vcpu > 0) out.push({ meter: `${prefix}vcpu.hours`, perHour: shape.vcpu });
  if (shape.memoryGiB > 0)
    out.push({ meter: `${prefix}memory.gib.hours`, perHour: shape.memoryGiB });
  if (shape.gpus && shape.gpus.count > 0) {
    const slug = gpuSlug(shape.gpus.model, options.gpuModels ?? defaultMeterGpuModels);
    const spot = shape.spot && !shape.reserved ? '.spot' : '';
    out.push({ meter: `${prefix}gpu.${slug}${spot}.hours`, perHour: shape.gpus.count });
  }
  out.push({ meter: 'vm.instance.hours', perHour: 1 });
  return out;
}

/**
 * Whether `address` is a public IPv4 address: not private (RFC 1918), loopback, link-local, carrier-grade NAT
 * (100.64/10), "this network", multicast or reserved. IPv6 is never counted: the priced address is the IPv4 one, and
 * a provider with per-interface detail says so through `publicAddress`.
 */
export function isPublicIpv4(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address.trim());
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if (c > 255 || d > 255 || a > 255 || b > 255) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

/**
 * Whether the machine holds a public address now: an interface that reports one (`publicAddress`), or a public IPv4
 * among its flat `addresses` (a provider that reports no interface detail).
 */
export function hasPublicAddress(machine: {
  addresses?: readonly string[] | undefined;
  networks?: readonly { publicAddress?: string | undefined }[] | undefined;
}): boolean {
  return (
    (machine.networks ?? []).some(
      (nic) => typeof nic.publicAddress === 'string' && nic.publicAddress !== '',
    ) || (machine.addresses ?? []).some(isPublicIpv4)
  );
}
