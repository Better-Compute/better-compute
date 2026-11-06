import { createHash } from 'node:crypto';
import { ComputeError, type CallContext, type ProviderCostRecord } from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoDroplet } from '../compute/types.js';
import { labels, labelsFromTags } from '../ids.js';

// Provider costs (platform compute billing, D10) from DigitalOcean invoices (P9, D-ops-2). DigitalOcean has no
// resource-level usage export: an invoice item is one resource's charge for a month (`start_time`..`end_time`),
// and the `invoice_preview` holds the month to date. So:
// - The invoices whose month overlaps the window are read; a month that has a final invoice is read from it, never
//   also from the preview (the preview of a closed month is the next one).
// - An item is yielded when its usage overlaps the window, not only when it starts in it: a month aggregate starts
//   on the 1st, and the month-to-date amount must keep being corrected after the lookback has passed that day.
// - A row's id leaves out what grows through the month (amount, duration, end time), so a later read of the same
//   item corrects the stored row. The preview's `end_time` (the month's end) is clamped to the read: usage that has
//   not happened is never reported. `exportTime` is the invoice's `updated_at` (the read time when absent).
// - Items carry no tags: a Droplet item is labelled from this deployment's Droplet with that id, read once per pass
//   (the managed and the claimed ones). A Droplet already deleted, or not this deployment's, labels nothing, and its
//   cost stays with the account.
// Every request spends the `sweep` budget. Every shape here is the spec's (`billing`); item fields beyond it are
// ignored. An item without times or with an amount that is not a decimal fails the read (`malformedRow`).

/** An invoice of the list (`GET /customers/my/invoices`) or its `invoice_preview`. */
interface DoInvoice {
  invoice_uuid?: string;
  invoice_period?: string;
  updated_at?: string;
}

/** An invoice item (`GET /customers/my/invoices/{uuid}`). */
export interface DoInvoiceItem {
  product?: string;
  resource_id?: string;
  resource_uuid?: string;
  group_description?: string;
  description?: string;
  amount?: string;
  duration?: string;
  duration_unit?: string;
  start_time?: string;
  end_time?: string;
  project_name?: string;
  category?: string;
}

const periodPattern = /^(\d{4})-(\d{2})$/;
const decimalPattern = /^(-?)(\d+)(?:\.(\d+))?$/;

function malformed(message: string): ComputeError {
  return new ComputeError('PROVIDER_ERROR', message, undefined, {
    provider: 'digitalocean',
    reason: 'malformedRow',
  });
}

/** `"12.34"` as integer micros, without float drift; anything that is not a plain decimal is undefined. */
export function decimalMicros(text: unknown): number | undefined {
  if (typeof text === 'number') text = String(text);
  if (typeof text !== 'string') return undefined;
  const match = decimalPattern.exec(text.trim());
  if (!match) return undefined;
  const [, sign, whole, fraction = ''] = match;
  const digits = (fraction + '0000000').slice(0, 7);
  let micros = Number(whole) * 1_000_000 + Number(digits.slice(0, 6));
  if (Number(digits[6]) >= 5) micros += 1;
  if (!Number.isSafeInteger(micros)) return undefined;
  return sign === '-' ? -micros || 0 : micros;
}

