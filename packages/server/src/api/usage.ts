import {
  ComputeError,
  defineMethod,
  fleetResourceId,
  type MethodDefinition,
} from '@better-compute/core';
import { fields, limit, ms, page, type Page } from './common.js';
import { parser, v } from './input.js';

// `usage` (PLAN.md §9.2, §12.7, module server): the hourly usage windows compute hands to IAM
// billing, as the tenant can read them. Decided on `compute-tenant/{t}`, or `compute-project/{id}`
// when the call names a project (windows carry the project as a tag). `platform` is root's cross-tenant view
// (D17), decided on `compute-fleet/global`. A voided window (D18) is not usage: the tenant views leave it out
// (`includeVoided` marks it) and the platform view counts it apart.

export interface ListUsageInput {
  tenantId: string;
  /** Only the project's windows; the decision is then on the project. */
  projectId?: string;
  /** `gpu.h100.hours`, `node.metal.hours`, … */
  meter?: string;
  /** Windows that end after this (epoch ms). */
  from?: number;
  /** Windows that start before this (epoch ms). */
  to?: number;
  /** At most 500 (100 by default). */
  limit?: number;
  cursor?: string;
  /** Also list voided windows, marked with `voidedAt` and `voidReason`. Default: leave them out. */
  includeVoided?: boolean;
}

/** One hourly usage window (`usage_windows`). */
export interface UsageWindow {
  /**
   * The billing idempotency key: `cmp:<allocationId>:<windowStartMs>` for an allocation, or
   * `cmp:<kind>:<sourceId>:<windowStartMs>:<meter>` for another source (a provider instance, a grant, …).
   */
  idempotencyKey: string;
  /** The allocation metered; absent for windows of other sources. */
  allocationId?: string;
  tenantId: string;
  /** Absent once the identity is gone (tenant-attributed). */
  identityId?: string;
  meter: string;
  quantity: number;
  windowStart: number;
  windowEnd: number;
  tags: Record<string, string>;
  /** When the usage sink handed it to IAM billing, and what came of it. */
  recordedAt?: number;
  outcome?: 'recorded' | 'duplicate' | 'reattributed' | 'dead-lettered';
  /** Present only on a voided window (`includeVoided`): compute will never send it to IAM billing. */
  voidedAt?: number;
  voidReason?: string;
}

export interface ExportUsageInput {
  tenantId: string;
  projectId?: string;
  meter?: string;
  /** Windows that end after this (epoch ms). */
  from: number;
  /** Windows that start before this (epoch ms); at most 93 days after `from`. */
  to: number;
  /** `csv` (default) or `jsonl`. */
  format?: 'csv' | 'jsonl';
}

/** A billing export (§12.7): every window of the range, and the quantity per meter. */
export interface UsageExport {
  format: 'csv' | 'jsonl';
  /** CSV with a header row, or one JSON window per line. */
  data: string;
  count: number;
  /** Sum of `quantity` per meter over the exported windows. */
  totals: Record<string, number>;
  /** More than `maxExportWindows` windows matched: narrow the range or the meter. */
  truncated: boolean;
  /** Voided windows of the range, left out of `data`, `count` and `totals`. */
  voided: number;
}

export type PlatformUsageKey = 'tenant' | 'pool' | 'meter' | 'source' | 'provider';
export const platformUsageKeys = ['tenant', 'pool', 'meter', 'source', 'provider'] as const;

export interface PlatformUsageInput {
  /** Windows that start at or after this (epoch ms). */
  from: number;
  /** Windows that start before this (epoch ms); at most 93 days after `from`. */
  to: number;
  /** The keys to total by (none: one row for everything). */
  groupBy: PlatformUsageKey[];
  /** Only this tenant's windows. */
  tenantId?: string;
  /** `json` (default) answers `rows`; `csv` answers `data` and no rows. */
  format?: 'json' | 'csv';
}

/** One group of the platform view. */
export interface PlatformUsageRow {
  /** The `groupBy` keys and their values; `''` where a window has no such tag (`pool`, `provider`). */
  keys: Record<string, string>;
  quantity: number;
  /** Windows in the group. */
  windows: number;
  /** Windows per outcome; `pending` is a window not handed to IAM billing yet. */
  outcomes: Record<string, number>;
}

export interface PlatformUsage {
  format: 'json' | 'csv';
  rows: PlatformUsageRow[];
  /** Groups answered (also for `csv`). */
  count: number;
  /** CSV with a header row (`csv` only): the keys, `quantity`, `windows`, and `outcomes` as JSON. */
  data?: string;
  /** Voided windows of the range, in no row. */
  voided: number;
  /** More than `maxPlatformRows` groups matched: group by fewer keys or narrow the range. */
  truncated: boolean;
}

