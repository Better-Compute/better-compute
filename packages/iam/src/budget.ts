// `billing:budget-alert` (PLAN.md §12.7 budgets, §12.8): better-iam's budget check fires an alert per threshold a
// budget crosses (`actual`, e.g. 50/80/100 %) and a `forecast` one; compute applies the offering's
// `onBudgetExceeded` (`notify | stop-new | drain`) when a budget is actually exceeded. This module turns the inbox
// event into a typed alert and runs the host's policy in the inbox transaction, so the policy's writes commit with
// the event's processing (a failure retries with it, isolated by the drain's savepoint).

import type { IamInboxEvent } from './worker.js';

/** One budget alert, as better-iam records it (`billing-service.ts` checkBudgets). */
export interface BudgetAlert {
  /** The tenant the budget belongs to. */
  tenantId: string;
  budgetId: string;
  name?: string;
  /** `actual`: spend crossed `threshold` percent; `forecast`: projected to cross 100 % this window. */
  kind: 'actual' | 'forecast';
  threshold: number;
  spentMicros?: number;
  amountMicros?: number;
  /** The window the spend is counted in (epoch ms), when given. */
  window?: number;
  /** An `actual` alert at 100 % or more: the budget is spent. */
  exceeded: boolean;
}

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The alert an inbox event carries, or undefined for anything else (or a malformed one). */
export function budgetAlertOf(
  event: Pick<IamInboxEvent, 'tenantId' | 'action' | 'subjectId' | 'metadata'>,
): BudgetAlert | undefined {
  if (event.action !== 'billing:budget-alert') return undefined;
  const metadata = event.metadata ?? {};
  const fromSubject = /^billing\/budgets\/(.+)$/.exec(event.subjectId ?? '')?.[1];
  const budgetId = typeof metadata.budgetId === 'string' ? metadata.budgetId : fromSubject;
  const kind = metadata.kind;
  const threshold = number(metadata.threshold);
  if (!budgetId || (kind !== 'actual' && kind !== 'forecast') || threshold === undefined)
    return undefined;
  const alert: BudgetAlert = {
    tenantId: event.tenantId,
    budgetId,
    kind,
    threshold,
    exceeded: kind === 'actual' && threshold >= 100,
  };
  if (typeof metadata.name === 'string') alert.name = metadata.name;
  const spent = number(metadata.spentMicros);
  const amount = number(metadata.amountMicros);
  const window = number(metadata.window);
  if (spent !== undefined) alert.spentMicros = spent;
  if (amount !== undefined) alert.amountMicros = amount;
  if (window !== undefined) alert.window = window;
  return alert;
}

export interface BudgetAlertHandlerOptions {
  /** Also run `apply` for alerts below 100 % and forecasts (default: only exceeded budgets). */
  all?: boolean;
}

/**
 * A `budget` inbox handler: `bridge.setHandlers({ budget: budgetAlertHandler(apply) })`, where `apply` enforces the
 * offerings' `onBudgetExceeded` for the alert's tenant (capacity's budget policy). It runs in the inbox
 * transaction; re-reading current state there (level-triggered, §12.8) makes a replayed alert harmless.
 */
export function budgetAlertHandler<Tx = unknown>(
  apply: (tx: Tx, alert: BudgetAlert) => Promise<void>,
  options: BudgetAlertHandlerOptions = {},
): (tx: Tx, event: IamInboxEvent) => Promise<void> {
  return async (tx, event) => {
    const alert = budgetAlertOf(event);
    if (!alert || (!alert.exceeded && !options.all)) return;
    await apply(tx, alert);
  };
}
