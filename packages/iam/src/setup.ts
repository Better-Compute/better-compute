// `better-compute iam setup` and `doctor` as library functions (PLAN.md §12.1, §12.6, §12.7): the root meters,
// the example tenant policies an org admin applies (compute cannot write organization policies), and the
// checks every IAM host must pass.

import {
  ComputeError,
  fleetResourceId,
  type Credential,
  type Finding,
  type MeterSpec,
} from '@better-compute/core';
import { ensureMetersOn } from './billing-port.js';
import type { ComputeCatalog } from './catalog.js';

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
  /** GPU models to price (`other` is always added); each gets on-demand, spot, VM and reserved meters. */
  gpuModels: readonly string[];
  /** Whole-shape meters root set on flavors (`billing.meter`), e.g. `flavor.a3-highgpu-8g.us-central1.hours`. */
  flavorMeters?: readonly string[];
}

/**
 * Every meter any compute reconciler can emit (platform compute billing), as better-iam rate-card meters:
 * hosted and node-lease GPU, CPU, memory and volume hours (the old root meters stay, first and in order), provider
 * VM compute (`vm.*`, D4), reserved variants (D8), reservation grants and managed VMs (D7), and the ancillary
 * network, address, disk and snapshot meters (D9). Throws when the list would pass better-iam's 100 meters.
 */
