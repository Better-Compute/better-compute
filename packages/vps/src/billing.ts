/**
 * Billing rules for provider instances (platform compute billing, D4, D5, D8): which meters one running instance
 * records and how many units per hour. Pure: the usage reconciler multiplies each line by the hour fraction. Every
 * key is built from the lower-case shapes `meterCatalog` (@better-compute/core) defines, and the tests cross-check
 * that, so a rule cannot name a meter the rate card lacks.
 */
import { canonicalGpuModel, defaultMeterGpuModels, type PoolPolicy } from '@better-compute/core';

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
  /** Task 13: attached disks. No lines yet. */
  disks?: readonly { type: string; sizeGiB: number }[];
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
 * (a grant covers the VM, not its address). `phase: 'stopped'` carries only the disk lines (Task 13), so it is
 * empty for now. `platform-fee` and `none` never add them.
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
  return out;
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
