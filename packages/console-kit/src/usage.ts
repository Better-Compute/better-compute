import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';

// Usage and spend (PLAN.md §12.7, `usage.list`): the hourly windows compute hands to IAM billing,
// summed per meter, per day, per project and per identity for a range, with an optional price list
// for estimated spend (IAM billing holds the real prices and invoices) and a CSV of the windows.

/** One window as `usage.list` returns it. */
export interface UsageWindowInput {
  idempotencyKey: string;
  /** Absent for windows of other sources (provider instances, grants, …). */
  allocationId?: string;
  identityId?: string;
  meter: string;
  quantity: number;
  windowStart: number;
  windowEnd: number;
  tags: Record<string, string>;
  outcome?: 'recorded' | 'duplicate' | 'reattributed' | 'dead-lettered';
}

export interface UsageTotal {
  meter: string;
  quantity: number;
  /** quantity × price, when the price list has the meter. */
  cost?: number;
}

export interface UsageView {
  from: number;
  to: number;
  meters: UsageTotal[];
  /** One entry per local day in the range (empty days included), quantity per meter. */
  days: { day: string; start: number; byMeter: Record<string, number>; cost?: number }[];
  /** Per `tags.project` (`(none)` without one), largest first. */
  byProject: { project: string; quantity: number; cost?: number }[];
  byIdentity: { identityId: string; quantity: number; cost?: number }[];
  /** Estimated total when every meter used has a price. */
  cost?: number;
  /** Windows billing dead-lettered (a person must look). */
  deadLettered: number;
  windows: number;
  /** More windows exist than were loaded (the range was cut short). */
  truncated: boolean;
}

const pad = (value: number) => String(value).padStart(2, '0');
const dayKey = (ms: number) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const startOfDay = (ms: number) => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function usageView(
  windows: readonly UsageWindowInput[],
  options: {
    from: number;
    to: number;
    /** meter → price per unit (e.g. per GPU hour), for estimated spend. */
    prices?: Readonly<Record<string, number>>;
    truncated?: boolean;
  },
): UsageView {
  const prices = options.prices ?? {};
  const priced = (meter: string, quantity: number) =>
    prices[meter] !== undefined ? round(quantity * prices[meter]!) : undefined;
  const meters = new Map<string, number>();
  const days = new Map<string, Record<string, number>>();
  const projects = new Map<string, { quantity: number; cost: number; complete: boolean }>();
  const identities = new Map<string, { quantity: number; cost: number; complete: boolean }>();
  let deadLettered = 0;

  const add = (
    map: Map<string, { quantity: number; cost: number; complete: boolean }>,
    key: string,
    window: UsageWindowInput,
  ) => {
    const entry = map.get(key) ?? { quantity: 0, cost: 0, complete: true };
    entry.quantity += window.quantity;
    const cost = priced(window.meter, window.quantity);
    if (cost === undefined) entry.complete = false;
    else entry.cost += cost;
    map.set(key, entry);
  };

  for (const window of windows) {
    // Duplicates were already billed under another window; they are not usage twice.
    if (window.outcome === 'duplicate') continue;
    if (window.outcome === 'dead-lettered') deadLettered++;
    meters.set(window.meter, (meters.get(window.meter) ?? 0) + window.quantity);
    const day = dayKey(window.windowStart);
    const byMeter = days.get(day) ?? {};
    byMeter[window.meter] = (byMeter[window.meter] ?? 0) + window.quantity;
    days.set(day, byMeter);
    add(projects, window.tags.project ?? '(none)', window);
    add(identities, window.identityId ?? '(tenant)', window);
  }

  const totals: UsageTotal[] = [...meters]
    .map(([meter, quantity]) => {
      const cost = priced(meter, quantity);
      return { meter, quantity: round(quantity), ...(cost !== undefined ? { cost } : {}) };
    })
    .sort((a, b) => b.quantity - a.quantity || a.meter.localeCompare(b.meter));
  const allPriced = totals.every((total) => total.cost !== undefined);

  const series: UsageView['days'] = [];
  for (let start = startOfDay(options.from); start < options.to; ) {
    const day = dayKey(start);
    const byMeter = days.get(day) ?? {};
    const costs = Object.entries(byMeter).map(([meter, quantity]) => priced(meter, quantity));
    series.push({
      day,
      start,
      byMeter,
      ...(costs.every((cost) => cost !== undefined)
        ? { cost: round(costs.reduce((sum, cost) => sum + cost!, 0)) }
        : {}),
    });
    // Next local midnight (DST-safe: step past it, then snap back).
    start = startOfDay(start + 36 * 3_600_000);
  }

  const ranked = (map: Map<string, { quantity: number; cost: number; complete: boolean }>) =>
    [...map]
      .map(([key, entry]) => ({
        key,
        quantity: round(entry.quantity),
        ...(entry.complete ? { cost: round(entry.cost) } : {}),
      }))
      .sort((a, b) => b.quantity - a.quantity || a.key.localeCompare(b.key));

  return {
    from: options.from,
    to: options.to,
    meters: totals,
    days: series,
    byProject: ranked(projects).map(({ key, ...rest }) => ({ project: key, ...rest })),
    byIdentity: ranked(identities).map(({ key, ...rest }) => ({ identityId: key, ...rest })),
    ...(allPriced && totals.length
      ? { cost: round(totals.reduce((sum, total) => sum + total.cost!, 0)) }
      : {}),
    deadLettered,
    windows: windows.length,
    truncated: options.truncated ?? false,
  };
}

