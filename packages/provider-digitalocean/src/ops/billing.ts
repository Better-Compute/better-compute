import {
  ComputeError,
  type ProviderAccountBilling,
  type ProviderContext,
} from '@better-compute/core';
import { clientFor } from '../client/build.js';
import { readDeadline } from '../client/deadline.js';
import type { DoClient } from '../client/http.js';
import type { DoConfig, DoProviderOptions } from '../config.js';
import { decimalMicros } from './costs.js';

// The account's billing state (DigitalOcean P9): balance, invoices, the month to date and the newest billing history
// entries, for the account pages, the CLI and budget checks that include DigitalOcean spend. Read-only: GETs under
// `/customers/my` (scope `billing:read`), on the `sweep` budget. Amounts are micros of USD (DigitalOcean bills in
// USD); an amount that is not a decimal is left out, never read as zero.

export interface DoBalance {
  /** Balance owed for the month so far (`month_to_date_balance`). */
  monthToDateBalanceMicros?: number;
  /** Balance as of the last invoice (`account_balance`); negative is credit. */
  accountBalanceMicros?: number;
  /** Usage so far this month (`month_to_date_usage`). */
  monthToDateUsageMicros?: number;
  generatedAt?: number;
}

export interface DoInvoiceSummary {
  /** `YYYY-MM`. */
  period: string;
  amountMicros: number;
  uuid: string;
}

export interface DoBillingEntry {
  date: number;
  /** `Invoice`, `Payment`, `Credit`, … as DigitalOcean names it. */
  type: string;
  description: string;
  amountMicros: number;
  invoiceUuid?: string;
}

export interface DoBillingSummary {
  currency: 'USD';
  balance: DoBalance;
  /** The `invoice_preview`: the current month so far. */
  monthToDate?: { period: string; amountMicros: number; updatedAt?: number };
  /** Final invoices, as the list gives them. */
  invoices: DoInvoiceSummary[];
  /** The newest billing history entries, newest first (at most `historyLimit`). */
  history: DoBillingEntry[];
}

/** History entries kept in a summary. */
export const historyLimit = 50;
/** History entries read at most (the list is paged through until then). */
const historyReadLimit = 1000;
const summaryTimeoutMs = 30_000;

const time = (value: unknown): number | undefined => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** `GET /customers/my/balance`. */
export async function readBalance(client: DoClient, signal: AbortSignal): Promise<DoBalance> {
  const body = await client.request<Record<string, unknown>>('GET', '/customers/my/balance', {
    signal,
    budget: 'sweep',
  });
  return defined({
    monthToDateBalanceMicros: decimalMicros(body.month_to_date_balance),
    accountBalanceMicros: decimalMicros(body.account_balance),
    monthToDateUsageMicros: decimalMicros(body.month_to_date_usage),
    generatedAt: time(body.generated_at),
  });
}

/** The account's balance, invoices, month to date and newest billing history, read with its own token. */
export async function readBillingSummary(
  client: DoClient,
  signal: AbortSignal,
): Promise<DoBillingSummary> {
  const balance = await readBalance(client, signal);
  const head = await client.request<{ invoice_preview?: Record<string, unknown> }>(
    'GET',
    '/customers/my/invoices',
    { query: { per_page: '1' }, signal, budget: 'sweep' },
  );
  const invoices: DoInvoiceSummary[] = [];
  for await (const invoice of client.pages<Record<string, unknown>>(
    '/customers/my/invoices',
    'invoices',
    { signal, budget: 'sweep' },
  )) {
    const period = text(invoice.invoice_period);
    const uuid = text(invoice.invoice_uuid);
    const amountMicros = decimalMicros(invoice.amount);
    if (period && uuid && amountMicros !== undefined) invoices.push({ period, amountMicros, uuid });
  }
  const history: DoBillingEntry[] = [];
  let read = 0;
  for await (const entry of client.pages<Record<string, unknown>>(
    '/customers/my/billing_history',
    'billing_history',
    { signal, budget: 'sweep' },
  )) {
    const date = time(entry.date);
    const amountMicros = decimalMicros(entry.amount);
    if (date !== undefined && amountMicros !== undefined)
      history.push(
        defined({
          date,
          type: text(entry.type) ?? '',
          description: text(entry.description) ?? '',
          amountMicros,
          invoiceUuid: text(entry.invoice_uuid),
        }),
      );
    if (++read >= historyReadLimit) break;
  }
  history.sort((a, b) => b.date - a.date);
  const preview = head.invoice_preview;
  const previewPeriod = text(preview?.invoice_period);
  const previewAmount = decimalMicros(preview?.amount);
  return {
    currency: 'USD',
    balance,
    ...(previewPeriod && previewAmount !== undefined
      ? {
          monthToDate: defined({
            period: previewPeriod,
            amountMicros: previewAmount,
            updatedAt: time(preview?.updated_at),
          }),
        }
      : {}),
    invoices,
    history: history.slice(0, historyLimit),
  };
}

/**
 * The billing summary of an account, built the way the provider builds its client (the token resolves and is
 * budgeted exactly as for any other call). `ACCESS_DENIED` without `billing:read`.
 */
export async function billingSummary(
  config: DoConfig,
  context: ProviderContext & { signal?: AbortSignal },
  options: DoProviderOptions = {},
): Promise<DoBillingSummary> {
  const client = clientFor(config, context, options);
  const deadline = readDeadline(context, summaryTimeoutMs);
  try {
    return await readBillingSummary(client, deadline.signal);
  } catch (error) {
    // The read's own deadline; a caller that cancelled sees its abort as it is.
    if (deadline.timedOut())
      throw new ComputeError(
        'UNAVAILABLE',
        `Reading the DigitalOcean billing summary took longer than ${summaryTimeoutMs / 1000} seconds`,
        undefined,
        { provider: 'digitalocean', reason: 'timeout' },
      );
    throw error;
  } finally {
    deadline.done();
  }
}

/** A summary as `ProviderInput.billingSummary` answers it (`providerAccounts.billing`): invoices newest first. */
export function accountBilling(summary: DoBillingSummary): ProviderAccountBilling {
  const { balance } = summary;
  return {
    currency: summary.currency,
    ...(balance.monthToDateBalanceMicros !== undefined
      ? { monthToDateMicros: balance.monthToDateBalanceMicros }
      : {}),
    ...(balance.accountBalanceMicros !== undefined
      ? { balanceMicros: balance.accountBalanceMicros }
      : {}),
    ...(balance.monthToDateUsageMicros !== undefined
      ? { monthToDateUsageMicros: balance.monthToDateUsageMicros }
      : {}),
    ...(balance.generatedAt !== undefined ? { generatedAt: balance.generatedAt } : {}),
    invoices: summary.invoices
      .map((invoice) => ({
        id: invoice.uuid,
        period: invoice.period,
        amountMicros: invoice.amountMicros,
      }))
      .sort((a, b) => b.period.localeCompare(a.period)),
    history: summary.history.map((entry) => ({
      at: entry.date,
      type: entry.type,
      description: entry.description,
      amountMicros: entry.amountMicros,
    })),
  };
}