export function meterCatalog(options: MeterCatalogOptions): MeterSpec[] {
  const models = [...new Set([...options.gpuModels.map((model) => model.toLowerCase()), 'other'])];
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
  for (const slug of models)
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

export interface PolicyStatementDoc {
  sid?: string;
  effect: 'allow' | 'deny';
  actions: string[];
  resources: string[];
  conditions?: Record<string, Record<string, unknown>>;
}
export interface PolicyDoc {
  name: string;
  document: { version: 1; statements: PolicyStatementDoc[] };
}

export interface ExamplePolicyOptions {
  /** The compute API's session JWT audience (`sts.jwt.audiences` must contain it). */
  audience: string;
  typePrefix?: string;
  /** `ReserveBoundedH100` limits; defaults are the plan's. */
  gpuModel?: string;
  regions?: string[];
  maxGpus?: number;
  maxHours?: number;
  /** The flag the reservation statement requires in `tenant.features`. Default `compute.<model>`. */
  feature?: string;
}

/**
 * The §12.6 example policies, parameterized: `gpu-user` (list, see shared pools, reserve bounded GPUs,
 * manage own reservations, stop when over budget, mint compute session JWTs) and `agent-guardrails`.
 */
export function examplePolicies(options: ExamplePolicyOptions): PolicyDoc[] {
  const p = options.typePrefix ?? 'compute-';
  const model = options.gpuModel ?? 'H100';
  const reservation = `${p}reservation/*`;
  const gpuUser: PolicyStatementDoc[] = [
    {
      sid: 'ListInTenant',
      effect: 'allow',
      actions: ['compute:pools:read', 'compute:capacity:read', 'compute:reservations:read'],
      resources: [`${p}tenant/*`],
    },
    {
      sid: 'SeeSharedPools',
      effect: 'allow',
      actions: ['compute:pools:read', 'compute:capacity:read'],
      resources: [`${p}pool/*`],
      conditions: { ArrayContains: { 'resource.relations': 'user' } },
    },
    {
      sid: `ReserveBounded${model.replace(/[^A-Za-z0-9]/g, '')}`,
      effect: 'allow',
      actions: ['compute:reservations:create'],
      resources: [reservation],
      conditions: {
        StringEquals: {
          'resource.gpuModel': model,
          'resource.region': options.regions ?? ['eu-west-1', 'eu-central-1'],
        },
        NumericLessThanEquals: {
          'resource.gpuCount': options.maxGpus ?? 8,
          'resource.durationHours': options.maxHours ?? 72,
        },
        ArrayContains: {
          'resource.parentRelations': 'user',
          'tenant.features': options.feature ?? `compute.${model.toLowerCase()}`,
        },
      },
    },
    {
      sid: 'OwnReservations',
      effect: 'allow',
      actions: ['compute:reservations:read', 'compute:reservations:release'],
      resources: [reservation],
      conditions: { StringEquals: { 'resource.ownerId': '${principal.id}' } },
    },
    {
      sid: 'BoundedExtend',
      effect: 'allow',
      actions: ['compute:reservations:extend'],
      resources: [reservation],
      conditions: {
        StringEquals: { 'resource.ownerId': '${principal.id}' },
        NumericLessThanEquals: { 'resource.durationHours': options.maxHours ?? 72 },
      },
    },
    {
      sid: 'StopWhenOverBudget',
      effect: 'deny',
      actions: [
        'compute:reservations:create',
        'compute:reservations:extend',
        'compute:instances:create',
        'compute:sandboxes:create',
        'compute:sandboxes:update',
      ],
      resources: ['*'],
      conditions: { Bool: { 'principal.spendExceeded': true } },
    },
    {
      sid: 'SessionJwtForCompute',
      effect: 'allow',
      actions: ['iam:session-tokens:create'],
      resources: ['iam/${principal.id}'],
    },
    {
      sid: 'AssertToCompute',
      effect: 'allow',
      actions: ['iam:assertions:create'],
      resources: [`iam/${options.audience}`],
    },
  ];
  const guarded = ['compute:nodes:ssh-root', 'compute:nodes:provision', 'compute:images:publish'];
  const guardrails: PolicyStatementDoc[] = [
    {
      sid: 'AgentKeys',
      effect: 'deny',
      actions: guarded,
      resources: ['*'],
      conditions: { StringEquals: { 'principal.kind': 'agent' } },
    },
    {
      sid: 'DelegatedSessions',
      effect: 'deny',
      actions: guarded,
      resources: ['*'],
      conditions: { Bool: { 'principal.delegated': true } },
    },
    {
      sid: 'DelegatedSmall',
      effect: 'deny',
      actions: ['compute:reservations:create', 'compute:reservations:extend'],
      resources: [reservation],
      conditions: {
        Bool: { 'principal.delegated': true },
        NumericGreaterThan: { 'resource.gpuCount': 4 },
      },
    },
  ];
  return [
    { name: 'gpu-user', document: { version: 1, statements: gpuUser } },
    { name: 'agent-guardrails', document: { version: 1, statements: guardrails } },
  ];
}

/** The better-iam management calls `setupIamMeters` uses; `betterIam().api` satisfies it. */
export interface IamSetupApi {
  billing: {
    listMeters(credential: Credential, input: { tenantId: string }): Promise<{ key: string }[]>;
    createMeter(
      credential: Credential,
      input: {
        tenantId: string;
        key: string;
        name: string;
        unit: string;
        pricing?: MeterSpec['pricing'];
      },
    ): Promise<unknown>;
  };
}

/** A meter `setupIamMeters` creates; `pricing` defaults to `rate-card`. */
export type SetupMeter = ComputeMeter & { pricing?: MeterSpec['pricing'] };

/**
 * Creates the missing meters (`meterCatalog(...)`) with a root credential; existing ones are left alone. The same
 * list-then-create logic as the IAM port's `ensureMeters`.
 */
export async function setupIamMeters(
  api: IamSetupApi,
  root: { credential: Credential; tenantId: string },
  meters: readonly SetupMeter[],
): Promise<{ created: string[]; existing: string[] }> {
  return ensureMetersOn(
    {
      listMeters: (input) => api.billing.listMeters(root.credential, input),
      createMeter: (input) => api.billing.createMeter(root.credential, input),
    },
    root.tenantId,
    meters.map((meter) => ({ ...meter, pricing: meter.pricing ?? 'rate-card' })),
  );
}

/** What `checkIamHost` reads from an IAM host; `betterIam()`'s result satisfies it. */
export interface IamDoctorHost {
  authorize(request: {
    token?: string;
    headers?: Credential['headers'];
    tenantId: string;
    action: string;
    resource: { type: string; id: string };
  }): Promise<{ allowed: boolean }>;
  api: {
    actions: {
      list(credential: Credential, input: { tenantId: string }): Promise<{ name: string }[]>;
    };
    resourceTypes: {
      list(credential: Credential, input: { tenantId: string }): Promise<{ name: string }[]>;
    };
  };
  sessionTokens?: unknown;
}

export interface IamHostCheckOptions {
  catalog: ComputeCatalog;
  /** A root administrator's credential. */
  credential: Credential;
  rootTenantId: string;
  /** Whether compute accepts session JWTs from this host (it then needs `sts.jwt`). */
  expectSessionJwts?: boolean;
}

/**
 * The per-host doctor checks of §12.1: the catalog is installed (failure mode a), the resolver is installed
 * (a synthetic decision on `compute-fleet/global`, failure mode b), and session JWTs are configured when
 * compute expects them. Never throws for a failing check; it returns findings.
 */
export async function checkIamHost(
  host: IamDoctorHost,
  options: IamHostCheckOptions,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const scope = { tenantId: options.rootTenantId };
  try {
    const actions = new Set(
      (await host.api.actions.list(options.credential, scope)).map((item) => item.name),
    );
    const missing = options.catalog.allActions().filter((action) => !actions.has(action));
    if (missing.length)
      findings.push({
        check: 'iam.catalog',
        severity: 'error',
        message: `This IAM host lacks ${missing.length} compute actions (e.g. ${missing[0]}): it denies compute decisions as UNKNOWN_ACTION and rejects compute:* policies`,
        fix: 'Install bridge.plugin() (or computeIamHost in remote mode) in every betterIam() on this database',
        count: missing.length,
      });
    const types = new Set(
      (await host.api.resourceTypes.list(options.credential, scope)).map((item) => item.name),
    );
    const missingTypes = Object.keys(options.catalog.resourceTypes).filter(
      (type) => !types.has(type),
    );
    if (missingTypes.length)
      findings.push({
        check: 'iam.resource-types',
        severity: 'error',
        message: `This IAM host lacks compute resource types: ${missingTypes.join(', ')}`,
        fix: 'Install bridge.plugin() in every betterIam() on this database',
        count: missingTypes.length,
      });
  } catch (error) {
    findings.push({
      check: 'iam.catalog',
      severity: 'error',
      message: `Could not list the IAM catalog: ${(error as Error).message}`,
      fix: 'Run the doctor with a root administrator credential',
    });
  }
  try {
    await host.authorize({
      ...options.credential,
      tenantId: options.rootTenantId,
      action: 'compute:fleet:admin',
      resource: { type: `${options.catalog.typePrefix}fleet`, id: fleetResourceId },
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    findings.push({
      check: 'iam.resolver',
      severity: 'error',
      message:
        code === 'RESOURCE_RESOLVER_REQUIRED'
          ? 'This IAM host has compute’s catalog but no resolver: compute decisions fail with RESOURCE_RESOLVER_REQUIRED'
          : `A synthetic decision on compute-fleet/global failed: ${(error as Error).message}`,
      fix: 'Pass resolveResource: bridge.resolveResource() to betterIam() and start the iam module',
    });
  }
  if (options.expectSessionJwts && !host.sessionTokens)
    findings.push({
      check: 'iam.session-jwt',
      severity: 'warning',
      message:
        'This IAM host has no sts.jwt configuration, so it cannot mint session JWTs for compute',
      fix: 'Configure sts: { jwt: { signingKeys, audiences: [<compute audience>] } }',
    });
  return findings;
}
