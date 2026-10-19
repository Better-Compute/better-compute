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
  /** Also list voided windows, marked `voided: true` with `voidedAt`. Default: leave them out. */
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
  voided?: true;
  voidedAt?: number;
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

export const deadLetterReasons = [
  'meter-missing',
  'period-closed',
  'identity',
  'invalid',
  'other',
] as const;
export type DeadLetterReason = (typeof deadLetterReasons)[number];

export interface DeadLettersInput {
  reason?: DeadLetterReason;
  /** At most 500 (100 by default). */
  limit?: number;
  cursor?: string;
}

/** A usage event better-iam refused for good (`usage_dead_letters`), still waiting for an operator. */
export interface DeadLetter {
  idempotencyKey: string;
  tenantId: string;
  meter: string;
  quantity: number;
  /** When the usage window began (epoch ms). */
  windowStart: number;
  reason: DeadLetterReason;
  /** better-iam's error message. */
  error: string;
}

export interface RetryUsageInput {
  /** Exactly one of the two: these dead letters (1 to 1000)… */
  idempotencyKeys?: string[];
  /** …or every dead letter with this reason. */
  reason?: DeadLetterReason;
}

export interface RetryUsageResult {
  /** Windows whose outcome was cleared, so the next usage flush sends them again. */
  retried: number;
}

export interface VoidUsageInput {
  /** Pending windows to void (1 to 1000). */
  idempotencyKeys: string[];
  /** Why; recorded with the windows. */
  reason: string;
}

export interface VoidUsageResult {
  voided: number;
  /** Windows that were voided before: left as they are. */
  alreadyVoided: number;
}

/** The most windows one export returns. */
export const maxExportWindows = 50_000;
const maxExportRangeMs = 93 * 86_400_000;
const fleetResource = () => ({ type: 'fleet' as const, id: fleetResourceId });

