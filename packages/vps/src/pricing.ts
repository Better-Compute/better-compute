import {
  ComputeError,
  defaultMeterGpuModels,
  defineMethod,
  describedBy,
  fleetResourceId,
  isComputeError,
  meterCatalog,
  strictObject,
  type InputSchema,
  type IamPort,
  type MeterSpec,
  type MethodContext,
  type MethodDefinition,
  type PriceSpecInput,
  type PriceView,
  type SqlExecutor,
} from '@better-compute/core';
import { noGroupKey, providerCostTotals, type MarginGroup } from './costs.js';
import { fail, object, optional, tenant } from './input.js';

// The root-only `billing` API group (platform compute billing, D13): the meters and prices root keeps on the IAM
// root tenant, so it can bill sub-tenants for compute. Every method is decided on `compute:billing:*` @ fleet, which
// resolves only in the root tenant. They all go to IAM, which never happens inside a compute transaction, so each
// declares `transaction: 'manual'` and reads what it needs from `context.sql` before or after the IAM call.
// Proposals, margins and estimates join this group in later tasks: add a method to `BillingApi` and to
// `billingApi()`, and keep sharing `catalogOf` so every method agrees on which meters exist.

/** What `vps({ billing })` says about the meter catalog this module defines and prices. */
export interface BillingOptions {
  /**
   * GPU models whose provider-VM meters (`vm.gpu.<model>.hours`, spot and reserved variants) exist; default
   * `defaultMeterGpuModels`, the same default the IAM bridge syncs. Name the same models here as in
   * `bridge.embedded(...)`/`iam setup`, or `billing.meters` reports the difference as missing.
   */
  gpuModels?: readonly string[];
  /** Families whose hosted GPU meters always exist (default `knownGpuFamilies`). */
  gpuFamilies?: readonly string[];
  /**
   * How long after an hour ends `vps.provider-usage` waits before writing its windows (default 5 minutes), so a
   * lifecycle change stamped inside that hour has committed. `0` writes at the top of the hour.
   */
  meterGraceMs?: number;
}

export interface PriceInput {
  meter: string;
  /** The tenant (and subtree) a negotiated price applies to; absent: the list price. better-iam validates it. */
  targetTenantId?: string;
  /** `YYYY-MM`: the first billing period the price applies to. */
  effectiveFrom: string;
  spec: PriceSpecInput;
}

export interface PricesQuery {
  meter?: string;
  targetTenantId?: string;
}

export interface SetPricesInput {
  prices: PriceInput[];
}

/** A price better-iam refused (or that failed on the way): the rest of the request was still applied. */
export interface FailedPrice {
  /** Position in the request's `prices`. */
  index: number;
  meter: string;
  targetTenantId?: string;
  code: string;
  message: string;
}

export interface SetPricesResult {
  applied: PriceView[];
  failed: FailedPrice[];
}

export interface MarginsInput {
  /** Epoch ms; with `spend`, widened to the whole billing periods it touches (`coveredFrom`/`coveredTo`). */
  from: number;
  to: number;
  groupBy: MarginGroup;
}

export interface MarginRow {
  key: string;
  /** Billed spend from better-iam (`IamPort.spend`); null without it, or for a grouping better-iam does not have. */
  revenueMicros: number | null;
  /** Provider cost (cost + credits) in the deployment currency. */
  costMicros: number;
  marginMicros: number | null;
  /** Margin over revenue, in percent (2 decimals); null without revenue. */
  marginPct: number | null;
}

export interface MarginsResult {
  rows: MarginRow[];
  /** Provider cost no tenant was attributed (D10), over the same range. */
  unattributedCostMicros: number;
  currency: string;
  /** The range costs (and revenue) cover: the query's, or the whole billing periods `spend` summed. */
  from: number;
  to: number;
}

export type BillingApi = {
  /** The meters compute defines, and which of them the IAM root tenant still lacks. */
  meters: MethodDefinition<Record<string, never>, { catalog: MeterSpec[]; missing: string[] }>;
  /** Creates the missing meters on the root tenant. */
  syncMeters: MethodDefinition<Record<string, never>, { created: string[]; existing: string[] }>;
  prices: MethodDefinition<PricesQuery, PriceView[]>;
  setPrices: MethodDefinition<SetPricesInput, SetPricesResult>;
  /** Revenue (better-iam spend) minus provider cost, by tenant, pool, account or meter (D12). */
  margins: MethodDefinition<MarginsInput, MarginsResult>;
};

