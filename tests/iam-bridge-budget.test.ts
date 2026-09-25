import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import {
  budgetAlertHandler,
  budgetAlertOf,
  drainIamInbox,
  sqlInbox,
  successorsMigration,
  type BudgetAlert,
  type IamInboxEvent,
} from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { pglite } from '@better-compute/postgres/pglite';

// billing:budget-alert (PLAN.md §12.7-12.8): compute applies the offerings' onBudgetExceeded when a budget is
// actually spent. The inbox event becomes a typed alert; the policy runs in the inbox transaction.

const event = (
  metadata: IamInboxEvent['metadata'],
  subjectId = 'billing/budgets/bud_1',
): IamInboxEvent => ({
  eventId: 'e1',
  tenantId: 'ten_a',
  sequence: 1,
  occurredAt: 0,
  action: 'billing:budget-alert',
  subjectId,
  metadata,
  reactions: ['budget'],
});

describe('budgetAlertOf', () => {
  it('reads actual and forecast alerts; only an actual one at 100 % is exceeded', () => {
    expect(
      budgetAlertOf(
        event({
          budgetId: 'bud_1',
          name: 'GPU monthly',
          kind: 'actual',
          threshold: 100,
          spentMicros: 21_000_000,
          amountMicros: 20_000_000,
          window: 1_700_000_000_000,
        }),
      ),
    ).toEqual({
      tenantId: 'ten_a',
      budgetId: 'bud_1',
      name: 'GPU monthly',
      kind: 'actual',
      threshold: 100,
      spentMicros: 21_000_000,
      amountMicros: 20_000_000,
      window: 1_700_000_000_000,
      exceeded: true,
    });
    expect(budgetAlertOf(event({ kind: 'actual', threshold: 80 }))).toMatchObject({
      budgetId: 'bud_1',
      exceeded: false,
    });
    expect(budgetAlertOf(event({ kind: 'forecast', threshold: 100 }))?.exceeded).toBe(false);
    expect(budgetAlertOf(event({ kind: 'nope', threshold: 100 }))).toBeUndefined();
    expect(budgetAlertOf(event({ kind: 'actual' }))).toBeUndefined();
    expect(budgetAlertOf(event({ kind: 'actual', threshold: 100 }, 'elsewhere'))).toBeUndefined();
    expect(budgetAlertOf({ ...event({}), action: 'agent:suspend' })).toBeUndefined();
  });
});

describe('budgetAlertHandler on better-iam', () => {
  let db: SqlExecutor;
  const open: EmbeddedTestIam[] = [];
  beforeAll(async () => {
    db = pglite();
    await db.migrate([successorsMigration]);
  });
  afterAll(async () => {
    await db.close();
  });
  afterEach(async () => {
    for (const item of open.splice(0)) await item.close();
  });

  it('applies the policy once a budget is spent, inside the inbox transaction', async () => {
    const t = await createEmbeddedTestIam({ inbox: 'memory' });
    open.push(t);
    const root = t.root.credential;
    await t.iam.api.billing.createMeter(root, {
      tenantId: t.root.tenantId,
      key: 'gpu.h100.hours',
      name: 'H100 hours',
      unit: 'hour',
    });
    await t.iam.api.billing.setPrice(root, {
      tenantId: t.root.tenantId,
      meter: 'gpu.h100.hours',
      price: { model: 'per-unit', unitAmount: 2 },
    });
    const budget = await t.iam.api.billing.createBudget(t.acme.owner, {
      tenantId: t.acme.tenantId,
      name: 'GPU monthly',
      amount: 20,
      thresholds: [50, 100],
      forecastAlerts: false,
    });
    const record = (quantity: number, key: string) =>
      t.iam.billing.record({
        tenantId: t.acme.tenantId,
        meter: 'gpu.h100.hours',
        quantity,
        idempotencyKey: key,
      } as never);

    const applied: BudgetAlert[] = [];
    let inTransaction = false;
    const handlers = {
      budget: budgetAlertHandler<unknown>(async (tx, alert) => {
        inTransaction = typeof (tx as { query?: unknown }).query === 'function';
        applied.push(alert);
      }),
    };
    const deliver = async () => {
      await t.iam.billing.checkBudgets();
      await t.dispatch();
      await sqlInbox(db).put(t.inbox!.events);
      t.inbox!.clear();
      return drainIamInbox(db, { handlers });
    };

    // $12 of $20: the 50 % alert fires; nothing is exceeded yet.
    await record(6, 'u1');
    expect((await deliver()).failures).toBe(0);
    expect(applied).toEqual([]);

    // $24: the 100 % alert fires and the policy runs, once.
    await record(6, 'u2');
    expect((await deliver()).failures).toBe(0);
    expect(applied).toEqual([
      expect.objectContaining({
        tenantId: t.acme.tenantId,
        budgetId: budget.budgetId,
        kind: 'actual',
        threshold: 100,
        exceeded: true,
      }),
    ]);
    expect(inTransaction).toBe(true);
    await deliver();
    expect(applied).toHaveLength(1);
  }, 60_000);
});
