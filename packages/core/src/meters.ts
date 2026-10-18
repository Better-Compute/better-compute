// The meter catalog: every meter any compute reconciler can emit, as better-iam rate-card meters. Pure data, so
// vps (the `billing` API) and iam (setup, the bridge) share one builder.

import { ComputeError } from './errors.js';
import type { MeterSpec } from './iam.js';

/** One better-iam meter compute records usage on. */
export interface ComputeMeter {
  key: string;
  name: string;
  unit: string;
}

const meterPattern = /^[a-z][a-z0-9._-]{0,63}$/;

/** `gpu.<gpuModel>.hours`, lower-cased (`gpu.h100.hours`): pricing is per meter, so one meter per model. */
export function gpuMeterKey(gpuModel: string): string {
  const key = `gpu.${gpuModel.toLowerCase()}.hours`;
  if (!meterPattern.test(key) || gpuModel === 'other')
    throw new ComputeError('INVALID_INPUT', `No meter for GPU model ${JSON.stringify(gpuModel)}`);
  return key;
}

/**
 * The root meters (§12.7): one per GPU model, plus metal node hours, VPS vCPU and memory hours, and warm sandbox
 * vCPU hours.
 */
export function computeMeters(gpuModels: readonly string[]): ComputeMeter[] {
  return [
    ...[...new Set(gpuModels)]
      .filter((model) => model !== 'other')
      .map((model) => ({ key: gpuMeterKey(model), name: `${model} GPU hours`, unit: 'hour' })),
    { key: 'node.metal.hours', name: 'Bare-metal node hours', unit: 'hour' },
    { key: 'vps.vcpu.hours', name: 'VPS vCPU hours', unit: 'hour' },
    { key: 'vps.memory.gib.hours', name: 'VPS memory GiB hours', unit: 'hour' },
    // §3.7: idle warm-pool capacity, billed to the template's tenant until a sandbox claims it.
    { key: 'vps.sandbox.warm', name: 'Warm sandbox vCPU hours', unit: 'hour' },
  ];
}

/** better-iam allows 100 meters per tenant. */
export const iamMeterLimit = 100;

/**
 * The GPU models a catalog covers when the operator names none: the families provider VMs and pools price
 * separately, plus `other`. Per model the catalog holds five GPU meters, so this stays far from better-iam's limit.
 */
export const defaultMeterGpuModels: readonly string[] = [
  'H100',
  'H200',
  'B200',
  'A100',
  'L4',
  'L40S',
  'other',
];

/**
 * The GPU families compute names (`gpuModelFamilies` of @better-compute/inventory, which iam must not depend on:
 * tests pin the two lists together). Hosted and node-lease usage emits `gpu.<family>.hours` (and `.spot`) for any of
 * them, so the catalog always defines those meters.
 */
export const knownGpuFamilies: readonly string[] = [
  'H100',
  'H200',
  'B200',
  'GB200',
  'A100',
  'L40S',
  'L4',
  'RTX-PRO-6000',
  'GH200',
  'L40',
  'A40',
  'A30',
  'A10',
  'RTX-6000-ADA',
  'RTX-A6000',
  'RTX-5090',
  'RTX-5080',
  'RTX-4090',
];

/** The disk types provider instances meter (`disk.<type>.gib.hours`). */
const diskTypes = [
  'pd-standard',
  'pd-balanced',
  'pd-ssd',
  'hyperdisk-balanced',
  'local-ssd',
] as const;

/** Units of the old root meters, by key (they were all `hour` before the catalog named the quantity). */
const rootMeterUnits: Record<string, string> = {
  'node.metal.hours': 'hour',
  'vps.vcpu.hours': 'vcpu-hour',
  'vps.memory.gib.hours': 'gib-hour',
  'vps.sandbox.warm': 'vcpu-hour',
};

export interface MeterCatalogOptions {
  /**
   * GPU models to price on provider VMs (`other` is always added): each gets `vm.gpu.<model>.hours`, its spot
   * variant and `vm.reserved.gpu.<model>.hours`, besides the hosted `gpu.<model>.hours` and spot meters.
   */
  gpuModels: readonly string[];
  /**
   * Families whose hosted `gpu.<family>.hours` and `gpu.<family>.spot.hours` always exist, whatever `gpuModels` says
   * (default `knownGpuFamilies`), so no hosted window dead-letters for a GPU the fleet reports.
   */
  gpuFamilies?: readonly string[];
  /** Whole-shape meters root set on flavors (`billing.meter`), e.g. `flavor.a3-highgpu-8g.us-central1.hours`. */
  flavorMeters?: readonly string[];
}