/** The most groups one platform view returns. */
export const maxPlatformRows = 50_000;

/** The most windows one export returns. */
export const maxExportWindows = 50_000;
const maxExportRangeMs = 93 * 86_400_000;
const fleetResource = () => ({ type: 'fleet' as const, id: fleetResourceId });

export type UsageApi = {
  usage: {
    list: MethodDefinition<ListUsageInput, Page<UsageWindow>>;
    export: MethodDefinition<ExportUsageInput, UsageExport>;
    platform: MethodDefinition<PlatformUsageInput, PlatformUsage>;
  };
};

const parseExport = parser({
  tenantId: fields.tenantId,
  projectId: v.optional(fields.projectId),
  meter: v.optional(v.string({ pattern: /^[a-z][a-z0-9_.-]{0,127}$/, max: 128 })),
  from: v.int({ min: 0 }),
  to: v.int({ min: 0 }),
  format: v.optional(v.option(['csv', 'jsonl'])),
});
function exportInput(input: unknown): ExportUsageInput {
  const parsed = parseExport(input);
  if (parsed.from >= parsed.to) throw new ComputeError('INVALID_INPUT', 'to: must be after from');
  if (parsed.to - parsed.from > maxExportRangeMs)
    throw new ComputeError('INVALID_INPUT', 'to: at most 93 days after from');
  return parsed;
}

const csvColumns = [
  'idempotencyKey',
  'allocationId',
  'tenantId',
  'identityId',
  'meter',
  'quantity',
  'windowStart',
  'windowEnd',
  'tags',
  'recordedAt',
  'outcome',
] as const;
/** RFC 4180: quote fields holding a comma, quote or line break; double inner quotes. */
const csvField = (value: unknown): string => {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
function csvRow(window: UsageWindow): string {
  return csvColumns
    .map((column) => {
      const value = window[column];
      if (column === 'windowStart' || column === 'windowEnd' || column === 'recordedAt')
        return csvField(value === undefined ? undefined : new Date(value as number).toISOString());
      return csvField(value);
    })
    .join(',');
}

const parseList = parser({
  tenantId: fields.tenantId,
  projectId: v.optional(fields.projectId),
  meter: v.optional(v.string({ pattern: /^[a-z][a-z0-9_.-]{0,127}$/, max: 128 })),
  from: v.optional(v.int({ min: 0 })),
  to: v.optional(v.int({ min: 0 })),
  limit: limit(500, 100),
  cursor: v.optional(v.string({ pattern: /^[A-Za-z0-9_-]{1,256}$/, max: 256 })),
  includeVoided: v.optional(v.boolean()),
});
function listInput(input: unknown): ListUsageInput {
  const parsed = parseList(input);
  if (parsed.from !== undefined && parsed.to !== undefined && parsed.from >= parsed.to)
    throw new ComputeError('INVALID_INPUT', 'to: must be after from');
  if (parsed.cursor !== undefined) decodeCursor(parsed.cursor);
  return parsed;
}

/** Windows sort by (window_start, idempotency_key); the cursor is the last one's pair. */
const encodeCursor = (start: number, key: string) =>
  Buffer.from(JSON.stringify([start, key]), 'utf8').toString('base64url');
function decodeCursor(cursor: string): [number, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string'
    )
      return value as [number, string];
  } catch {
    // Reported below.
  }
  throw new ComputeError('INVALID_INPUT', 'cursor: not a cursor this method returned');
}

interface WindowRow {
  idempotency_key: string;
  allocation_id: string | null;
  tenant_id: string;
  identity_id: string | null;
  meter: string;
  quantity: unknown;
  window_start: Date;
  window_end: Date;
  tags: Record<string, string> | null;
  recorded_at: Date | null;
  outcome: UsageWindow['outcome'] | null;
  voided_at: Date | null;
  void_reason: string | null;
}

function toWindow(row: WindowRow): UsageWindow {
  const window: UsageWindow = {
    idempotencyKey: row.idempotency_key,
    // Allocation windows keep their field order (JSON Lines exports).
    ...(row.allocation_id === null ? {} : { allocationId: row.allocation_id }),
    tenantId: row.tenant_id,
    meter: row.meter,
    quantity: Number(row.quantity),
    windowStart: ms(row.window_start)!,
    windowEnd: ms(row.window_end)!,
    tags: { ...(row.tags ?? {}) },
  };
  if (row.identity_id !== null) window.identityId = row.identity_id;
  const recordedAt = ms(row.recorded_at);
  if (recordedAt !== undefined) window.recordedAt = recordedAt;
  if (row.outcome !== null) window.outcome = row.outcome;
  const voidedAt = ms(row.voided_at);
  if (voidedAt !== undefined) window.voidedAt = voidedAt;
  if (row.void_reason !== null) window.voidReason = row.void_reason;
  return window;
}

