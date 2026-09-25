import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  defineMethod,
  defineModule,
  definePlugin,
  draftId,
  field,
  manifest,
  type AdmissionContext,
  type MethodDefinition,
} from '@better-compute/core';
import { betterCompute } from '@better-compute/server';
import { bindConfirmation } from '../packages/server/src/confirmation-bindings.js';
import { fakeIam } from './support/fake-iam.js';
import { ACME, OTHER, ROOT, options } from './support/server.js';
import { ADMIN, OUTSIDER, USER, serverHarness, type Harness } from './support/server-api.js';

// Request-as-resource admission (PLAN.md §3.4 steps 3-8): the tenant pre-check, transaction 1
// (idempotency lookup, draft and projection rows), exactly one decision on the draft, transaction 2
// (the handler and its audit row), and the denial path.

const orderInput = manifest({
  tenantId: field.string({ pattern: '^[A-Za-z0-9._:-]{1,128}$' }),
  gpus: field.int({ min: 1, max: 64 }),
  idempotencyKey: field.string({ pattern: '^[A-Za-z0-9._:-]{1,128}$' }),
});
type OrderInput = { tenantId: string; gpus: number; idempotencyKey: string };
interface Order {
  id: string;
  gpus: number;
  state: string;
  admission?: AdmissionContext;
}

/** How the plugin's hooks were driven, in order. */
const trace: string[] = [];
let failDenied = false;

const drafts = definePlugin({
  id: 'drafts',
  catalog: { actions: ['compute:drafts:create'] },
  migrations: [
    {
      name: 'drafts/0001_orders',
      sql: `CREATE TABLE plg_drafts_orders (id text PRIMARY KEY, tenant_id text NOT NULL,
        owner text NOT NULL, gpus int NOT NULL, state text NOT NULL)`,
    },
  ],
  api: () => ({
    orders: {
      create: defineMethod<OrderInput, Order>({
        action: 'compute:drafts:create',
        kind: 'mutation',
        // The draft id derives from the caller, so the resource is known only in prepare.
        resource: () => undefined,
        validate: (input) => orderInput.parse(input),
        admission: {
          async prepare(context, input, tx) {
            trace.push('prepare');
            const owner = context.caller!.identityId;
            const id = await draftId('ord', input.tenantId, owner, input.idempotencyKey);
            const { rows } = await tx.query<{ gpus: number; state: string }>(
              'SELECT gpus, state FROM plg_drafts_orders WHERE id = $1 AND tenant_id = $2',
              [id, input.tenantId],
            );
            const existing = rows[0];
            if (existing && existing.gpus !== input.gpus)
              throw new ComputeError('CONFLICT', 'The key was used for another order');
            if (existing && existing.state !== 'draft')
              return {
                status: 'replay',
                result: { id, gpus: existing.gpus, state: existing.state },
              };
            if (!existing)
              await tx.query(
                `INSERT INTO plg_drafts_orders (id, tenant_id, owner, gpus, state)
                 VALUES ($1, $2, $3, $4, 'draft')`,
                [id, input.tenantId, owner, input.gpus],
              );
            await context.authz.upsert(tx, {
              type: 'reservation',
              id,
              tenantId: input.tenantId,
              attributes: { gpuCount: input.gpus, gpuModel: 'H100' },
              ownerId: owner,
            });
            return { status: 'decide', resource: { type: 'reservation', id } };
          },
          async denied(_context, input, tx, error) {
            trace.push(`denied ${(error as ComputeError).code}`);
            if (failDenied) throw new Error('cleanup failed');
            await tx.query(
              `UPDATE plg_drafts_orders SET state = 'denied'
               WHERE tenant_id = $1 AND state = 'draft' AND gpus = $2`,
              [input.tenantId, input.gpus],
            );
          },
        },
        async handler(context, input) {
          trace.push('handler');
          const owner = context.caller!.identityId;
          const id = await draftId('ord', input.tenantId, owner, input.idempotencyKey);
          await context.sql.query("UPDATE plg_drafts_orders SET state = 'placed' WHERE id = $1", [
            id,
          ]);
          return { id, gpus: input.gpus, state: 'placed', admission: context.admission! };
        },
      }),
      // An extend-like method: decided on an existing resource, described with its parameters.
      grow: defineMethod<GrowInput, { grown: number }>({
        action: 'compute:drafts:create',
        kind: 'mutation',
        resource: () => undefined,
        validate: (input) => growInput.parse(input),
        admission: {
          async prepare(_context, input) {
            trace.push('prepare grow');
            return { status: 'decide', resource: { type: 'reservation', id: input.orderId } };
          },
          describe: (input) => `orders.grow ${input.orderId} by ${input.by} GPUs`,
          async abandoned(_context, _input, _tx, error) {
            trace.push(`abandoned ${(error as ComputeError).code}`);
          },
        },
        async handler(_context, input) {
          trace.push('handler grow');
          return { grown: input.by };
        },
      }),
    },
  }),
});
const growInput = manifest({
  tenantId: field.string({ pattern: '^[A-Za-z0-9._:-]{1,128}$' }),
  orderId: field.string({ pattern: '^ord_[0-9a-z]{26,52}$' }),
  by: field.int({ min: 1, max: 64 }),
});
type GrowInput = { tenantId: string; orderId: string; by: number };