/** The most prices one `setPrices` call takes. */
export const setPricesLimit = 100;

// --- Meters --------------------------------------------------------------------------------------

/**
 * The flavor meters root set (`billing.meter` of a flavor, `flavor.<name>.hours`): the part of the catalog that
 * depends on compute's own data, archived flavors included (their instances may still run). Read outside any IAM call.
 */
export async function flavorMeterKeys(sql: SqlExecutor): Promise<string[]> {
  const { rows } = await sql.query<{ meter: string }>(
    `SELECT DISTINCT billing->>'meter' AS meter FROM flavors WHERE billing->>'meter' IS NOT NULL ORDER BY 1`,
  );
  return rows.map((row) => row.meter);
}

/** The catalog entry of one flavor meter, as `ensureMeters` takes it. */
export function flavorMeterSpec(key: string): MeterSpec {
  return meterCatalog({ gpuModels: [], flavorMeters: [key] }).find((meter) => meter.key === key)!;
}

/** Every meter this deployment can emit: the shared catalog for the configured models, plus the flavor meters. */
export async function catalogOf(
  context: Pick<MethodContext, 'sql'>,
  options: BillingOptions,
): Promise<MeterSpec[]> {
  return meterCatalog({
    gpuModels: options.gpuModels ?? defaultMeterGpuModels,
    ...(options.gpuFamilies ? { gpuFamilies: options.gpuFamilies } : {}),
    flavorMeters: await flavorMeterKeys(context.sql),
  });
}

/**
 * A billing member of the IAM port, bound to it, or `UNSUPPORTED` naming the configuration that provides it
 * (ruling F1-1: the service credential is an explicit opt-in).
 */
function member<K extends 'ensureMeters' | 'listMeters' | 'setPrice' | 'listPrices'>(
  context: MethodContext,
  name: K,
): NonNullable<IamPort[K]> {
  const call = context.iam[name];
  if (typeof call !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `The IAM port has no ${name}, so compute cannot manage billing. Configure it with ` +
        'bridge.embedded(iam, { rootTenantId, serviceCredential }) (remote: bridge.remote with a serviceToken) for a ' +
        'root service account that holds iam:billing:manage and iam:billing:read on the root tenant.',
      undefined,
      { reason: 'billing-port-missing', member: name },
    );
  return (call as (...args: unknown[]) => unknown).bind(context.iam) as NonNullable<IamPort[K]>;
}

// --- Input ---------------------------------------------------------------------------------------

const meterPattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const priceModels = ['per-unit', 'graduated', 'volume', 'package'] as const;

const meterKey: InputSchema = {
  type: 'string',
  pattern: '^[a-z][a-z0-9_.-]{0,63}$',
  maxLength: 64,
  description: 'A meter key, e.g. gpu.h100.hours',
};
const targetTenantId: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description:
    'The tenant (and its subtree) a negotiated price applies to; absent: the list price. better-iam validates it',
};
const micros = (description: string): InputSchema => ({
  type: 'integer',
  minimum: 0,
  description,
});
const priceSpec = strictObject(
  {
    model: { enum: [...priceModels], description: 'better-iam’s price model' },
    unitAmountMicros: micros('Per-unit price, in micros of the deployment currency'),
    tiers: {
      type: 'array',
      maxItems: 50,
      description: 'Graduated and volume tiers; the last has upTo null',
      items: strictObject(
        {
          upTo: { type: ['integer', 'null'], minimum: 1 },
          unitAmountMicros: micros('Price per unit in the tier'),
          flatAmountMicros: micros('Flat amount of the tier'),
        },
        ['upTo', 'unitAmountMicros'],
      ),
    },
    packageSize: { type: 'integer', minimum: 1, description: 'Units per package (package model)' },
    packageAmountMicros: micros('Price of one package (package model)'),
    includedQuantity: { type: 'number', minimum: 0, description: 'Units included at no charge' },
    minimumAmountMicros: micros('The least a period costs'),
    maximumAmountMicros: micros('The most a period costs'),
  },
  ['model'],
);
const priceEntry = strictObject(
  {
    meter: meterKey,
    targetTenantId,
    effectiveFrom: {
      type: 'string',
      pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
      description: 'The first billing period the price applies to, YYYY-MM',
    },
    spec: priceSpec,
  },
  ['meter', 'effectiveFrom', 'spec'],
);

