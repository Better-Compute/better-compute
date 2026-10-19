import { createHash } from 'node:crypto';
import { ComputeError, type CallContext, type ProviderCostRecord } from '@better-compute/core';
import type { GoogleClient } from '@better-compute/gcp-common';
import { billingExportPattern, type GcpConfig } from './config.js';

// Provider costs (D10) from the Cloud Billing detailed (resource-level) BigQuery export. One
// parameterized standard-SQL query per window (`jobs.query`), its job polled with
// `jobs.getQueryResults` within an in-call budget, then paged by `pageToken`. The only text put in
// the SQL is the table id, which the account config validated against `billingExportPattern`;
// every value is a query parameter.

/** Where an account's billing export lives. */
export interface BillingExportTable {
  project: string;
  dataset: string;
  table: string;
  location?: string;
}

/** The account's export table, split from `project.dataset.table`; undefined when not configured. */
export function billingExportOf(config: GcpConfig): BillingExportTable | undefined {
  if (!config.billingExport) return undefined;
  // Checked again where it is used: the table id is the one text the query interpolates.
  if (!new RegExp(billingExportPattern, 'u').test(config.billingExport))
    throw new ComputeError(
      'INVALID_CONFIG',
      'billingExport must be "project.dataset.table"',
      undefined,
      {
        provider: 'gcp',
        reason: 'billingExport',
      },
    );
  if (
    config.billingExportLocation !== undefined &&
    !/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(config.billingExportLocation)
  )
    throw new ComputeError(
      'INVALID_CONFIG',
      'billingExportLocation must be a BigQuery location',
      undefined,
      {
        provider: 'gcp',
        reason: 'billingExportLocation',
      },
    );
  const parts = config.billingExport.split('.');
  const table = parts.pop()!;
  const dataset = parts.pop()!;
  return {
    project: parts.join('.'),
    dataset,
    table,
    ...(config.billingExportLocation ? { location: config.billingExportLocation } : {}),
  };
}

/** The query: the export's columns for rows whose usage started in `[@from, @to)`, every cost type. */
export function billingExportSql(table: BillingExportTable): string {
  return [
    'SELECT billing_account_id, service.description AS service, sku.id AS sku_id,',
    'sku.description AS sku_description, location.location AS location, location.region AS region,',
    'location.zone AS zone, price.tier_start_amount AS tier_start,',
    'project.id AS project_id, resource.name AS resource_name, usage_start_time, usage_end_time,',
    'usage.amount_in_pricing_units AS quantity, usage.pricing_unit AS pricing_unit, cost,',
    'currency, cost_type, labels, export_time, credits',
    `FROM \`${table.project}.${table.dataset}.${table.table}\``,
    'WHERE usage_start_time >= @from AND usage_start_time < @to',
  ].join(' ');
}

/** A TIMESTAMP query parameter value: `YYYY-MM-DD HH:MM:SS.fff+00:00`. */
function timestampParameter(name: string, ms: number) {
  const value = new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00:00');
  return { name, parameterType: { type: 'TIMESTAMP' }, parameterValue: { value } };
}

interface BqField {
  name: string;
  type: string;
  mode?: string;
  fields?: BqField[];
}
interface BqCell {
  v: unknown;
}
interface BqResponse {
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  jobComplete?: boolean;
  schema?: { fields?: BqField[] };
  rows?: { f: BqCell[] }[];
  pageToken?: string;
}

/** A TIMESTAMP cell in milliseconds: int64 micros (`useInt64Timestamp`) or float seconds. */
function timestampMs(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  // Float seconds always carry a point or an exponent; int64 micros never do.
  const ms = /^-?\d+$/.test(text) ? Number(text) / 1000 : Number(text) * 1000;
  return Number.isFinite(ms) ? Math.round(ms) : undefined;
}

/** One `f`/`v` cell decoded by its schema field (REPEATED and RECORD nest). */
function decode(field: BqField, value: unknown): unknown {
  if (field.mode === 'REPEATED')
    return Array.isArray(value)
      ? value.map((item) => decode({ ...field, mode: 'NULLABLE' }, (item as BqCell).v))
      : [];
  if (value === null || value === undefined) return undefined;
  switch (field.type) {
    case 'RECORD':
    case 'STRUCT': {
      const cells = (value as { f?: BqCell[] }).f ?? [];
      return Object.fromEntries(
        (field.fields ?? []).map((child, index) => [child.name, decode(child, cells[index]?.v)]),
      );
    }
    case 'TIMESTAMP':
      return timestampMs(value);
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'INTEGER':
    case 'INT64':
      return Number(value);
    case 'BOOLEAN':
    case 'BOOL':
      return value === true || value === 'true';
    default:
      return String(value);
  }
}

