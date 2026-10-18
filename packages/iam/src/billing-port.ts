// The billing members of the IamPort (platform compute billing): meters, prices, quotes and spend on the IAM root
// tenant. Embedded and remote ports differ only in how they reach better-iam's `billing` group, so both give this
// module the calls and it does the mapping once: micros <-> currency units, one quote per line, prices across meters,
// and a spend range over calendar periods.
//
// better-iam takes and shows prices in currency units (`unitAmount`); compute carries micros, so every amount is
// converted at this boundary and nowhere else.

import {
  ComputeError,
  type IamPort,
  type MeterSpec,
  type PriceSpecInput,
  type PriceView,
  type QuoteLine,
  type SpendQuery,
  type SpendRow,
} from '@better-compute/core';

const microsPerUnit = 1_000_000;

/** A price in better-iam's units (`PublicPriceSpec`). */
type UnitPriceSpec = {
  model: PriceSpecInput['model'];
  unitAmount?: number;
  tiers?: { upTo: number | null; unitAmount: number; flatAmount?: number }[];
  packageSize?: number;
  packageAmount?: number;
  includedQuantity?: number;
  minimumAmount?: number;
  maximumAmount?: number;
};

interface IamPriceView {
  meter: string;
  targetTenantId: string;
  effectiveFrom: string;
  price: UnitPriceSpec;
}

interface IamSpendReport {
  periodStart: number;
  periodEnd: number;
  rows: { key: string; costMicros: number; quantities: Record<string, number> }[];
}

/** The report groupings compute asks better-iam for. */
type SpendGroup = 'meter' | 'tenant' | `tag:${string}`;

/** The `billing` calls this module needs, each already authorized as compute's root service account. */
export interface BillingCalls {
  listMeters(input: {
    tenantId: string;
  }): Promise<{ key: string; pricing: string; archived?: boolean }[]>;
  createMeter(input: {
    tenantId: string;
    key: string;
    name: string;
    unit: string;
    pricing: MeterSpec['pricing'];
  }): Promise<unknown>;
  setPrice(input: {
    tenantId: string;
    meter: string;
    targetTenantId?: string;
    effectiveFrom: string;
    price: UnitPriceSpec;
  }): Promise<IamPriceView | null>;
  listPrices(input: { tenantId: string; meter: string }): Promise<{ entries: IamPriceView[] }>;
  quote(input: {
    tenantId: string;
    meter: string;
    quantity: number;
  }): Promise<{ amountMicros: number; unpriced?: true }>;
  spend(input: { tenantId: string; period: string; groupBy: SpendGroup }): Promise<IamSpendReport>;
}

/** The members `billingPort` adds to a port. */
export type BillingMembers = Required<
  Pick<IamPort, 'ensureMeters' | 'setPrice' | 'listPrices' | 'quote' | 'spend'>
>;

/** The most periods one `spend` call walks (a guard against a range typed in the wrong unit). */
export const spendPeriodLimit = 36;

const micros = (units: number): number => Math.round(units * microsPerUnit);
const units = (amountMicros: number): number => amountMicros / microsPerUnit;

/** A price in micros as better-iam's `setPrice` takes it. */
export function toUnitSpec(spec: PriceSpecInput): UnitPriceSpec {
  return {
    model: spec.model,
    ...(spec.unitAmountMicros === undefined ? {} : { unitAmount: units(spec.unitAmountMicros) }),
    ...(spec.tiers === undefined
      ? {}
      : {
          tiers: spec.tiers.map((tier) => ({
            upTo: tier.upTo,
            unitAmount: units(tier.unitAmountMicros),
            ...(tier.flatAmountMicros === undefined
              ? {}
              : { flatAmount: units(tier.flatAmountMicros) }),
          })),
        }),
    ...(spec.packageSize === undefined ? {} : { packageSize: spec.packageSize }),
    ...(spec.packageAmountMicros === undefined
      ? {}
      : { packageAmount: units(spec.packageAmountMicros) }),
    ...(spec.includedQuantity === undefined ? {} : { includedQuantity: spec.includedQuantity }),
    ...(spec.minimumAmountMicros === undefined
      ? {}
      : { minimumAmount: units(spec.minimumAmountMicros) }),
    ...(spec.maximumAmountMicros === undefined
      ? {}
      : { maximumAmount: units(spec.maximumAmountMicros) }),
  };
}

