// `better-compute iam setup` and `doctor` as library functions (PLAN.md §12.1, §12.6, §12.7): the root meters,
// the example tenant policies an org admin applies (compute cannot write organization policies), and the
// checks every IAM host must pass.

import {
  fleetResourceId,
  type ComputeMeter,
  type Credential,
  type Finding,
  type MeterSpec,
} from '@better-compute/core';
import { ensureMetersOn } from './billing-port.js';
import type { ComputeCatalog } from './catalog.js';

export {
  computeMeters,
  defaultMeterGpuModels,
  gpuMeterKey,
  iamMeterLimit,
  knownGpuFamilies,
  meterCatalog,
  type ComputeMeter,
  type MeterCatalogOptions,
} from '@better-compute/core';

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