const parsePlatform = parser({
  from: v.int({ min: 0 }),
  to: v.int({ min: 0 }),
  groupBy: v.list(v.option(platformUsageKeys), { max: platformUsageKeys.length, unique: true }),
  tenantId: v.optional(fields.tenantId),
  format: v.optional(v.option(['json', 'csv'])),
});
function platformInput(input: unknown): PlatformUsageInput {
  const parsed = parsePlatform(input);
  if (parsed.from >= parsed.to) throw new ComputeError('INVALID_INPUT', 'to: must be after from');
  if (parsed.to - parsed.from > maxExportRangeMs)
    throw new ComputeError('INVALID_INPUT', 'to: at most 93 days after from');
  return parsed;
}

/** What each group key is in SQL; a window without the tag falls in `''`. */
const groupExpressions: Record<PlatformUsageKey, string> = {
  tenant: 'tenant_id',
  pool: "COALESCE(tags->>'pool', '')",
  meter: 'meter',
  source: 'source_kind',
  provider: "COALESCE(tags->>'provider', '')",
};

interface PlatformRow {
  quantity: unknown;
  windows: unknown;
  outcomes: Record<string, number> | string | null;
  [key: string]: unknown;
}

export function usageApi(): UsageApi {
  return {
    usage: {
      list: defineMethod<ListUsageInput, Page<UsageWindow>>({
        action: 'compute:usage:read',
        kind: 'read',
        resource: (input) =>
          input.projectId === undefined
            ? { type: 'tenant', id: input.tenantId }
            : { type: 'project', id: input.projectId },
        validate: Object.assign(listInput, { jsonSchema: parseList.jsonSchema }),
        async handler(context, input) {
          const size = input.limit ?? 100;
          const [afterStart, afterKey] =
            input.cursor === undefined ? [null, null] : decodeCursor(input.cursor);
          const { rows } = await context.sql.query<WindowRow>(
            `SELECT idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
               window_start, window_end, tags, recorded_at, outcome, voided_at, void_reason
             FROM usage_windows
             WHERE tenant_id = $1 AND ($2::text IS NULL OR tags->>'project' = $2)
               AND ($3::text IS NULL OR meter = $3)
               AND ($4::timestamptz IS NULL OR window_end > $4)
               AND ($5::timestamptz IS NULL OR window_start < $5)
               AND ($6::timestamptz IS NULL OR (window_start, idempotency_key) > ($6, $7::text))
               AND ($9::bool OR voided_at IS NULL)
             ORDER BY window_start, idempotency_key LIMIT $8`,
            [
              input.tenantId,
              input.projectId ?? null,
              input.meter ?? null,
              input.from === undefined ? null : new Date(input.from),
              input.to === undefined ? null : new Date(input.to),
              afterStart === null ? null : new Date(afterStart),
              afterKey,
              size + 1,
              input.includeVoided === true,
            ],
          );
          return page(rows, size, toWindow, (row) =>
            encodeCursor(ms(row.window_start)!, row.idempotency_key),
          );
        },
      }),
      export: defineMethod<ExportUsageInput, UsageExport>({
        action: 'compute:usage:read',
        kind: 'read',
        resource: (input) =>
          input.projectId === undefined
            ? { type: 'tenant', id: input.tenantId }
            : { type: 'project', id: input.projectId },
        validate: Object.assign(exportInput, { jsonSchema: parseExport.jsonSchema }),
        async handler(context, input) {
          const { rows } = await context.sql.query<WindowRow>(
            `SELECT idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
               window_start, window_end, tags, recorded_at, outcome, voided_at, void_reason
             FROM usage_windows
             WHERE tenant_id = $1 AND ($2::text IS NULL OR tags->>'project' = $2)
               AND ($3::text IS NULL OR meter = $3)
               AND window_end > $4 AND window_start < $5 AND voided_at IS NULL
             ORDER BY window_start, idempotency_key LIMIT $6`,
            [
              input.tenantId,
              input.projectId ?? null,
              input.meter ?? null,
              new Date(input.from),
              new Date(input.to),
              maxExportWindows + 1,
            ],
          );
          const { rows: voidedRows } = await context.sql.query<{ voided: number }>(
            `SELECT count(*)::int AS voided FROM usage_windows
             WHERE tenant_id = $1 AND ($2::text IS NULL OR tags->>'project' = $2)
               AND ($3::text IS NULL OR meter = $3)
               AND window_end > $4 AND window_start < $5 AND voided_at IS NOT NULL`,
            [
              input.tenantId,
              input.projectId ?? null,
              input.meter ?? null,
              new Date(input.from),
              new Date(input.to),
            ],
          );
          const truncated = rows.length > maxExportWindows;
          const windows = rows.slice(0, maxExportWindows).map(toWindow);
          const totals: Record<string, number> = {};
          for (const window of windows)
            totals[window.meter] = (totals[window.meter] ?? 0) + window.quantity;
          const format = input.format ?? 'csv';
          const data =
            format === 'csv'
              ? [csvColumns.join(','), ...windows.map(csvRow)].join('\r\n') + '\r\n'
              : windows.map((window) => `${JSON.stringify(window)}\n`).join('');
          return {
            format,
            data,
            count: windows.length,
            totals,
            truncated,
            voided: Number(voidedRows[0]?.voided ?? 0),
          };
        },
      }),
      platform: defineMethod<PlatformUsageInput, PlatformUsage>({
        action: 'compute:usage:read',
        kind: 'read',
        // Root's view: the fleet scope resolves only in the root tenant.
        resource: fleetResource,
        validate: Object.assign(platformInput, { jsonSchema: parsePlatform.jsonSchema }),
        async handler(context, input) {
          const format = input.format ?? 'json';
          const keys = input.groupBy;
          const columns = keys.map((_, index) => `k${index}`);
          const select = keys.map((key, index) => `${groupExpressions[key]} AS k${index}`);
          const range = [input.tenantId ?? null, new Date(input.from), new Date(input.to)];
          // Totals per group and outcome first, then the outcomes folded into their group. The window's start
          // (not its end) places it in the range, so adjacent ranges never count a window twice.
          const { rows } = await context.sql.query<PlatformRow>(
            `SELECT ${[...columns, ''].join(', ')}
                    sum(q) AS quantity, sum(n)::int AS windows, jsonb_object_agg(oc, n) AS outcomes
               FROM (SELECT ${[...select, ''].join(', ')}
                            COALESCE(outcome, 'pending') AS oc, sum(quantity) AS q, count(*)::int AS n
                       FROM usage_windows
                      WHERE ($1::text IS NULL OR tenant_id = $1)
                        AND window_start >= $2 AND window_start < $3 AND voided_at IS NULL
                      GROUP BY ${[...columns, 'oc'].join(', ')}) grouped
              ${columns.length === 0 ? '' : `GROUP BY ${columns.join(', ')} ORDER BY ${columns.join(', ')}`}
              LIMIT $4`,
            [...range, maxPlatformRows + 1],
          );
          const { rows: voidedRows } = await context.sql.query<{ voided: number }>(
            `SELECT count(*)::int AS voided FROM usage_windows
              WHERE ($1::text IS NULL OR tenant_id = $1)
                AND window_start >= $2 AND window_start < $3 AND voided_at IS NOT NULL`,
            range,
          );
          const truncated = rows.length > maxPlatformRows;
          // With no key the aggregate answers one row even over nothing.
          const found = rows.slice(0, maxPlatformRows).filter((row) => row.windows !== null);
          const groups: PlatformUsageRow[] = found.map((row) => {
            const outcomes =
              typeof row.outcomes === 'string' ? JSON.parse(row.outcomes) : (row.outcomes ?? {});
            return {
              keys: Object.fromEntries(keys.map((key, index) => [key, String(row[`k${index}`])])),
              quantity: Number(row.quantity),
              windows: Number(row.windows),
              // Sorted by name: the same input always gives the same CSV.
              outcomes: Object.fromEntries(
                Object.entries(outcomes as Record<string, number>).sort(([x], [y]) =>
                  x < y ? -1 : 1,
                ),
              ),
            };
          });
          const result: PlatformUsage = {
            format,
            rows: format === 'csv' ? [] : groups,
            count: groups.length,
            voided: Number(voidedRows[0]?.voided ?? 0),
            truncated,
          };
          if (format === 'csv') {
            const header = [...keys, 'quantity', 'windows', 'outcomes'].join(',');
            const lines = groups.map((group) =>
              [...keys.map((key) => group.keys[key]), group.quantity, group.windows, group.outcomes]
                .map((value) => csvField(typeof value === 'number' ? String(value) : value))
                .join(','),
            );
            result.data = [header, ...lines].join('\r\n') + '\r\n';
          }
          return result;
        },
      }),
    },
  };
}