/** A price as better-iam shows it, in micros. */
export function fromUnitSpec(spec: UnitPriceSpec): PriceSpecInput {
  return {
    model: spec.model,
    ...(spec.unitAmount === undefined ? {} : { unitAmountMicros: micros(spec.unitAmount) }),
    ...(spec.tiers === undefined
      ? {}
      : {
          tiers: spec.tiers.map((tier) => ({
            upTo: tier.upTo,
            unitAmountMicros: micros(tier.unitAmount),
            ...(tier.flatAmount === undefined ? {} : { flatAmountMicros: micros(tier.flatAmount) }),
          })),
        }),
    ...(spec.packageSize === undefined ? {} : { packageSize: spec.packageSize }),
    ...(spec.packageAmount === undefined
      ? {}
      : { packageAmountMicros: micros(spec.packageAmount) }),
    ...(spec.includedQuantity === undefined ? {} : { includedQuantity: spec.includedQuantity }),
    ...(spec.minimumAmount === undefined
      ? {}
      : { minimumAmountMicros: micros(spec.minimumAmount) }),
    ...(spec.maximumAmount === undefined
      ? {}
      : { maximumAmountMicros: micros(spec.maximumAmount) }),
  };
}

function priceView(view: IamPriceView): PriceView {
  return {
    meter: view.meter,
    targetTenantId: view.targetTenantId,
    effectiveFrom: view.effectiveFrom,
    spec: fromUnitSpec(view.price),
  };
}

/** The raw better-iam error code, before any mapping to compute's codes. */
const iamCode = (error: unknown): string | undefined =>
  error instanceof Error ? (error as { code?: unknown }).code?.toString() : undefined;