/** The windows as CSV (RFC 4180), one row per window, for spreadsheets and finance. */
export function usageCsv(windows: readonly UsageWindowInput[]): string {
  const cell = (value: unknown) => {
    const text = value === undefined ? '' : String(value);
    // Quote when needed, and defuse spreadsheet formulas.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = [
    'window_start',
    'window_end',
    'meter',
    'quantity',
    'project',
    'identity_id',
    'allocation_id',
    'outcome',
    'idempotency_key',
  ];
  const rows = windows.map((window) =>
    [
      new Date(window.windowStart).toISOString(),
      new Date(window.windowEnd).toISOString(),
      window.meter,
      window.quantity,
      window.tags.project,
      window.identityId,
      window.allocationId,
      window.outcome,
      window.idempotencyKey,
    ]
      .map(cell)
      .join(','),
  );
  return `${[header.join(','), ...rows].join('\r\n')}\r\n`;
}

/**
 * `usage.list` for a range (every page, up to `maxWindows`, default 20 000), with its view derived.
 * The raw windows are kept for `usageCsv`.
 */
export function createUsageView(
  api: ComputeRequester,
  options: {
    tenantId: string;
    from: number;
    to: number;
    projectId?: string;
    meter?: string;
    prices?: Readonly<Record<string, number>>;
    maxWindows?: number;
  },
): ValueResource<UsageView & { raw: UsageWindowInput[] }> {
  const max = options.maxWindows ?? 20_000;
  return createValueResource({
    load: async (signal) => {
      const raw: UsageWindowInput[] = [];
      let cursor: string | undefined;
      let truncated = false;
      do {
        const page = await api.$request<{ items: UsageWindowInput[]; cursor?: string }>(
          'usage/list',
          {
            tenantId: options.tenantId,
            from: options.from,
            to: options.to,
            limit: 500,
            ...(options.projectId ? { projectId: options.projectId } : {}),
            ...(options.meter ? { meter: options.meter } : {}),
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        );
        raw.push(...page.items);
        cursor = page.cursor;
        if (cursor && raw.length >= max) {
          truncated = true;
          break;
        }
      } while (cursor);
      return {
        ...usageView(raw, {
          from: options.from,
          to: options.to,
          ...(options.prices ? { prices: options.prices } : {}),
          truncated,
        }),
        raw,
      };
    },
  });
}