export type UsageApi = {
  usage: {
    list: MethodDefinition<ListUsageInput, Page<UsageWindow>>;
    export: MethodDefinition<ExportUsageInput, UsageExport>;
    platform: MethodDefinition<PlatformUsageInput, PlatformUsage>;
    deadLetters: MethodDefinition<DeadLettersInput, Page<DeadLetter>>;
    retry: MethodDefinition<RetryUsageInput, RetryUsageResult>;
    void: MethodDefinition<VoidUsageInput, VoidUsageResult>;
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
/**
 * One CSV cell. RFC 4180: quote fields holding a comma, quote or line break; double inner quotes. A cell that a
 * spreadsheet would read as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a
 * leading `'`. This is the rule of `usageCsv` in console-kit (tests/usage-platform.test.ts pins the two together):
 * every CSV this module writes goes through it.
 */
export const csvField = (value: unknown): string => {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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
  if (voidedAt !== undefined) {
    // Root's free-text void reason is root's: a tenant sees that the window is void, and when.
    window.voided = true;
    window.voidedAt = voidedAt;
  }
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

/** How long a flush's claim on a window holds (core/0033, packages/iam/src/worker.ts): voiding waits for it. */
const claimTtl = "interval '10 minutes'";
const maxCorrectionKeys = 1000;
const keyList = v.list(fields.idempotencyKey, { min: 1, max: maxCorrectionKeys, unique: true });
const reasonOption = v.option(deadLetterReasons);

const parseDeadLetters = parser({
  reason: v.optional(reasonOption),
  limit: limit(500, 100),
  cursor: v.optional(v.string({ pattern: /^[A-Za-z0-9_-]{1,256}$/, max: 256 })),
});
function deadLettersInput(input: unknown): DeadLettersInput {
  const parsed = parseDeadLetters(input);
  if (parsed.cursor !== undefined) decodeKeyCursor(parsed.cursor);
  return parsed;
}
const parseRetry = parser({
  idempotencyKeys: v.optional(keyList),
  reason: v.optional(reasonOption),
});
function retryInput(input: unknown): RetryUsageInput {
  const parsed = parseRetry(input);
  if ((parsed.idempotencyKeys === undefined) === (parsed.reason === undefined))
    throw new ComputeError(
      'INVALID_INPUT',
      'Give idempotencyKeys or reason, not both and not neither',
    );
  return parsed;
}
const parseVoid = parser({
  idempotencyKeys: keyList,
  reason: v.string({ pattern: /^[^\u0000-\u001f\u007f]+$/, min: 1, max: 256 }),
});

/** Dead letters sort by key; the cursor is the last one's key. */
const encodeKeyCursor = (key: string) =>
  Buffer.from(JSON.stringify([key]), 'utf8').toString('base64url');
function decodeKeyCursor(cursor: string): string {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
  } catch {
    // Reported below.
  }
  throw new ComputeError('INVALID_INPUT', 'cursor: not a cursor this method returned');
}

/**
 * A dead letter's reason, from better-iam's error: `BILLING_PERIOD_CLOSED`; `NOT_FOUND` naming a meter, or an
 * identity or tenant; an input refusal; anything else (a key reused on another meter, an archived meter, …).
 */
const reasonSql = `CASE
  WHEN d.error_code = 'BILLING_PERIOD_CLOSED' THEN 'period-closed'
  WHEN d.error_code = 'NOT_FOUND' AND d.error_message ~* 'meter' THEN 'meter-missing'
  WHEN d.error_code = 'NOT_FOUND' AND d.error_message ~* '(identity|tenant)' THEN 'identity'
  WHEN d.error_code IN ('INVALID_INPUT', 'INVALID_TRANSITION') THEN 'invalid'
  ELSE 'other' END`;

interface DeadLetterEvent {
  meter?: unknown;
  quantity?: unknown;
  occurredAt?: unknown;
}
interface DeadLetterRow {
  idempotency_key: string;
  tenant_id: string;
  event: DeadLetterEvent | string | null;
  error_message: string;
  reason: DeadLetterReason;
}
function toDeadLetter(row: DeadLetterRow): DeadLetter {
  const event = (
    typeof row.event === 'string' ? JSON.parse(row.event) : (row.event ?? {})
  ) as DeadLetterEvent;
  return {
    idempotencyKey: row.idempotency_key,
    tenantId: row.tenant_id,
    meter: typeof event.meter === 'string' ? event.meter : '',
    quantity: Number(event.quantity ?? 0),
    windowStart: Number(event.occurredAt ?? 0),
    reason: row.reason,
    error: row.error_message,
  };
}

/** Up to five keys of a longer list, for a message. */
const some = (keys: readonly string[]) =>
  `${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ` and ${keys.length - 5} more` : ''}`;

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
               window_start, window_end, tags, recorded_at, outcome, voided_at
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
               window_start, window_end, tags, recorded_at, outcome, voided_at
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
      deadLetters: defineMethod<DeadLettersInput, Page<DeadLetter>>({
        action: 'compute:usage:read',
        kind: 'read',
        resource: fleetResource,
        validate: Object.assign(deadLettersInput, { jsonSchema: parseDeadLetters.jsonSchema }),
        async handler(context, input) {
          const size = input.limit ?? 100;
          const { rows } = await context.sql.query<DeadLetterRow>(
            `SELECT d.idempotency_key, d.tenant_id, d.event, d.error_message, ${reasonSql} AS reason
               FROM usage_dead_letters d
              WHERE d.resolved_at IS NULL AND ($1::text IS NULL OR ${reasonSql} = $1)
                AND ($2::text IS NULL OR d.idempotency_key > $2)
              ORDER BY d.idempotency_key LIMIT $3`,
            [
              input.reason ?? null,
              input.cursor === undefined ? null : decodeKeyCursor(input.cursor),
              size + 1,
            ],
          );
          return page(rows, size, toDeadLetter, (row) => encodeKeyCursor(row.idempotency_key));
        },
      }),
      retry: defineMethod<RetryUsageInput, RetryUsageResult>({
        action: 'compute:usage:manage',
        kind: 'mutation',
        resource: fleetResource,
        validate: Object.assign(retryInput, { jsonSchema: parseRetry.jsonSchema }),
        async handler(context, input) {
          const closed = (what: string) =>
            new ComputeError(
              'INVALID_STATE',
              `${what}: the billing period is closed, so retrying would only fail again. ` +
                'Add a root invoice item in Better IAM (billing.createInvoiceItem) for the amount instead.',
              undefined,
              { hint: 'issue a root invoice item in Better IAM' },
            );
          if (input.reason === 'period-closed') throw closed('Period-closed dead letters');
          if (input.idempotencyKeys !== undefined) {
            const { rows } = await context.sql.query<{
              idempotency_key: string;
              reason: DeadLetterReason;
            }>(
              `SELECT d.idempotency_key, ${reasonSql} AS reason FROM usage_dead_letters d
                WHERE d.resolved_at IS NULL AND d.idempotency_key = ANY($1::text[])`,
              [input.idempotencyKeys],
            );
            const known = new Map(rows.map((row) => [row.idempotency_key, row.reason]));
            const missing = input.idempotencyKeys.filter((key) => !known.has(key));
            if (missing.length > 0)
              throw new ComputeError('NOT_FOUND', `No open dead letter for ${some(missing)}`);
            const refused = input.idempotencyKeys.filter(
              (key) => known.get(key) === 'period-closed',
            );
            if (refused.length > 0) throw closed(some(refused));
            // Retention may have pruned the window of a letter that is still open.
            const { rows: windows } = await context.sql.query<{ idempotency_key: string }>(
              'SELECT idempotency_key FROM usage_windows WHERE idempotency_key = ANY($1::text[])',
              [input.idempotencyKeys],
            );
            const present = new Set(windows.map((row) => row.idempotency_key));
            const pruned = input.idempotencyKeys.filter((key) => !present.has(key));
            if (pruned.length > 0)
              throw new ComputeError(
                'NOT_FOUND',
                `${some(pruned)}: window pruned; record it in Better IAM by hand`,
              );
          }
          // The windows go back to pending; the letters stay open until a pass records them (attempts then
          // counts the next failure). A voided window stays voided.
          const { rows } = await context.sql.query<{ idempotency_key: string }>(
            `UPDATE usage_windows w SET recorded_at = NULL, outcome = NULL, claimed_at = NULL
               FROM usage_dead_letters d
              WHERE d.idempotency_key = w.idempotency_key AND d.resolved_at IS NULL
                AND w.outcome = 'dead-lettered' AND w.voided_at IS NULL
                AND ($1::text[] IS NULL OR d.idempotency_key = ANY($1::text[]))
                AND ($2::text IS NULL OR ${reasonSql} = $2)
              RETURNING w.idempotency_key`,
            [input.idempotencyKeys ?? null, input.reason ?? null],
          );
          return { retried: rows.length };
        },
      }),
      void: defineMethod<VoidUsageInput, VoidUsageResult>({
        action: 'compute:usage:manage',
        kind: 'mutation',
        resource: fleetResource,
        validate: Object.assign(parseVoid, { jsonSchema: parseVoid.jsonSchema }),
        async handler(context, input) {
          // One statement checks the state and writes the void, so a window the sink has handed to IAM billing
          // (or that a pass records or claims meanwhile) is never voided. Voidable: a window no flush has
          // touched, one whose claim is older than the claim TTL (its sender died), and a dead-lettered one
          // (IAM refused it; nothing was billed). The call is all or nothing: a refusal below rolls this
          // call's voids back.
          const { rows: done } = await context.sql.query<{ idempotency_key: string }>(
            `UPDATE usage_windows SET voided_at = compute_now(), void_reason = $2
              WHERE idempotency_key = ANY($1::text[]) AND voided_at IS NULL
                AND ((outcome IS NULL AND recorded_at IS NULL
                      AND (claimed_at IS NULL OR claimed_at < compute_now() - ${claimTtl}))
                     OR outcome = 'dead-lettered')
              RETURNING idempotency_key`,
            [input.idempotencyKeys, input.reason],
          );
          const voided = new Set(done.map((row) => row.idempotency_key));
          const rest = input.idempotencyKeys.filter((key) => !voided.has(key));
          let alreadyVoided = 0;
          if (rest.length > 0) {
            const { rows } = await context.sql.query<{
              idempotency_key: string;
              voided: boolean;
              sending: boolean;
            }>(
              `SELECT idempotency_key, voided_at IS NOT NULL AS voided,
                      (outcome IS NULL AND recorded_at IS NULL AND claimed_at >= compute_now() - ${claimTtl}) AS sending
                 FROM usage_windows WHERE idempotency_key = ANY($1::text[])`,
              [rest],
            );
            const found = new Map(rows.map((row) => [row.idempotency_key, row]));
            const missing = rest.filter((key) => !found.has(key));
            const sending = rest.filter((key) => found.get(key)?.sending === true);
            const recorded = rest.filter((key) => {
              const row = found.get(key);
              return row !== undefined && !row.voided && !row.sending;
            });
            // Only a window IAM billing recorded gets the credit-note hint.
            if (recorded.length > 0)
              throw new ComputeError(
                'INVALID_STATE',
                `${some(recorded)} already went to IAM billing and cannot be voided: issue a credit note in Better IAM`,
                undefined,
                { hint: 'issue a credit note in Better IAM' },
              );
            if (sending.length > 0)
              throw new ComputeError(
                'INVALID_STATE',
                `${some(sending)} is being sent; retry shortly`,
              );
            if (missing.length > 0)
              throw new ComputeError('NOT_FOUND', `No usage window ${some(missing)}`);
            alreadyVoided = rest.length;
          }
          // A voided window has nothing left to retry or record by hand: its open letters are resolved.
          await context.sql.query(
            `UPDATE usage_dead_letters SET resolved_at = compute_now()
              WHERE resolved_at IS NULL AND idempotency_key = ANY($1::text[])`,
            [input.idempotencyKeys],
          );
          return { voided: done.length, alreadyVoided };
        },
      }),
    },
  };
}