const periodOf = (at: number): string => new Date(at).toISOString().slice(0, 7);
function shiftPeriod(period: string, by: number): string {
  const index = Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1 + by;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * The five billing members over `calls`, all on `rootTenantId`. `wrap` maps better-iam's errors the way the
 * port's other members do.
 */
export function billingPort(
  rootTenantId: string,
  calls: BillingCalls,
  wrap: <T>(work: () => Promise<T>) => Promise<T>,
): BillingMembers {
  const ensureMeters: BillingMembers['ensureMeters'] = (meters) =>
    wrap(async () => {
      const present = new Set(
        (await calls.listMeters({ tenantId: rootTenantId })).map((m) => m.key),
      );
      const created: string[] = [];
      const existing: string[] = [];
      const seen = new Set<string>();
      for (const meter of meters) {
        if (seen.has(meter.key)) continue;
        seen.add(meter.key);
        if (present.has(meter.key)) {
          existing.push(meter.key);
          continue;
        }
        try {
          await calls.createMeter({
            tenantId: rootTenantId,
            key: meter.key,
            name: meter.name,
            unit: meter.unit,
            pricing: meter.pricing,
          });
          created.push(meter.key);
        } catch (error) {
          // Another process defined it between the listing and the create.
          if (iamCode(error) !== 'CONFLICT') throw error;
          existing.push(meter.key);
        }
      }
      return { created, existing };
    });

  const setPrice: BillingMembers['setPrice'] = (input) =>
    wrap(async () => {
      const view = await calls.setPrice({
        tenantId: rootTenantId,
        meter: input.meter,
        ...(input.targetTenantId === undefined ? {} : { targetTenantId: input.targetTenantId }),
        effectiveFrom: input.effectiveFrom,
        price: toUnitSpec(input.spec),
      });
      if (!view)
        throw new ComputeError(
          'INTERNAL_ERROR',
          'better-iam removed the price instead of setting it',
        );
      return priceView(view);
    });

  const listPrices: BillingMembers['listPrices'] = (input) =>
    wrap(async () => {
      const keys =
        input.meter === undefined
          ? (await calls.listMeters({ tenantId: rootTenantId }))
              .filter((meter) => meter.pricing === 'rate-card')
              .map((meter) => meter.key)
          : [input.meter];
      const prices: PriceView[] = [];
      for (const meter of keys) {
        const { entries } = await calls.listPrices({ tenantId: rootTenantId, meter });
        for (const entry of entries)
          if (input.targetTenantId === undefined || entry.targetTenantId === input.targetTenantId)
            prices.push(priceView(entry));
      }
      return prices;
    });

  const quote: BillingMembers['quote'] = (input) =>
    wrap(async () => {
      for (const line of input.lines)
        if (!Number.isFinite(line.quantity) || line.quantity < 0)
          throw new ComputeError('INVALID_INPUT', 'quote quantities must be numbers of at least 0');
      // Lines are priced independently: a meter that cannot be priced (unknown to the tenant, archived, or
      // `reported`, whose cost rides on each event) is a null line, never a failed quote.
      const priceable = new Set(
        input.lines.length === 0
          ? []
          : (await calls.listMeters({ tenantId: input.tenantId }))
              .filter((meter) => meter.pricing === 'rate-card' && meter.archived !== true)
              .map((meter) => meter.key),
      );
      const lines: QuoteLine[] = [];
      // better-iam quotes one meter per call.
      for (const line of input.lines) {
        if (!priceable.has(line.meter)) {
          lines.push({ meter: line.meter, quantity: line.quantity, amountMicros: null });
          continue;
        }
        const answer = await calls.quote({
          tenantId: input.tenantId,
          meter: line.meter,
          quantity: line.quantity,
        });
        lines.push({
          meter: line.meter,
          quantity: line.quantity,
          amountMicros: answer.unpriced === true ? null : answer.amountMicros,
        });
      }
      return lines;
    });

  const spend: BillingMembers['spend'] = (query: SpendQuery) =>
    wrap(async () => {
      if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.to <= query.from)
        throw new ComputeError('INVALID_INPUT', 'spend needs a range with from before to');
      if (query.groupBy === 'tag' && !query.tag)
        throw new ComputeError('INVALID_INPUT', 'spend grouped by tag needs the tag');
      const groupBy: SpendGroup = query.groupBy === 'tag' ? `tag:${query.tag}` : query.groupBy;
      const read = (period: string) => calls.spend({ tenantId: query.tenantId, period, groupBy });

      // The period holding `from`. UTC gets close; the report's own bounds (the deployment's time zone) settle it.
      let period = periodOf(query.from);
      let report = await read(period);
      for (let step = 0; step < 2; step++) {
        if (query.from < report.periodStart) period = shiftPeriod(period, -1);
        else if (query.from >= report.periodEnd) period = shiftPeriod(period, 1);
        else break;
        report = await read(period);
      }

      const coveredFrom = report.periodStart;
      const merged = new Map<string, SpendRow>();
      for (let walked = 1; ; walked++) {
        for (const row of report.rows) {
          const quantity =
            groupBy === 'meter' && row.quantities[row.key] !== undefined
              ? row.quantities[row.key]!
              : Object.values(row.quantities).reduce((sum, value) => sum + value, 0);
          const into = merged.get(row.key);
          if (into) {
            into.amountMicros += row.costMicros;
            into.quantity += quantity;
          } else
            merged.set(row.key, {
              key: row.key,
              ...(groupBy === 'meter' ? { meter: row.key } : {}),
              ...(groupBy === 'tenant' ? { tenantId: row.key } : {}),
              amountMicros: row.costMicros,
              quantity,
            });
        }
        if (report.periodEnd >= query.to) break;
        if (walked >= spendPeriodLimit)
          throw new ComputeError(
            'INVALID_INPUT',
            `spend covers at most ${spendPeriodLimit} billing periods`,
          );
        period = shiftPeriod(period, 1);
        report = await read(period);
      }
      return { rows: [...merged.values()], coveredFrom, coveredTo: report.periodEnd };
    });

  return { ensureMeters, setPrice, listPrices, quote, spend };
}