/** The longest range `billing.margins` takes (about a year and a month). */
export const marginsMaxRangeMs = 400 * 86_400_000;
const marginGroups = ['tenant', 'pool', 'account', 'meter'] as const;

export const billingSchemas = {
  none: strictObject({}),
  margins: strictObject(
    {
      from: { type: 'integer', minimum: 0, description: 'Start of the range, epoch ms' },
      to: { type: 'integer', minimum: 1, description: 'End of the range (exclusive), epoch ms' },
      groupBy: {
        enum: [...marginGroups],
        description: 'Group revenue and cost by tenant, pool, provider account or meter',
      },
    },
    ['from', 'to', 'groupBy'],
  ),
  prices: strictObject({ meter: meterKey, targetTenantId }),
  setPrices: strictObject(
    {
      prices: {
        type: 'array',
        minItems: 1,
        maxItems: setPricesLimit,
        description: `At most ${setPricesLimit} prices; each is applied on its own`,
        items: priceEntry,
      },
    },
    ['prices'],
  ),
};

function meterOf(value: unknown, what = 'meter'): string {
  if (typeof value !== 'string' || !meterPattern.test(value))
    fail(`${what} must be a meter key like gpu.h100.hours`);
  return value;
}

function amount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(`${what} must be a non-negative integer of micros`);
  return value;
}

function parsePriceSpec(raw: unknown, what: string): PriceSpecInput {
  const input = object(raw, [
    'model',
    'unitAmountMicros',
    'tiers',
    'packageSize',
    'packageAmountMicros',
    'includedQuantity',
    'minimumAmountMicros',
    'maximumAmountMicros',
  ]);
  if (!(priceModels as readonly unknown[]).includes(input.model))
    fail(`${what}.model must be one of ${priceModels.join(', ')}`);
  const spec: PriceSpecInput = { model: input.model as PriceSpecInput['model'] };
  for (const field of [
    'unitAmountMicros',
    'packageAmountMicros',
    'minimumAmountMicros',
    'maximumAmountMicros',
  ] as const) {
    const value = optional(input[field], (v) => amount(v, `${what}.${field}`));
    if (value !== undefined) spec[field] = value;
  }
  if (input.packageSize !== undefined) {
    if (
      typeof input.packageSize !== 'number' ||
      !Number.isSafeInteger(input.packageSize) ||
      input.packageSize < 1
    )
      fail(`${what}.packageSize must be a positive integer`);
    spec.packageSize = input.packageSize;
  }
  if (input.includedQuantity !== undefined) {
    if (
      typeof input.includedQuantity !== 'number' ||
      !Number.isFinite(input.includedQuantity) ||
      input.includedQuantity < 0
    )
      fail(`${what}.includedQuantity must be a number of at least 0`);
    spec.includedQuantity = input.includedQuantity;
  }
  if (input.tiers !== undefined) {
    if (!Array.isArray(input.tiers) || input.tiers.length > 50)
      fail(`${what}.tiers must list at most 50 tiers`);
    spec.tiers = input.tiers.map((raw, index) => {
      const tier = object(raw, ['upTo', 'unitAmountMicros', 'flatAmountMicros']);
      const where = `${what}.tiers[${index}]`;
      if (
        tier.upTo !== null &&
        (typeof tier.upTo !== 'number' || !Number.isSafeInteger(tier.upTo) || tier.upTo < 1)
      )
        fail(`${where}.upTo must be a positive integer or null`);
      return {
        upTo: tier.upTo as number | null,
        unitAmountMicros: amount(tier.unitAmountMicros, `${where}.unitAmountMicros`),
        ...(tier.flatAmountMicros === undefined
          ? {}
          : { flatAmountMicros: amount(tier.flatAmountMicros, `${where}.flatAmountMicros`) }),
      };
    });
  }
  return spec;
}