let h: Harness;
beforeAll(async () => {
  h = await serverHarness({ plugins: [drafts] });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.reset();
  trace.length = 0;
  failDenied = false;
});

const order = (gpus: number, idempotencyKey: string) => ({ tenantId: ACME, gpus, idempotencyKey });
const create = (token: string | undefined, input: unknown) =>
  h.call<Order>('plugins/drafts/orders/create', token, input);
const methods = () => h.iam.calls.map((call) => call.method);
/** A fresh caller in acme, so allow and deny rules (which the fake IAM keeps) stay per test. */
const caller = (name: string) => {
  const token = `token-${name}-0123456789`;
  h.iam.addCaller(token, { tenantId: ACME, identityId: `id-${name}`, sessionId: `ses-${name}` });
  return token;
};
const orderRow = async (id: string) =>
  (
    await h.store.query<{ state: string }>('SELECT state FROM plg_drafts_orders WHERE id = $1', [
      id,
    ])
  ).rows[0];

describe('request-as-resource admission', () => {
  it('decides exactly once, on the draft prepare wrote, with its attributes visible to the resolver', async () => {
    h.iam.allow({ token: USER, action: 'compute:drafts:create' });
    const seen: unknown[] = [];
    const require = h.iam.require;
    h.iam.require = async (credential, decision) => {
      // What an embedded resolver would load inside IAM's decision: the committed projection row.
      const { rows } = await h.store.query<{ attributes: unknown; owner_id: string }>(
        'SELECT attributes, owner_id FROM authz_projection WHERE type = $1 AND id = $2 AND tenant_id = $3',
        ['reservation', decision.resource.id, decision.tenantId],
      );
      seen.push(rows[0]);
      return require(credential, decision);
    };
    try {
      const placed = await create(USER, order(4, 'k-once'));
      const id = await draftId('ord', ACME, 'id-user', 'k-once');
      expect(placed).toMatchObject({ id, gpus: 4, state: 'placed' });
      expect(methods()).toEqual(['authenticate', 'require']);
      expect(h.iam.calls[1]!.decision).toEqual({
        tenantId: ACME,
        action: 'compute:drafts:create',
        resource: { type: 'compute-reservation', id },
      });
      expect(seen).toEqual([
        { attributes: { gpuCount: 4, gpuModel: 'H100' }, owner_id: 'id-user' },
      ]);
      expect(h.ports.authz.rows).toEqual([
        {
          type: 'reservation',
          id,
          tenantId: ACME,
          attributes: { gpuCount: 4, gpuModel: 'H100' },
          ownerId: 'id-user',
        },
      ]);
      expect(trace).toEqual(['prepare', 'handler']);
      // Two transactions: prepare, then the handler with its audit row; the decision between them.
      expect(h.database.log.filter((entry) => entry.startsWith('transaction'))).toHaveLength(2);
      expect(placed.admission).toMatchObject({
        tenantId: ACME,
        identityId: 'id-user',
        action: 'compute:drafts:create',
        resource: { type: 'compute-reservation', id },
      });
      const { rows } = await h.store.query<{ resource_id: string; admission: AdmissionContext }>(
        "SELECT resource_id, admission FROM audit_events WHERE action = 'compute:drafts:create'",
      );
      expect(rows).toEqual([{ resource_id: id, admission: placed.admission }]);
    } finally {
      h.iam.require = require;
    }
  });

  it('replays a finished request by its owner without a decision', async () => {
    h.iam.allow({ token: USER, action: 'compute:drafts:create' });
    const first = await create(USER, order(2, 'k-replay'));
    h.reset();
    const again = await create(USER, order(2, 'k-replay'));
    expect(again).toEqual({ id: first.id, gpus: 2, state: 'placed' });
    // No decision, no handler, no audit row.
    expect(methods()).toEqual(['authenticate']);
    expect(trace).toEqual(['prepare', 'handler', 'prepare']);
    const { rows } = await h.store.query(
      "SELECT 1 FROM audit_events WHERE action = 'compute:drafts:create' AND resource_id = $1",
      [first.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('answers CONFLICT, without a decision, for another request under the same key', async () => {
    h.iam.allow({ token: USER, action: 'compute:drafts:create' });
    await create(USER, order(2, 'k-conflict'));
    h.reset();
    const error = await h.failure('plugins/drafts/orders/create', USER, order(3, 'k-conflict'));
    expect(error.code).toBe('CONFLICT');
    expect(methods()).toEqual(['authenticate']);
  });

  it('gives the same key from another identity its own draft', async () => {
    h.iam.addCaller('token-acme-second-0123456789', { tenantId: ACME, identityId: 'id-second' });
    h.iam.allow({ action: 'compute:drafts:create' });
    const mine = await create(USER, order(1, 'k-shared'));
    const theirs = await create('token-acme-second-0123456789', order(5, 'k-shared'));
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.id).toBe(await draftId('ord', ACME, 'id-second', 'k-shared'));
  });

  it('runs denied in its own transaction, then rethrows the refusal', async () => {
    const denied = caller('denied');
    h.iam.allow({ token: denied });
    h.iam.deny({ token: denied, action: 'compute:drafts:create' });
    const error = await h.failure('plugins/drafts/orders/create', denied, order(9, 'k-denied'));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(methods()).toEqual(['authenticate', 'require']);
    expect(trace).toEqual(['prepare', 'denied ACCESS_DENIED']);
    const id = await draftId('ord', ACME, 'id-denied', 'k-denied');
    expect(await orderRow(id)).toEqual({ state: 'denied' });
    expect(h.database.log.filter((entry) => entry.startsWith('transaction'))).toHaveLength(2);
    const { rows } = await h.store.query(
      "SELECT 1 FROM audit_events WHERE action = 'compute:drafts:create' AND resource_id = $1",
      [id],
    );
    expect(rows).toEqual([]);
    // The denied request stays denied: the same key replays the refusal's record, undecided.
    h.reset();
    expect(await create(denied, order(9, 'k-denied'))).toMatchObject({ state: 'denied' });
    expect(methods()).toEqual(['authenticate']);
  });

  it('keeps the refusal when the denied hook fails', async () => {
    const denied = caller('hook');
    h.iam.allow({ token: denied });
    h.iam.deny({ token: denied, action: 'compute:drafts:create' });
    failDenied = true;
    const error = await h.failure('plugins/drafts/orders/create', denied, order(7, 'k-hook'));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(trace).toEqual(['prepare', 'denied ACCESS_DENIED']);
    expect(h.warnings).toEqual(['An admission denial hook failed']);
  });

  it('re-decides a draft under the same id when the decision never came', async () => {
    h.iam.allow({ token: USER, action: 'compute:drafts:create' });
    const require = h.iam.require;
    h.iam.require = async () => {
      throw new Error('IAM is unavailable');
    };
    try {
      await expect(create(USER, order(3, 'k-retry'))).rejects.toThrow('IAM is unavailable');
    } finally {
      h.iam.require = require;
    }
    const id = await draftId('ord', ACME, 'id-user', 'k-retry');
    expect(await orderRow(id)).toEqual({ state: 'draft' });
    expect(trace).toEqual(['prepare']);
    const placed = await create(USER, order(3, 'k-retry'));
    expect(placed).toMatchObject({ id, state: 'placed' });
    expect(
      h.iam.calls.filter((call) => call.method === 'require').at(-1)!.decision!.resource,
    ).toEqual({ type: 'compute-reservation', id });
  });

  it('refuses callers outside the tenant before prepare, with no database access', async () => {
    h.iam.allow();
    const error = await h.failure('plugins/drafts/orders/create', OUTSIDER, order(1, 'k-outside'));
    expect(error.code).toBe('ACCESS_DENIED');
    expect(methods()).toEqual(['authenticate']);
    expect(h.database.log).toEqual([]);
    expect(trace).toEqual([]);
  });

  it('lets root callers through to IAM, which decides in the named tenant', async () => {
    h.iam.allow({ token: ADMIN });
    const placed = await create(ADMIN, order(1, 'k-root'));
    expect(placed.admission).toMatchObject({ tenantId: ACME, identityId: 'id-admin' });
  });

  it('validates the input before authenticating', async () => {
    const error = await h.failure('plugins/drafts/orders/create', USER, { ...order(1, 'k'), x: 1 });
    expect(error.code).toBe('INVALID_INPUT');
    expect(h.iam.calls).toEqual([]);
  });
});

describe('delegated confirmation (§3.4 step 7)', () => {
  /** A caller in acme whose session is a delegation (an agent acting for a person). */
  const delegated = (name: string) => {
    const token = `token-${name}-0123456789`;
    h.iam.addCaller(token, {
      tenantId: ACME,
      identityId: `id-${name}`,
      sessionId: `ses-${name}`,
      sessionKind: 'delegated',
      agentId: `agent-${name}`,
      delegationId: `dlg-${name}`,
    });
    h.iam.allow({ token });
    h.iam.deny({ token, action: 'compute:drafts:create' });
    return token;
  };

  it('turns a held-back refusal into CONFIRMATION_REQUIRED and hands it to denied', async () => {
    const token = delegated('held');
    const asked: unknown[] = [];
    const original = h.iam.requestConfirmation;
    h.iam.requestConfirmation = async (credential, decision) => {
      asked.push(decision);
      await original(credential, decision);
      return { confirmationId: 'conf_1', expiresAt: Date.UTC(2026, 0, 1, 0, 15) };
    };
    try {
      const error = await h.failure('plugins/drafts/orders/create', token, order(2, 'k-held'));
      const id = await draftId('ord', ACME, 'id-held', 'k-held');
      expect(error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 403 });
      expect(error.details).toEqual({
        confirmationId: 'conf_1',
        expiresAt: Date.UTC(2026, 0, 1, 0, 15),
        action: 'compute:drafts:create',
        resource: { type: 'compute-reservation', id },
      });
      expect(asked).toEqual([
        {
          tenantId: ACME,
          action: 'compute:drafts:create',
          resource: { type: 'compute-reservation', id },
          reason: `orders.create: compute:drafts:create on compute-reservation/${id}`,
        },
      ]);
      expect(methods()).toEqual(['authenticate', 'require', 'requestConfirmation']);
      expect(trace).toEqual(['prepare', 'denied CONFIRMATION_REQUIRED']);
      // Review 14 M1: the confirmation is bound to the text the person reads.
      const { rows } = await h.store.query<{ delegation_id: string; resource_id: string }>(
        `SELECT delegation_id, resource_id FROM confirmation_bindings WHERE confirmation_id = 'conf_1'`,
      );
      expect(rows).toEqual([{ delegation_id: 'dlg-held', resource_id: id }]);
    } finally {
      h.iam.requestConfirmation = original;
    }
  });

  it('fails closed: not held back, or a failed request, stays ACCESS_DENIED', async () => {
    const token = delegated('plain');
    // The fake IAM answers 'not-held-back'.
    const plain = await h.failure('plugins/drafts/orders/create', token, order(3, 'k-plain'));
    expect(plain.code).toBe('ACCESS_DENIED');
    expect(trace).toEqual(['prepare', 'denied ACCESS_DENIED']);

    trace.length = 0;
    const original = h.iam.requestConfirmation;
    h.iam.requestConfirmation = async () => {
      throw new Error('IAM is unavailable');
    };
    try {
      const failed = await h.failure('plugins/drafts/orders/create', token, order(4, 'k-failed'));
      expect(failed.code).toBe('ACCESS_DENIED');
      expect(trace).toEqual(['prepare', 'denied ACCESS_DENIED']);
      expect(h.warnings).toContain(
        'Requesting a delegated confirmation failed; the request stays denied',
      );
    } finally {
      h.iam.requestConfirmation = original;
    }
  });

  it('admits under an open approval only the request it was given for (review 14 M1)', async () => {
    const token = `token-bound-0123456789`;
    h.iam.addCaller(token, {
      tenantId: ACME,
      identityId: 'id-bound',
      sessionId: 'ses-bound',
      sessionKind: 'delegated',
      agentId: 'agent-bound',
      delegationId: 'dlg-bound',
    });
    // IAM allows: the person approved "orders.grow <order> by 2 GPUs" a moment ago.
    h.iam.allow({ token });
    const orderId = 'ord_01k5w00000000000000000000b';
    await bindConfirmation(
      h.store,
      'conf_bound',
      {
        tenantId: ACME,
        delegationId: 'dlg-bound',
        action: 'compute:drafts:create',
        resource: { type: 'compute-reservation', id: orderId },
      },
      `orders.grow ${orderId} by 2 GPUs`,
      Date.UTC(2026, 0, 1, 1),
    );
    const grow = (by: number, as = token) =>
      h.call<{ grown: number }>('plugins/drafts/orders/grow', as, { tenantId: ACME, orderId, by });
    expect(await grow(2)).toEqual({ grown: 2 });
    // The same open approval for another request: refused, and what prepare staged is abandoned.
    trace.length = 0;
    const other = await h.failure('plugins/drafts/orders/grow', token, { tenantId: ACME, orderId, by: 30 });
    expect(other).toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'approval-mismatch' } });
    expect(trace).toEqual(['prepare grow', 'abandoned ACCESS_DENIED']);
    // Another delegation is not bound by it.
    const peer = 'token-bound-peer-0123456789';
    h.iam.addCaller(peer, {
      tenantId: ACME,
      identityId: 'id-bound',
      sessionId: 'ses-peer',
      sessionKind: 'delegated',
      agentId: 'agent-peer',
      delegationId: 'dlg-peer',
    });
    h.iam.allow({ token: peer });
    expect(await grow(30, peer)).toEqual({ grown: 30 });
  });

  it('never asks for a confirmation for other sessions', async () => {
    const token = caller('undelegated');
    h.iam.allow({ token });
    h.iam.deny({ token, action: 'compute:drafts:create' });
    await h.failure('plugins/drafts/orders/create', token, order(5, 'k-undelegated'));
    expect(h.iam.count('requestConfirmation')).toBe(0);
  });
});

