import { defineMethod, type DriverDefinition, type MethodDefinition } from '@better-compute/core';
import { fields } from './common.js';
import { parser, v } from './input.js';

// `drivers.list` (PLAN.md §5.4, §9.2, module server, v0.2): the drivers this deployment registered
// (options, modules and plugins), so `metal.enroll` callers and the console can offer valid choices.
// Only declarations: never a configuration or a credential. Decided on `compute-tenant/{t}` with
// `compute:drivers:read`.

export interface ListDriversInput {
  tenantId: string;
  /** Only drivers implementing this kind (`power`, `virtual-media`, `runtime`, ...). */
  kind?: string;
}

export interface DriverInfo {
  id: string;
  version: string;
  runsOn: string;
  /** The driver kinds it implements, sorted. */
  kinds: string[];
  capabilities: string[];
  /** Per kind, the operations safe to retry after an interruption. */
  retrySafe: Record<string, string[]>;
}

export type DriversApi = {
  drivers: {
    list: MethodDefinition<ListDriversInput, { items: DriverInfo[] }>;
  };
};

const listInput: (input: unknown) => ListDriversInput = parser({
  tenantId: fields.tenantId,
  kind: v.optional(v.string({ pattern: /^[a-z][a-z0-9-]{0,63}$/, max: 64 })),
});

/** Where the drivers come from: the registry's `extensions`, filtered to drivers. */
export type DriverSource = () => readonly DriverDefinition[];

export function driverInfo(driver: DriverDefinition): DriverInfo {
  const retrySafe: Record<string, string[]> = {};
  for (const [kind, operations] of Object.entries(driver.retrySafe ?? {}))
    retrySafe[kind] = [...((operations as readonly string[] | undefined) ?? [])].sort();
  return {
    id: driver.id,
    version: driver.version,
    runsOn: String(driver.runsOn),
    kinds: Object.keys(driver.implements ?? {}).sort(),
    capabilities: [...(driver.capabilities ?? [])].sort(),
    retrySafe,
  };
}

export function driversApi(source: DriverSource): DriversApi {
  return {
    drivers: {
      list: defineMethod<ListDriversInput, { items: DriverInfo[] }>({
        action: 'compute:drivers:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: listInput,
        async handler(_context, input) {
          const items = source()
            .map(driverInfo)
            .filter((driver) => input.kind === undefined || driver.kinds.includes(input.kind))
            .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
          return { items };
        },
      }),
    },
  };
}