export function parseMargins(raw: unknown): MarginsInput {
  const input = object(raw, ['from', 'to', 'groupBy']);
  for (const field of ['from', 'to'] as const)
    if (typeof input[field] !== 'number' || !Number.isSafeInteger(input[field]) || input[field] < 0)
      fail(`${field} must be a time in epoch milliseconds`);
  const from = input.from as number;
  const to = input.to as number;
  if (!(to > from)) fail('to must be after from');
  if (to - from > marginsMaxRangeMs) fail('The range is at most 400 days');
  if (!(marginGroups as readonly unknown[]).includes(input.groupBy))
    fail(`groupBy must be one of ${marginGroups.join(', ')}`);
  return { from, to, groupBy: input.groupBy as MarginGroup };
}

/** better-iam's grouping for a margins grouping; undefined when better-iam has no such dimension (accounts). */
function spendGrouping(
  groupBy: MarginGroup,
): { groupBy: 'tenant' | 'meter' | 'tag'; tag?: string } | undefined {
  if (groupBy === 'tenant') return { groupBy: 'tenant' };
  if (groupBy === 'meter') return { groupBy: 'meter' };
  if (groupBy === 'pool') return { groupBy: 'tag', tag: 'pool' };
  return undefined;
}

export function parsePricesQuery(raw: unknown): PricesQuery {
  const input = object(raw ?? {}, ['meter', 'targetTenantId']);
  return {
    ...(input.meter === undefined ? {} : { meter: meterOf(input.meter) }),
    ...(input.targetTenantId === undefined
      ? {}
      : { targetTenantId: tenant(input.targetTenantId, 'targetTenantId') }),
  };
}

export function parseSetPrices(raw: unknown): SetPricesInput {
  const input = object(raw, ['prices']);
  if (!Array.isArray(input.prices) || input.prices.length === 0)
    fail('prices must list at least one price');
  if (input.prices.length > setPricesLimit)
    fail(`prices takes at most ${setPricesLimit} prices per call`);
  return {
    prices: input.prices.map((entry, index): PriceInput => {
      const price = object(entry, ['meter', 'targetTenantId', 'effectiveFrom', 'spec']);
      const where = `prices[${index}]`;
      if (typeof price.effectiveFrom !== 'string' || !periodPattern.test(price.effectiveFrom))
        fail(`${where}.effectiveFrom must be a billing period like 2026-11`);
      return {
        meter: meterOf(price.meter, `${where}.meter`),
        ...(price.targetTenantId === undefined
          ? {}
          : { targetTenantId: tenant(price.targetTenantId, `${where}.targetTenantId`) }),
        effectiveFrom: price.effectiveFrom,
        spec: parsePriceSpec(price.spec, `${where}.spec`),
      };
    }),
  };
}

// --- Methods -------------------------------------------------------------------------------------

const fleetResource = () => ({ type: 'fleet' as const, id: fleetResourceId });
const noInput = (raw: unknown): Record<string, never> => {
  object(raw ?? {}, []);
  return {};
};