/**
 * Every meter any compute reconciler can emit (platform compute billing), as better-iam rate-card meters:
 * hosted and node-lease GPU (every known family, on-demand and spot), CPU, memory and volume hours (the old root
 * meters stay, first and in order), provider
 * VM compute (`vm.*`, D4), reserved variants (D8), reservation grants and managed VMs (D7), and the ancillary
 * network, address, disk and snapshot meters (D9). Throws when the list would pass better-iam's 100 meters.
 */
export function meterCatalog(options: MeterCatalogOptions): MeterSpec[] {
  const models = [...new Set([...options.gpuModels.map((model) => model.toLowerCase()), 'other'])];
  const families = (options.gpuFamilies ?? knownGpuFamilies).map((family) => family.toLowerCase());
  const label = (slug: string) => (slug === 'other' ? 'other-GPU' : slug.toUpperCase());
  const catalog: MeterSpec[] = [];
  const add = (key: string, name: string, unit: string) => {
    if (!meterPattern.test(key))
      throw new ComputeError('INVALID_INPUT', `Not a valid meter key: ${JSON.stringify(key)}`);
    catalog.push({ key, name, unit, pricing: 'rate-card' });
  };

  for (const meter of computeMeters(options.gpuModels))
    add(meter.key, meter.name, rootMeterUnits[meter.key] ?? 'gpu-hour');
  add('vps.volume.gib.hours', 'Volume GiB hours', 'gib-hour');
  add('gpu.other.hours', 'Other GPU hours', 'gpu-hour');
  for (const slug of new Set(families))
    add(`gpu.${slug}.hours`, `${label(slug)} GPU hours`, 'gpu-hour');
  for (const slug of new Set([...families, ...models]))
    add(`gpu.${slug}.spot.hours`, `${label(slug)} spot GPU hours`, 'gpu-hour');

  add('vm.vcpu.hours', 'VM vCPU hours', 'vcpu-hour');
  add('vm.memory.gib.hours', 'VM memory GiB hours', 'gib-hour');
  add('vm.instance.hours', 'VM instance hours', 'hour');
  for (const slug of models) {
    add(`vm.gpu.${slug}.hours`, `VM ${label(slug)} GPU hours`, 'gpu-hour');
    add(`vm.gpu.${slug}.spot.hours`, `VM ${label(slug)} spot GPU hours`, 'gpu-hour');
  }
  add('vm.reserved.vcpu.hours', 'Reserved VM vCPU hours', 'vcpu-hour');
  add('vm.reserved.memory.gib.hours', 'Reserved VM memory GiB hours', 'gib-hour');
  for (const slug of models)
    add(`vm.reserved.gpu.${slug}.hours`, `Reserved VM ${label(slug)} GPU hours`, 'gpu-hour');

  add('vm.grant.slot.hours', 'Reservation grant slot hours', 'slot-hour');
  add('vm.grant.usage.hours', 'Reservation grant usage hours (informational)', 'slot-hour');
  add('vm.managed.hours', 'Managed VM hours', 'hour');

  add('network.vpc.hours', 'Tenant network hours', 'hour');
  add('ip.public.hours', 'Public IP hours', 'hour');
  for (const type of diskTypes) add(`disk.${type}.gib.hours`, `${type} disk GiB hours`, 'gib-hour');
  add('snapshot.gib.hours', 'Snapshot GiB hours', 'gib-hour');

  for (const key of options.flavorMeters ?? []) {
    if (!key.startsWith('flavor.'))
      throw new ComputeError(
        'INVALID_INPUT',
        `A flavor meter starts with "flavor.": ${JSON.stringify(key)}`,
      );
    add(key, `Flavor ${key.slice('flavor.'.length)}`, 'hour');
  }

  const unique = new Map(catalog.map((meter) => [meter.key, meter]));
  if (unique.size > iamMeterLimit)
    throw new ComputeError(
      'INVALID_INPUT',
      `The meter catalog has ${unique.size} meters; better-iam allows ${iamMeterLimit} per tenant. Name fewer GPU models or flavor meters.`,
    );
  return [...unique.values()];
}