/** Currency units to integer micros, without float drift (0.1 → 100000, never 100000.00000001). */
function micros(amount: unknown): number {
  const value = typeof amount === 'number' ? amount : Number(amount);
  // `|| 0`: never -0 (a -0.0000001 rounds to -0).
  return Number.isFinite(value) ? Math.round(value * 1e6) || 0 : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The record for one decoded export row. */
export function costRecordOf(row: Record<string, unknown>): ProviderCostRecord {
  const usageStart = row.usage_start_time as number | undefined;
  const usageEnd = row.usage_end_time as number | undefined;
  if (usageStart === undefined || usageEnd === undefined)
    throw new ComputeError('PROVIDER_ERROR', 'A billing export row has no usage time', undefined, {
      provider: 'gcp',
      reason: 'malformedRow',
    });
  const costType = text(row.cost_type);
  const labels: Record<string, string> = {};
  for (const label of (row.labels as { key?: unknown; value?: unknown }[] | undefined) ?? [])
    if (typeof label.key === 'string') labels[label.key] = String(label.value ?? '');
  // The identity of an export row, from columns a re-export keeps (export_time and amounts are left out, so a
  // re-exported or corrected row keeps its id). Location, pricing unit, price tier and labels tell apart rows
  // that share a SKU, resource and hour (null resource names, tiered prices, zones); rows that still share it
  // are summed by the reader.
  const tier = row.tier_start;
  const identity = [
    text(row.billing_account_id) ?? '',
    text(row.sku_id) ?? '',
    text(row.project_id) ?? '',
    text(row.resource_name) ?? '',
    new Date(usageStart).toISOString(),
    new Date(usageEnd).toISOString(),
    costType ?? '',
    text(row.location) ?? '',
    text(row.zone) ?? '',
    text(row.pricing_unit) ?? '',
    typeof tier === 'number' && Number.isFinite(tier) ? String(tier) : '',
    createHash('sha256')
      .update(
        JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      )
      .digest('hex'),
  ];
  const credits = (row.credits as { amount?: unknown }[] | undefined) ?? [];
  // Credits are never positive; a positive "credit" is not one, and is not netted (0 + 0, not -0).
  const creditsMicros =
    Math.min(
      0,
      credits.reduce((sum, credit) => sum + micros(credit.amount), 0),
    ) || 0;
  const optional = {
    skuDescription: text(row.sku_description),
    region: text(row.region),
    zone: text(row.zone),
    project: text(row.project_id),
    resourceName: text(row.resource_name),
  };
  return {
    sourceRowId: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    service: text(row.service) ?? '',
    sku: text(row.sku_id) ?? '',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    usageStart,
    usageEnd,
    quantity: typeof row.quantity === 'number' && Number.isFinite(row.quantity) ? row.quantity : 0,
    unit: text(row.pricing_unit) ?? '',
    costMicros: micros(row.cost),
    creditsMicros,
    currency: text(row.currency) ?? '',
    labels: Object.freeze(labels),
    exportTime: (row.export_time as number | undefined) ?? usageEnd,
    ...(costType ? { costType } : {}),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface BillingExportReadOptions {
  /** `https://bigquery.<universe>`. */
  endpoint: string;
  /** How long the job may take to finish within this call (default 30000). */
  budgetMs?: number;
  /** The pause between reads of an unfinished job (default 1000). */
  pollMs?: number;
  /** Rows per page (default 5000). */
  pageRows?: number;
}

/**
 * Every export row whose usage started in `[window.from, window.to)`. A job that is not finished
 * within the budget is UNAVAILABLE (`jobTimeout`), so the caller's worker retries the window later.
 */
export async function* readBillingExport(
  client: GoogleClient,
  table: BillingExportTable,
  window: { from: number; to: number },
  context: Pick<CallContext, 'signal'>,
  options: BillingExportReadOptions,
): AsyncGenerator<ProviderCostRecord, void, undefined> {
  const { signal } = context;
  const budgetMs = options.budgetMs ?? 30_000;
  const pollMs = options.pollMs ?? 1000;
  const pageRows = options.pageRows ?? 5000;
  const base = `${options.endpoint.replace(/\/+$/, '')}/bigquery/v2/projects/${encodeURIComponent(table.project)}/queries`;
  const started = performance.now();
  const remaining = () => budgetMs - (performance.now() - started);
  // A server-side wait per request, bounded by what is left of the budget.
  const waitMs = () => String(Math.max(0, Math.min(10_000, Math.floor(remaining()))));

  let response = await client.request<BqResponse>({
    method: 'POST',
    url: base,
    body: {
      query: billingExportSql(table),
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: [
        timestampParameter('from', window.from),
        timestampParameter('to', window.to),
      ],
      ...(table.location ? { location: table.location } : {}),
      formatOptions: { useInt64Timestamp: true },
      maxResults: pageRows,
      timeoutMs: Number(waitMs()),
    },
    signal,
    what: 'BigQuery billing export query',
  });
  const jobId = response.jobReference?.jobId;
  const location = response.jobReference?.location ?? table.location;
  const results = (pageToken?: string) => {
    if (!jobId)
      throw new ComputeError('PROVIDER_ERROR', 'BigQuery answered without a job', undefined, {
        provider: 'gcp',
        reason: 'noJob',
      });
    return client.request<BqResponse>({
      method: 'GET',
      url: `${base}/${encodeURIComponent(jobId)}`,
      query: {
        ...(location ? { location } : {}),
        ...(pageToken ? { pageToken } : {}),
        maxResults: String(pageRows),
        timeoutMs: waitMs(),
        'formatOptions.useInt64Timestamp': 'true',
      },
      signal,
      what: 'BigQuery billing export results',
    });
  };

  while (response.jobComplete !== true) {
    if (remaining() <= 0)
      throw new ComputeError(
        'UNAVAILABLE',
        `The billing export query did not finish within ${budgetMs} ms`,
        undefined,
        { provider: 'gcp', status: 0, reason: 'jobTimeout', retryAfterMs: 60_000 },
      );
    await sleep(Math.min(pollMs, Math.max(0, remaining())), signal);
    response = await results();
  }

  // Rows that share an identity in one result are one row billed in parts: summed, so every read of the same
  // export yields the same record (never one part dropped, never a part counted twice).
  const records = new Map<string, ProviderCostRecord>();
  for (;;) {
    const fields = response.schema?.fields ?? [];
    for (const row of response.rows ?? []) {
      const decoded = Object.fromEntries(
        fields.map((field, index) => [field.name, decode(field, row.f[index]?.v)]),
      );
      const record = costRecordOf(decoded);
      const seen = records.get(record.sourceRowId);
      records.set(record.sourceRowId, seen ? sumRecords(seen, record) : record);
    }
    if (!response.pageToken) break;
    signal.throwIfAborted();
    response = await results(response.pageToken);
  }
  yield* records.values();
}

/** Two parts of one export row: amounts and usage summed, the latest export time kept. */
export function sumRecords(a: ProviderCostRecord, b: ProviderCostRecord): ProviderCostRecord {
  return {
    ...a,
    quantity: Math.round((a.quantity + b.quantity) * 1e9) / 1e9,
    costMicros: a.costMicros + b.costMicros || 0,
    creditsMicros: a.creditsMicros + b.creditsMicros || 0,
    exportTime: Math.max(a.exportTime, b.exportTime),
  };
}

/** A cost row, or a pass-through rule's probe (`service` empty, `sku`/`skuDescription` the pattern). */
type SkuRecord = Pick<ProviderCostRecord, 'service' | 'sku' | 'skuDescription'>;

/** Compute Engine as the billing export names it; an empty service is a probe and may be it. */
const computeEngine = (record: SkuRecord): boolean =>
  !record.service || record.service === 'Compute Engine';
const skuText = (record: SkuRecord): string => `${record.sku} ${record.skuDescription ?? ''}`;
/** D4's SKU families: vCPU cores, memory, GPUs and whole instances. */
const computeFamilies = /core|ram|gpu|instance/i;
/**
 * What D9 meters on provider instances: persistent disks (`Storage PD Capacity`, `SSD backed PD Capacity`,
 * Hyperdisk), local SSDs (`SSD backed Local Storage`, and its Spot variant) and external addresses.
 */
const meteredFamilies = /pd capacity|hyperdisk|local storage|local ssd|ip charge/i;

/**
 * How Compute Engine cost rows relate to compute's own meters (`ProviderDefinition.billing`): its compute SKUs
 * (D4: core, RAM, GPU, instance) and the other SKUs compute meters (D9: disks, external IPs). Neither is ever
 * passed through to a tenant; the compute SKUs are also the hours leak detection compares.
 */
export const gcpBilling = Object.freeze({
  computeSku: (record: SkuRecord): boolean =>
    computeEngine(record) && computeFamilies.test(skuText(record)),
  meteredSku: (record: SkuRecord): boolean =>
    computeEngine(record) && meteredFamilies.test(skuText(record)),
});
