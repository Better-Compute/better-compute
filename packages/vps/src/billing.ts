/**
 * Billing rules for provider instances (platform compute billing, D4, D5, D8): which meters one running instance
 * records and how many units per hour. Pure: the usage reconciler multiplies each line by the hour fraction. Every
 * key is built from the lower-case shapes `meterCatalog` (@better-compute/core) defines, and the tests cross-check
 * that, so a rule cannot name a meter the rate card lacks.
 */
import { defaultMeterGpuModels, type PoolPolicy } from '@better-compute/core';

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
  /** Task 12: an attached public address. No lines yet. */
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

const slugPattern = /^[a-z][a-z0-9_-]{0,31}$/;

/** The catalog slug of a GPU model: its lower-case name when the catalog covers it, else `other`. */
function gpuSlug(model: string, known: readonly string[]): string {
  const slug = model.trim().toLowerCase();
  if (!slugPattern.test(slug)) return 'other';
  return known.some((name) => name.toLowerCase() === slug) ? slug : 'other';
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
 * The meter lines one instance records per hour. `phase: 'stopped'` carries only disk lines (Task 13), so it is
 * empty for now. Reserved instances use `vm.reserved.*` and never the spot variant; granted instances record the
 * informational `vm.grant.usage.hours` line only (D7); a flavor meter replaces the composed lines.
 */
export function meterLinesFor(
  shape: BillableShape,
  mode: BillingMode,
  phase: 'running' | 'stopped',
  options: MeterLinesOptions = {},
): MeterLine[] {
  // Precedence: none/stopped, then platform-fee (granted+platform-fee -> managed line), then granted, then the flavor
  // meter (flavor+reserved -> flavor line), then composition.
  if (mode === 'none' || phase === 'stopped') return [];
  if (mode === 'platform-fee') return [{ meter: 'vm.managed.hours', perHour: 1 }];
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
