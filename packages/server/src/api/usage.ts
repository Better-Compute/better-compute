import { ComputeError, defineMethod, type MethodDefinition } from '@better-compute/core';
import { fields, limit, ms, page, type Page } from './common.js';
import { parser, v } from './input.js';

// `usage` (PLAN.md §9.2, §12.7, module server): the hourly usage windows compute hands to IAM
// billing, as the tenant can read them. Decided on `compute-tenant/{t}`, or `compute-project/{id}`
// when the call names a project (windows carry the project as a tag).

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
}

/** One hourly usage window (`usage_windows`). */
export interface UsageWindow {
  /** `cmp:<allocationId>:<windowStartMs>`: the billing idempotency key. */
  idempotencyKey: string;
  allocationId: string;
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
}

/** The most windows one export returns. */
export const maxExportWindows = 50_000;
const maxExportRangeMs = 93 * 86_400_000;

export type UsageApi = {
  usage: {
    list: MethodDefinition<ListUsageInput, Page<UsageWindow>>;
    export: MethodDefinition<ExportUsageInput, UsageExport>;
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
  allocation_id: string;
  tenant_id: string;
  identity_id: string | null;
  meter: string;
  quantity: unknown;
  window_start: Date;
  window_end: Date;
  tags: Record<string, string> | null;
  recorded_at: Date | null;
  outcome: UsageWindow['outcome'] | null;
}

function toWindow(row: WindowRow): UsageWindow {
  const window: UsageWindow = {
    idempotencyKey: row.idempotency_key,
    allocationId: row.allocation_id,
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
  return window;
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
        validate: listInput,
        async handler(context, input) {
          const size = input.limit ?? 100;
          const [afterStart, afterKey] =
            input.cursor === undefined ? [null, null] : decodeCursor(input.cursor);
          const { rows } = await context.sql.query<WindowRow>(
            `SELECT idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
               window_start, window_end, tags, recorded_at, outcome
             FROM usage_windows
             WHERE tenant_id = $1 AND ($2::text IS NULL OR tags->>'project' = $2)
               AND ($3::text IS NULL OR meter = $3)
               AND ($4::timestamptz IS NULL OR window_end > $4)
               AND ($5::timestamptz IS NULL OR window_start < $5)
               AND ($6::timestamptz IS NULL OR (window_start, idempotency_key) > ($6, $7::text))
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
        validate: exportInput,
        async handler(context, input) {
          const { rows } = await context.sql.query<WindowRow>(
            `SELECT idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
               window_start, window_end, tags, recorded_at, outcome
             FROM usage_windows
             WHERE tenant_id = $1 AND ($2::text IS NULL OR tags->>'project' = $2)
               AND ($3::text IS NULL OR meter = $3)
               AND window_end > $4 AND window_start < $5
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
          return { format, data, count: windows.length, totals, truncated };
        },
      }),
    },
  };
}
