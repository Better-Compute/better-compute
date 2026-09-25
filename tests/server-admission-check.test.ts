import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  defineMethod,
  definePlugin,
  type MethodResource,
  type SqlExecutor,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute } from '@better-compute/server';
import { fakeIam, type FakeIam } from './support/fake-iam.js';
import { ACME, options } from './support/server.js';

// MethodAdmission.check (§12.7-12.8 budget checks): runs after the IAM decision allowed the
// request, with no transaction open, and a throw refuses it WITHOUT `denied`, so the same key
// decides again later; an unauthorized caller never reaches it.

const USER = 'token-admission-check-0123456789';
let database: SqlExecutor;
let iam: FakeIam;
let compute: ReturnType<typeof build>;
let overBudget = true;
const checks: { resource: MethodResource }[] = [];
let denials = 0;
const abandons: string[] = [];

interface OrderInput {
  tenantId: string;
  idempotencyKey: string;
}

const shop = definePlugin({
  id: 'shop',
  catalog: { actions: ['compute:shop:order'] },
  migrations: [
    { name: 'shop/0001_orders', sql: 'CREATE TABLE plg_shop_orders (key text PRIMARY KEY)' },
  ],
  api: () => ({
    orders: {
      create: defineMethod<OrderInput, { key: string }>({
        action: 'compute:shop:order',
        kind: 'mutation',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (raw) => raw as OrderInput,
        admission: {
          async prepare(_context, input, tx) {
            const { rows } = await tx.query('SELECT key FROM plg_shop_orders WHERE key = $1', [
              input.idempotencyKey,
            ]);
            if (rows[0]) return { status: 'replay', result: { key: input.idempotencyKey } };
            return { status: 'decide', resource: { type: 'tenant', id: input.tenantId } };
          },
          async denied() {
            denials++;
          },
          async abandoned(_context, input, tx, error) {
            abandons.push((error as ComputeError).code);
            await tx.query('INSERT INTO plg_shop_orders (key) VALUES ($1)', [`abandoned:${input.idempotencyKey}`]);
          },
          async check(_context, _input, resource) {
            checks.push({ resource });
            if (overBudget)
              throw new ComputeError('SPEND_LIMIT_REACHED', 'Budget exhausted', undefined, {
                budgetId: 'bdg_1',
              });
          },
        },
        async handler(context, input) {
          await context.sql.query('INSERT INTO plg_shop_orders (key) VALUES ($1)', [
            input.idempotencyKey,
          ]);
          if (input.idempotencyKey.startsWith('gone'))
            throw new ComputeError('INVALID_STATE', 'The order went away between the transactions');
          return { key: input.idempotencyKey };
        },
      }),
    },
  }),
});

function build() {
  return betterCompute({ ...options(database, iam), plugins: [shop] });
}

beforeAll(async () => {
  database = pglite();
  iam = fakeIam();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-shopper' });
  compute = build();
  await compute.initialize();
});
afterAll(async () => {
  await compute.stop();
  await database.close();
});

const order = (key: string) =>
  (compute.api.plugins as any).shop.orders.create(
    { token: USER },
    { tenantId: ACME, idempotencyKey: key },
  );

describe('MethodAdmission.check', () => {
  it('refuses without denied, then admits the same key once the check passes', async () => {
    iam.allow({ token: USER });
    await expect(order('o1')).rejects.toMatchObject({
      code: 'SPEND_LIMIT_REACHED',
      details: { budgetId: 'bdg_1' },
    });
    expect(denials).toBe(0);
    expect(checks).toEqual([{ resource: { type: 'tenant', id: ACME } }]);
    // The refusal undoes what prepare staged (`abandoned`), and the handler never ran.
    expect(abandons).toEqual(['SPEND_LIMIT_REACHED']);
    const { rows } = await database.query('SELECT key FROM plg_shop_orders');
    expect(rows).toEqual([{ key: 'abandoned:o1' }]);

    overBudget = false;
    expect(await order('o1')).toEqual({ key: 'o1' });
    // A replay needs no decision and no check.
    expect(await order('o1')).toEqual({ key: 'o1' });
    expect(checks).toHaveLength(2);
  });

  it('runs abandoned in its own transaction when an allowed handler throws', async () => {
    iam.allow({ token: USER });
    overBudget = false;
    await expect(order('gone-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(abandons.at(-1)).toBe('INVALID_STATE');
    // The handler's write rolled back with transaction 2; the cleanup committed on its own.
    const { rows } = await database.query<{ key: string }>(
      `SELECT key FROM plg_shop_orders WHERE key LIKE '%gone-1'`,
    );
    expect(rows.map((row) => row.key)).toEqual(['abandoned:gone-1']);
    expect(denials).toBe(0);
  });

  it('runs abandoned when IAM fails without deciding (not a refusal), never denied', async () => {
    iam.allow({ token: USER });
    const require = iam.require;
    iam.require = async () => {
      throw new ComputeError('INTERNAL_ERROR', 'IAM timed out');
    };
    try {
      await expect(order('iam-down')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    } finally {
      iam.require = require;
    }
    expect(abandons.at(-1)).toBe('INTERNAL_ERROR');
    expect(denials).toBe(0);
  });

  it('never runs for a caller IAM refuses', async () => {
    iam.deny({ token: USER });
    const before = checks.length;
    await expect(order('o2')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(checks).toHaveLength(before);
    expect(denials).toBe(1);
  });
});