describe('admission contracts', () => {
  const mutation = (admission: unknown, kind: 'read' | 'mutation' = 'mutation') =>
    ({
      action: 'compute:projects:manage',
      kind,
      resource: (input: { tenantId: string }) => ({ type: 'tenant', id: input.tenantId }),
      validate: (input: unknown) => input as { tenantId: string },
      handler: async () => ({}),
      admission,
    }) as unknown as MethodDefinition;
  const build = (definition: MethodDefinition) =>
    betterCompute({
      ...options({} as never, fakeIam()),
      database: { query() {}, transaction() {}, migrate() {} } as never,
      modules: [defineModule({ name: 'odd', api: () => ({ things: { make: definition } }) })],
    });

  it('takes an admission only on mutations, with a prepare function', () => {
    expect(() => build(mutation({ prepare: async () => ({}) }, 'read'))).toThrow(
      /only mutations take an admission/,
    );
    expect(() => build(mutation({}))).toThrow(/admission.prepare must be a function/);
    expect(() => build(mutation({ prepare: async () => ({}), denied: 1 }))).toThrow(
      /admission.denied must be a function/,
    );
  });

  it('refuses a plan that decides outside the method’s §9.2 resource', async () => {
    const wrong = defineModule({
      name: 'wrong',
      api: () => ({
        workflows: {
          // A §9.2 row no built-in registers (provision's): decided on compute-node/{id}.
          abort: defineMethod<{ tenantId: string; nodeId: string }, unknown>({
            action: 'compute:workflows:manage',
            kind: 'mutation',
            resource: (input) => ({ type: 'node', id: input.nodeId }),
            validate: (input) => input as { tenantId: string; nodeId: string },
            handler: async () => ({}),
            admission: {
              prepare: async () => ({ status: 'decide', resource: { type: 'pool', id: 'p' } }),
            },
          }),
        },
      }),
    });
    const iam = fakeIam();
    iam.addCaller(USER, { tenantId: ACME });
    iam.allow();
    const compute = betterCompute({ ...options(h.store, iam), modules: [wrong] });
    await expect(
      (compute.api as any).workflows.abort({ token: USER }, {
        tenantId: ACME,
        nodeId: 'node_x',
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(iam.count('require')).toBe(0);
  });
});

describe('projects.create through the admission envelope', () => {
  it('replays its own project without a second decision, and refuses a reused key', async () => {
    h.iam.allow({ token: USER, action: 'compute:projects:manage' });
    const input = { tenantId: ACME, name: 'ml-research', idempotencyKey: 'prj-1' };
    const created = await h.call('projects/create', USER, input);
    expect(methods()).toEqual(['authenticate', 'require']);
    h.iam.reset();
    expect(await h.call('projects/create', USER, input)).toEqual(created);
    expect(h.iam.count('require')).toBe(0);
    const reused = await h.failure('projects/create', USER, { ...input, name: 'other' });
    expect(reused).toMatchObject({ code: 'CONFLICT' });
    expect(h.iam.count('require')).toBe(0);
    // Another tenant's caller never reaches prepare.
    h.iam.reset();
    expect((await h.failure('projects/create', OUTSIDER, input)).code).toBe('ACCESS_DENIED');
    expect(h.iam.calls.map((call) => call.method)).toEqual(['authenticate']);
    void OTHER;
    void ROOT;
  });
});