/** The `billing` group's methods. Each is decided on the fleet, so only root (or a root member the policy allows) calls them. */
export function billingApi(
  options: BillingOptions = {},
  /** The deployment currency provider costs are counted in (`vps({ costs: { currency } })`, default USD). */
  costs: { currency?: string } = {},
): BillingApi {
  const currency = (costs.currency ?? 'USD').toUpperCase();
  return {
    margins: defineMethod({
      action: 'compute:billing:read',
      kind: 'read',
      transaction: 'manual',
      resource: fleetResource,
      validate: describedBy(billingSchemas.margins, parseMargins),
      handler: async (context, input): Promise<MarginsResult> => {
        // Revenue first (an IAM call, outside any transaction); it fixes the range costs are summed over
        // (ruling F1-3): better-iam sums whole billing periods.
        const grouping = spendGrouping(input.groupBy);
        const spend = context.iam.spend;
        const rootTenantId = context.iam.rootTenantId;
        let revenue: Map<string, number> | undefined;
        let range = { from: input.from, to: input.to };
        if (typeof spend === 'function' && rootTenantId !== undefined) {
          const result = await spend.call(context.iam, {
            tenantId: rootTenantId,
            from: input.from,
            to: input.to,
            groupBy: grouping?.groupBy ?? 'tenant',
            ...(grouping?.tag ? { tag: grouping.tag } : {}),
          });
          range = { from: result.coveredFrom, to: result.coveredTo };
          if (grouping) {
            revenue = new Map();
            for (const row of result.rows)
              revenue.set(row.key, (revenue.get(row.key) ?? 0) + row.amountMicros);
          }
        }
        const { groups, unattributedMicros } = await providerCostTotals(context.sql, {
          ...range,
          groupBy: input.groupBy,
          currency,
          rootTenantId,
        });
        const keys = [...new Set([...(revenue?.keys() ?? []), ...groups.keys()])].sort((a, b) =>
          a === noGroupKey ? 1 : b === noGroupKey ? -1 : a.localeCompare(b),
        );
        const rows = keys.map((key): MarginRow => {
          const costMicros = groups.get(key) ?? 0;
          // A group better-iam has no revenue for has none (0), unless revenue is unknown altogether.
          const revenueMicros =
            revenue === undefined || key === noGroupKey ? null : (revenue.get(key) ?? 0);
          const marginMicros = revenueMicros === null ? null : revenueMicros - costMicros;
          const marginPct =
            revenueMicros === null || marginMicros === null || revenueMicros <= 0
              ? null
              : Math.round((marginMicros / revenueMicros) * 10_000) / 100;
          return { key, revenueMicros, costMicros, marginMicros, marginPct };
        });
        return { rows, unattributedCostMicros: unattributedMicros, currency, ...range };
      },
    }),
    meters: defineMethod({
      action: 'compute:billing:read',
      kind: 'read',
      transaction: 'manual',
      resource: fleetResource,
      validate: describedBy(billingSchemas.none, noInput),
      handler: async (context) => {
        const listMeters = member(context, 'listMeters');
        const catalog = await catalogOf(context, options);
        // Archived meters exist: ensureMeters takes them for present, so they are not "missing" either.
        const present = new Set((await listMeters()).map((meter) => meter.key));
        return {
          catalog,
          missing: catalog.filter((meter) => !present.has(meter.key)).map((meter) => meter.key),
        };
      },
    }),
    syncMeters: defineMethod({
      action: 'compute:billing:manage',
      kind: 'mutation',
      transaction: 'manual',
      resource: fleetResource,
      validate: describedBy(billingSchemas.none, noInput),
      handler: async (context) => {
        const ensureMeters = member(context, 'ensureMeters');
        return ensureMeters(await catalogOf(context, options));
      },
    }),
    prices: defineMethod({
      action: 'compute:billing:read',
      kind: 'read',
      transaction: 'manual',
      resource: fleetResource,
      validate: describedBy(billingSchemas.prices, parsePricesQuery),
      handler: async (context, input) => {
        const listPrices = member(context, 'listPrices');
        return listPrices({
          ...(input.meter === undefined ? {} : { meter: input.meter }),
          ...(input.targetTenantId === undefined ? {} : { targetTenantId: input.targetTenantId }),
        });
      },
    }),
    setPrices: defineMethod({
      action: 'compute:billing:manage',
      kind: 'mutation',
      transaction: 'manual',
      resource: fleetResource,
      validate: describedBy(billingSchemas.setPrices, parseSetPrices),
      handler: async (context, input) => {
        const setPrice = member(context, 'setPrice');
        // Every meter is checked before the first price is applied: one typo applies nothing.
        const known = new Set((await catalogOf(context, options)).map((meter) => meter.key));
        for (const [index, price] of input.prices.entries())
          if (!known.has(price.meter))
            throw new ComputeError(
              'INVALID_INPUT',
              `prices[${index}].meter ${price.meter} is not a meter compute defines; billing.meters lists them`,
            );
        const result: SetPricesResult = { applied: [], failed: [] };
        for (const [index, price] of input.prices.entries()) {
          try {
            result.applied.push(
              await setPrice({
                meter: price.meter,
                ...(price.targetTenantId === undefined
                  ? {}
                  : { targetTenantId: price.targetTenantId }),
                effectiveFrom: price.effectiveFrom,
                spec: price.spec,
              }),
            );
          } catch (error) {
            result.failed.push({
              index,
              meter: price.meter,
              ...(price.targetTenantId === undefined
                ? {}
                : { targetTenantId: price.targetTenantId }),
              code: isComputeError(error) ? error.code : 'INTERNAL_ERROR',
              message: isComputeError(error) ? error.message : 'The price could not be set',
            });
          }
        }
        return result;
      },
    }),
  };
}