/** The UTC month `[start, end)` of an invoice period (`2026-10`). */
function monthOf(period: string | undefined): { start: number; end: number } | undefined {
  const match = periodPattern.exec(period ?? '');
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return undefined;
  return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The cost type of an item: credits and negative amounts are adjustments, taxes are taxes, the rest regular. */
function costTypeOf(item: DoInvoiceItem, micros: number): string | undefined {
  const kind = `${item.category ?? ''} ${item.product ?? ''}`;
  if (/\btax(es)?\b/i.test(kind)) return 'tax';
  if (micros < 0 || /credit|discount|promo|adjust/i.test(kind)) return 'adjustment';
  return undefined;
}

/** Whether an item is a Droplet's own (its `resource_id` is a Droplet id). */
const dropletProduct = (product: string | undefined): boolean => /droplet/i.test(product ?? '');

/**
 * The record for one invoice item of the month `period`. `labelsOf` gives the labels of a Droplet id; `now` clamps
 * the end of usage still running; `exportTime` is the invoice's update time.
 */
export function costRecordOfItem(
  item: DoInvoiceItem,
  period: string,
  options: {
    now: number;
    exportTime: number;
    labelsOf?: (dropletId: string) => Record<string, string>;
  },
): ProviderCostRecord {
  const start = Date.parse(item.start_time ?? '');
  const end = Date.parse(item.end_time ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw malformed('A DigitalOcean invoice item has no usage time');
  const costMicros = decimalMicros(item.amount);
  if (costMicros === undefined)
    throw malformed('A DigitalOcean invoice item has an amount that is not a decimal');
  const quantity = Number(item.duration);
  const resource = text(item.resource_uuid) ?? text(item.resource_id);
  const identity = [
    period,
    item.product ?? '',
    item.resource_uuid ?? '',
    item.resource_id ?? '',
    item.group_description ?? '',
    item.description ?? '',
    item.category ?? '',
    item.project_name ?? '',
    new Date(start).toISOString(),
  ];
  const dropletId = text(item.resource_id);
  const tagged =
    dropletId !== undefined && dropletProduct(item.product)
      ? options.labelsOf?.(dropletId)
      : undefined;
  const costType = costTypeOf(item, costMicros);
  const optional = {
    skuDescription: text(item.description),
    project: text(item.project_name),
    resourceName: resource,
  };
  return {
    sourceRowId: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    service: text(item.product) ?? '',
    sku: text(item.product) ?? '',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    usageStart: start,
    usageEnd: Math.max(start, Math.min(end, options.now)),
    quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
    unit: (text(item.duration_unit) ?? '').toLowerCase(),
    costMicros,
    creditsMicros: 0,
    currency: 'USD',
    labels: Object.freeze({ ...(tagged ?? {}) }),
    exportTime: options.exportTime,
    ...(costType ? { costType } : {}),
  };
}

/** Two parts of one item: amounts and usage summed, the later end and export time kept. */
function sum(a: ProviderCostRecord, b: ProviderCostRecord): ProviderCostRecord {
  return {
    ...a,
    quantity: Math.round((a.quantity + b.quantity) * 1e9) / 1e9,
    costMicros: a.costMicros + b.costMicros || 0,
    usageEnd: Math.max(a.usageEnd, b.usageEnd),
    exportTime: Math.max(a.exportTime, b.exportTime),
  };
}

/** The cost-attribution labels of this deployment's Droplets (managed or claimed), by Droplet id. */
async function deploymentLabels(
  client: DoClient,
  deploymentTag: string,
  signal: AbortSignal,
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  // A tag_name list may omit GPU Droplets and can't be combined with type (research S2): the GPU list is
  // everyone's, so it is filtered by the deployment tag here.
  const queries: Record<string, string>[] = [{ tag_name: deploymentTag }, { type: 'gpus' }];
  for (const query of queries)
    for await (const droplet of client.pages<DoDroplet>('/droplets', 'droplets', {
      query,
      signal,
      budget: 'sweep',
    })) {
      const tags = droplet.tags ?? [];
      if (!tags.some((tag) => tag.toLowerCase() === deploymentTag)) continue;
      const decoded = labelsFromTags(tags);
      const picked: Record<string, string> = {};
      for (const key of [labels.instance, labels.tenant])
        if (decoded[key] !== undefined) picked[key] = decoded[key];
      out.set(String(droplet.id), picked);
    }
  return out;
}

/**
 * `costs` of the DigitalOcean provider: the invoice items of every month overlapping `window`, as cost records,
 * each identity once (items that share one are summed).
 */
export async function* readInvoiceCosts(
  client: DoClient,
  deploymentTag: string,
  window: { from: number; to: number },
  context: Pick<CallContext, 'signal' | 'clock'>,
): AsyncGenerator<ProviderCostRecord, void, undefined> {
  const { signal } = context;
  const now = context.clock.now();
  const overlaps = (start: number, end: number) => start < window.to && end > window.from;

  // The month-to-date preview comes with the list; the list itself pages through the final invoices.
  const head = await client.request<{ invoice_preview?: DoInvoice }>(
    'GET',
    '/customers/my/invoices',
    { query: { per_page: '1' }, signal, budget: 'sweep' },
  );
  const byPeriod = new Map<string, DoInvoice>();
  for await (const invoice of client.pages<DoInvoice>('/customers/my/invoices', 'invoices', {
    signal,
    budget: 'sweep',
  })) {
    const month = monthOf(invoice.invoice_period);
    if (!month || !text(invoice.invoice_uuid) || !overlaps(month.start, month.end)) continue;
    if (!byPeriod.has(invoice.invoice_period!)) byPeriod.set(invoice.invoice_period!, invoice);
  }
  const preview = head.invoice_preview;
  const previewMonth = monthOf(preview?.invoice_period);
  if (
    preview &&
    previewMonth &&
    text(preview.invoice_uuid) &&
    overlaps(previewMonth.start, previewMonth.end) &&
    !byPeriod.has(preview.invoice_period!)
  )
    byPeriod.set(preview.invoice_period!, preview);
  if (byPeriod.size === 0) return;

  let labelsById: Map<string, Record<string, string>> | undefined;
  const records = new Map<string, ProviderCostRecord>();
  for (const [period, invoice] of [...byPeriod].sort(([a], [b]) => a.localeCompare(b))) {
    const updated = Date.parse(invoice.updated_at ?? '');
    const exportTime = Number.isFinite(updated) ? updated : now;
    const items: DoInvoiceItem[] = [];
    for await (const item of client.pages<DoInvoiceItem>(
      `/customers/my/invoices/${encodeURIComponent(invoice.invoice_uuid!)}`,
      'invoice_items',
      { signal, budget: 'sweep' },
    ))
      items.push(item);
    if (labelsById === undefined && items.some((item) => dropletProduct(item.product)))
      labelsById = await deploymentLabels(client, deploymentTag, signal);
    for (const item of items) {
      const record = costRecordOfItem(item, period, {
        now,
        exportTime,
        labelsOf: (id) => labelsById?.get(id) ?? {},
      });
      if (!overlaps(record.usageStart, Math.max(record.usageEnd, record.usageStart + 1))) continue;
      const seen = records.get(record.sourceRowId);
      records.set(record.sourceRowId, seen ? sum(seen, record) : record);
    }
  }
  yield* records.values();
}

/** A cost row, or a pass-through rule's probe (`service` empty, `sku`/`skuDescription` the pattern). */
type SkuRecord = Pick<ProviderCostRecord, 'service' | 'sku' | 'skuDescription'>;

const textOf = (record: SkuRecord): string =>
  record.service ? record.service : `${record.sku} ${record.skuDescription ?? ''}`;
/** Droplets and GPU Droplets: what vps meters as compute. Backups and snapshots of a Droplet are not compute. */
const computeProduct = (value: string): boolean =>
  /\bdroplets?\b/i.test(value) && !/backup|snapshot/i.test(value);
/** Block storage volumes and reserved addresses: what vps meters besides compute. */
const meteredProduct = (value: string): boolean =>
  /\b(volumes?|block storage|reserved ip(v4|v6)?s?|floating ips?)\b/i.test(value);

/**
 * How DigitalOcean cost rows relate to compute's own meters (`ProviderDefinition.billing`): the product names the
 * invoice gives (`Droplets`, `GPU Droplets`; `Volumes`, `Reserved IPs`), or a rule's pattern when the service is
 * empty. Neither is ever passed through to a tenant.
 */
export const doBilling = Object.freeze({
  computeSku: (record: SkuRecord): boolean => computeProduct(textOf(record)),
  meteredSku: (record: SkuRecord): boolean => meteredProduct(textOf(record)),
});
