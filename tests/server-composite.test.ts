import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  defineMethod,
  defineModule,
  definePlugin,
  draftId,
  manualClock,
  type AdmissionContext,
  type Credential,
  type MethodContext,
  type MethodDefinition,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fakeIam, type FakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, OTHER, ROOT, SECRET, options } from './support/server.js';
import { countingExecutor, START, type CountingExecutor } from './support/server-api.js';

// Composite methods (PLAN.md §3.4, core `MethodContext.check/invoke`): a `transaction: 'manual'`
// mutation decides each sub-call for its own caller with no transaction open (`check`), then runs
// the checked calls in one transaction (`invoke`), each with its own audit row. A local plugin
// drives every path: a plain mutation, a replay-only admission, an admission with a `denied` hook,
// a read, a public method and the composite itself, whose body each test scripts.

const USER = 'token-composite-user-0123456789';
const ADMIN = 'token-composite-admin-0123456789';
const OUTSIDER = 'token-composite-outsider-0123456789';

type NoteInput = { tenantId: string; noteId: string; body: string };
type ItemInput = { tenantId: string; label: string; idempotencyKey: string };
type BundleInput = { tenantId: string; scenario: string };
interface Item {
  id: string;
  label: string;
  admission?: AdmissionContext;
}

/** How the plugin's hooks were driven, in order. */
const trace: string[] = [];
const hooks: {
  script?: (context: MethodContext, input: BundleInput) => Promise<unknown>;
  onNote?: (context: MethodContext) => Promise<void>;
  captured?: MethodContext;
  decisionsBeforePeek?: number;
} = {};

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
function parse<T>(raw: unknown, keys: readonly string[]): T {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ComputeError('INVALID_INPUT', 'input must be an object');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw new ComputeError('INVALID_INPUT', `${key} is not a known field`);
  for (const key of keys)
    if (typeof input[key] !== 'string' || !input[key])
      throw new ComputeError('INVALID_INPUT', `${key} must be a string`);
  if (!tenantPattern.test(input.tenantId as string))
    throw new ComputeError('INVALID_INPUT', 'tenantId is invalid');
  return input as T;
}

const tenant = (input: { tenantId: string }) => ({ type: 'tenant', id: input.tenantId });
const itemId = (context: MethodContext, input: ItemInput) =>
  draftId('itm', input.tenantId, context.caller!.identityId, input.idempotencyKey);

const kit = definePlugin({
  id: 'kit',
  catalog: {
    actions: [
      'compute:kit:write',
      'compute:kit:create',
      'compute:kit:read',
      'compute:kit:order',
      'compute:kit:compose',
    ],
  },
  migrations: [
    {
      name: 'kit/0001_notes',
      sql: `CREATE TABLE plg_kit_notes (seq bigserial PRIMARY KEY, tenant_id text NOT NULL,
        note_id text NOT NULL, body text NOT NULL)`,
    },
    {
      name: 'kit/0002_items',
      sql: `CREATE TABLE plg_kit_items (id text PRIMARY KEY, tenant_id text NOT NULL,
        owner text NOT NULL, label text NOT NULL)`,
    },
  ],
  api: () => ({
    notes: {
      // A plain mutation; body 'boom' writes, then fails.
      add: defineMethod<NoteInput, { noteId: string; admission?: AdmissionContext }>({
        action: 'compute:kit:write',
        kind: 'mutation',
        resource: tenant,
        validate: (raw) => parse<NoteInput>(raw, ['tenantId', 'noteId', 'body']),
        async handler(context, input) {
          await hooks.onNote?.(context);
          await context.sql.query(
            'INSERT INTO plg_kit_notes (tenant_id, note_id, body) VALUES ($1, $2, $3)',
            [input.tenantId, input.noteId, input.body],
          );
          if (input.body === 'boom') throw new ComputeError('CONFLICT', 'The note exploded');
          return {
            noteId: input.noteId,
            ...(context.admission ? { admission: context.admission } : {}),
          };
        },
      }),
      count: defineMethod<{ tenantId: string; noteId: string }, { count: number }>({
        action: 'compute:kit:read',
        kind: 'read',
        resource: tenant,
        validate: (raw) => parse(raw, ['tenantId', 'noteId']),
        async handler(context, input) {
          const { rows } = await context.sql.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM plg_kit_notes WHERE tenant_id = $1 AND note_id = $2',
            [input.tenantId, input.noteId],
          );
          return { count: Number(rows[0]!.count) };
        },
      }),
      // A read that declares `transaction: 'manual'` (it may call IAM): no wrapping transaction, read-only sql.
      peek: defineMethod<{ tenantId: string; noteId: string }, { writeCode: string }>({
        action: 'compute:kit:read',
        kind: 'read',
        transaction: 'manual',
        resource: tenant,
        validate: (raw) => parse(raw, ['tenantId', 'noteId']),
        async handler(context, input) {
          trace.push('peek handler');
          hooks.decisionsBeforePeek = iam.calls.filter((entry) => entry.method === 'authorize').length;
          const writeCode = await context.sql
            .query('INSERT INTO plg_kit_notes (tenant_id, note_id, body) VALUES ($1, $2, $3)', [
              input.tenantId,
              input.noteId,
              'peeked',
            ])
            .then(
              () => 'written',
              (error: unknown) => (error instanceof ComputeError ? error.code : 'READ_ONLY'),
            );
          return { writeCode };
        },
      }),
    },
    items: {
      // A replay-only admission (no denied hook), like sites/pools/providerAccounts create.
      create: defineMethod<ItemInput, Item>({
        action: 'compute:kit:create',
        kind: 'mutation',
        resource: tenant,
        validate: (raw) => parse<ItemInput>(raw, ['tenantId', 'label', 'idempotencyKey']),
        admission: {
          async prepare(context, input, tx) {
            trace.push('prepare');
            const id = await itemId(context, input);
            const { rows } = await tx.query<{ label: string }>(
              'SELECT label FROM plg_kit_items WHERE id = $1',
              [id],
            );
            if (rows[0]) {
              if (rows[0].label !== input.label)
                throw new ComputeError('CONFLICT', 'The key was used for another item');
              return { status: 'replay', result: { id, label: rows[0].label } };
            }
            return { status: 'decide', resource: tenant(input) };
          },
          // Records what it decided in the input, as vps's per-volume decisions do: the handler
          // must see it (invoke runs the input check ran on, not a fresh parse).
          async check(_context, input) {
            (input as ItemInput & { checked?: string }).checked = `checked ${input.label}`;
          },
        },
        async handler(context, input) {
          trace.push('handler');
          const id = await itemId(context, input);
          await context.sql.query(
            'INSERT INTO plg_kit_items (id, tenant_id, owner, label) VALUES ($1, $2, $3, $4)',
            [id, input.tenantId, context.caller!.identityId, input.label],
          );
          const checked = (input as ItemInput & { checked?: string }).checked;
          return { id, label: input.label, admission: context.admission!, ...(checked ? { checked } : {}) };
        },
      }),
    },
    orders: {
      // An admission that records refusals: not composable.
      create: defineMethod<ItemInput, Record<string, never>>({
        action: 'compute:kit:order',
        kind: 'mutation',
        resource: tenant,
        validate: (raw) => parse<ItemInput>(raw, ['tenantId', 'label', 'idempotencyKey']),
        admission: {
          async prepare(_context, input) {
            trace.push('order prepare');
            return { status: 'decide', resource: tenant(input) };
          },
          async denied() {
            trace.push('order denied');
          },
        },
        handler: async () => ({}),
      }),
    },
    info: {
      ping: defineMethod<Record<string, never>, { pong: true; caller: boolean }>({
        action: null,
        kind: 'public',
        resource: () => undefined,
        validate(raw) {
          if (typeof raw !== 'object' || raw === null || Object.keys(raw).length)
            throw new ComputeError('INVALID_INPUT', 'ping takes no input');
          return {};
        },
        handler: async (context) => ({ pong: true, caller: context.caller !== undefined }),
      }),
    },
    bundle: {
      apply: defineMethod<BundleInput, unknown>({
        action: 'compute:kit:compose',
        kind: 'mutation',
        transaction: 'manual',
        resource: tenant,
        validate: (raw) => parse<BundleInput>(raw, ['tenantId', 'scenario']),
        handler(context, input) {
          hooks.captured = context;
          return hooks.script!(context, input);
        },
      }),
    },
  }),
});

const NOTES = 'plugins/kit/notes/add';
const ITEMS = 'plugins/kit/items/create';

let store: ReturnType<typeof pglite>;
let database: CountingExecutor;
let iam: FakeIam;
let compute: BetterCompute<[], [typeof kit]>;
/** IAM methods called while a compute transaction was open: must stay empty. */
const insideTransaction: string[] = [];

beforeAll(async () => {
  store = pglite();
  database = countingExecutor(store);
  iam = fakeIam();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user', sessionId: 'ses-user' });
  iam.addCaller(ADMIN, { tenantId: ROOT, identityId: 'id-admin', sessionId: 'ses-admin' });
  iam.addCaller(OUTSIDER, { tenantId: OTHER, identityId: 'id-outsider' });
  for (const method of ['authenticate', 'require', 'authorize', 'authorizeMany'] as const) {
    const original = iam[method] as (...args: unknown[]) => Promise<unknown>;
    (iam as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      if (database.openTransactions() > 0) insideTransaction.push(method);
      return original(...args);
    };
  }
  compute = betterCompute({
    ...options(database, iam),
    clock: manualClock(START),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    plugins: [kit],
  });
  await compute.initialize();
  await useSimClock(store, START);
});
afterAll(async () => {
  await compute.stop();
  await store.close();
});
beforeEach(async () => {
  iam.reset();
  compute.caches.clear();
  trace.length = 0;
  insideTransaction.length = 0;
  delete hooks.script;
  delete hooks.onNote;
  delete hooks.captured;
  delete hooks.decisionsBeforePeek;
  for (const table of ['plg_kit_notes', 'plg_kit_items', 'audit_events'])
    await store.query(`DELETE FROM ${table}`);
});

type Api = Record<string, Record<string, (credential: Credential, input: unknown) => Promise<any>>>;
const call = (group: string, method: string, token: string, input: unknown) =>
  (compute.api.plugins.kit as unknown as Api)[group]![method]!({ token }, input);
/** Runs the composite with `script` as its body, as the holder of `token`. */
const compose = (
  token: string,
  script: (context: MethodContext) => Promise<unknown>,
  tenantId = ACME,
) => {
  hooks.script = (context) => script(context);
  return call('bundle', 'apply', token, { tenantId, scenario: 'test' });
};
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof ComputeError ? error.code : String(error)),
  );
const requires = () =>
  iam.calls
    .filter((call) => call.method === 'require')
    .map((call) => `${call.decision!.action} ${call.decision!.tenantId}`);
const audit = async () =>
  (
    await store.query<{
      action: string;
      resource: string;
      txid_text: string;
      admission: AdmissionContext;
    }>(
      `SELECT action, resource_type || '/' || resource_id AS resource, txid::text AS txid_text, admission
       FROM audit_events ORDER BY seq`,
    )
  ).rows;
const notes = async () =>
  (
    await store.query<{ note_id: string }>('SELECT note_id FROM plg_kit_notes ORDER BY seq')
  ).rows.map((row) => row.note_id);
const note = (noteId: string, body = 'hello', tenantId = ACME): NoteInput => ({
  tenantId,
  noteId,
  body,
});
const item = (label: string, idempotencyKey: string): ItemInput => ({
  tenantId: ACME,
  label,
  idempotencyKey,
});

describe('composite methods: check, then invoke', () => {
  it('decides each sub-call for the caller with no transaction open, then runs them in one', async () => {
    iam.allow({ token: USER });
    const result = (await compose(USER, async (context) => {
      await context.check!(NOTES, note('n1'));
      await context.check!(ITEMS, item('gpu', 'k-1'));
      return context.sql.transaction(async (tx) => ({
        // Key order does not matter: the grant is keyed by canonical JSON.
        note: await context.invoke!(tx, NOTES, { body: 'hello', noteId: 'n1', tenantId: ACME }),
        item: await context.invoke!(tx, ITEMS, item('gpu', 'k-1')),
      }));
    })) as { note: { admission: AdmissionContext }; item: Item };

    // One decision for the composite, one per sub-call, all as the caller, none inside a transaction.
    expect(requires()).toEqual([
      `compute:kit:compose ${ACME}`,
      `compute:kit:write ${ACME}`,
      `compute:kit:create ${ACME}`,
    ]);
    expect(insideTransaction).toEqual([]);
    // The replay-only admission prepared once per phase; the handler ran once.
    expect(trace).toEqual(['prepare', 'prepare', 'handler']);

    const id = await draftId('itm', ACME, 'id-user', 'k-1');
    expect(result.item).toMatchObject({ id, label: 'gpu', checked: 'checked gpu' });
    for (const admission of [result.note.admission, result.item.admission])
      expect(admission).toMatchObject({
        tenantId: ACME,
        identityId: 'id-user',
        sessionId: 'ses-user',
        resource: { type: 'compute-tenant', id: ACME },
      });
    expect(result.note.admission.action).toBe('compute:kit:write');
    expect(result.item.admission.action).toBe('compute:kit:create');
    expect(await notes()).toEqual(['n1']);

    // Each sub-call has its audit row in the composite's transaction; the composite's own follows.
    const rows = await audit();
    expect(rows.map((row) => row.action)).toEqual([
      'compute:kit:write',
      'compute:kit:create',
      'compute:kit:compose',
    ]);
    expect(rows[0]!.admission).toEqual(result.note.admission);
    expect(rows[1]!.admission).toEqual(result.item.admission);
    expect(rows[2]!.admission).toMatchObject({
      identityId: 'id-user',
      action: 'compute:kit:compose',
    });
    expect(new Set(rows.map((row) => row.admission.requestId)).size).toBe(1);
    const txids = rows.map((row) => row.txid_text);
    expect(txids[0]).toBe(txids[1]);
    expect(txids[2]).not.toBe(txids[0]);
  });

  it('keeps grants as a multiset: one invoke per check, only for the checked input', async () => {
    iam.allow({ token: USER });
    const outcomes = await compose(USER, async (context) => {
      await context.check!(NOTES, note('twice'));
      await context.check!(NOTES, note('twice'));
      return context.sql.transaction(async (tx) => {
        const codes: string[] = [];
        for (const input of [note('other'), note('twice'), note('twice'), note('twice')])
          codes.push(await codeOf(context.invoke!(tx, NOTES, input)));
        // Same input, another path: not granted either.
        codes.push(await codeOf(context.invoke!(tx, 'plugins/kit/notes/count', note('twice'))));
        return codes;
      });
    });
    expect(outcomes).toEqual(['ACCESS_DENIED', 'ok', 'ok', 'ACCESS_DENIED', 'ACCESS_DENIED']);
    expect(await notes()).toEqual(['twice', 'twice']);
    expect((await audit()).map((row) => row.action)).toEqual([
      'compute:kit:write',
      'compute:kit:write',
      'compute:kit:compose',
    ]);
    expect(insideTransaction).toEqual([]);
  });

  it('refuses what it cannot decide: unknown paths, composites, denied-hook admissions, open transactions', async () => {
    iam.allow({ token: USER });
    const codes = await compose(USER, async (context) => ({
      unknown: await codeOf(context.check!('plugins/kit/nothing/here', {})),
      composite: await codeOf(
        context.check!('plugins/kit/bundle/apply', { tenantId: ACME, scenario: 'x' }),
      ),
      denied: await codeOf(context.check!('plugins/kit/orders/create', item('o', 'k-o'))),
      invalid: await codeOf(context.check!(NOTES, { tenantId: ACME, noteId: 'n' })),
      notJson: await codeOf(context.check!(NOTES, { ...note('n'), big: 1n })),
      outsider: await codeOf(context.check!(NOTES, note('n', 'hello', OTHER))),
      insideTransaction: await context.sql.transaction(() =>
        codeOf(context.check!(NOTES, note('n'))),
      ),
      unchecked: await context.sql.transaction((tx) =>
        codeOf(context.invoke!(tx, NOTES, note('n'))),
      ),
      noTransaction: await codeOf(
        context.invoke!({ query: () => Promise.reject(new Error('unused')) }, NOTES, note('n')),
      ),
    }));
    expect(codes).toEqual({
      unknown: 'NOT_FOUND',
      composite: 'UNSUPPORTED',
      denied: 'UNSUPPORTED',
      invalid: 'INVALID_INPUT',
      notJson: 'INVALID_INPUT',
      outsider: 'ACCESS_DENIED',
      insideTransaction: 'INVALID_STATE',
      unchecked: 'ACCESS_DENIED',
      noTransaction: 'INVALID_STATE',
    });
    // Only the composite's own decision: every refusal came before IAM, and nothing was prepared.
    expect(requires()).toEqual([`compute:kit:compose ${ACME}`]);
    expect(trace).toEqual([]);
    expect(await notes()).toEqual([]);
  });

  it('surfaces a sub-call refused by IAM from check, before anything runs', async () => {
    // A caller of its own: the fake IAM keeps deny rules.
    const refused = 'token-composite-refused-0123456789';
    iam.addCaller(refused, { tenantId: ACME, identityId: 'id-refused' });
    iam.allow({ token: refused });
    iam.deny({ token: refused, action: 'compute:kit:create' });
    const error = await codeOf(
      compose(refused, async (context) => {
        await context.check!(NOTES, note('n1'));
        await context.check!(ITEMS, item('refused', 'k-refused'));
        return context.sql.transaction((tx) => context.invoke!(tx, NOTES, note('n1')));
      }),
    );
    expect(error).toBe('ACCESS_DENIED');
    expect(requires()).toEqual([
      `compute:kit:compose ${ACME}`,
      `compute:kit:write ${ACME}`,
      `compute:kit:create ${ACME}`,
    ]);
    expect(trace).toEqual(['prepare']);
    expect(await notes()).toEqual([]);
    // A failed composite writes no audit row of its own.
    expect(await audit()).toEqual([]);
    expect(insideTransaction).toEqual([]);
  });

  it('replays a finished replay-only admission at check and at invoke, without a decision', async () => {
    iam.allow({ token: USER });
    const first = (await call('items', 'create', USER, item('gpu', 'k-replay'))) as Item;
    iam.reset();
    trace.length = 0;
    await store.query('DELETE FROM audit_events');
    const again = await compose(USER, async (context) => {
      await context.check!(ITEMS, item('gpu', 'k-replay'));
      return context.sql.transaction((tx) => context.invoke!(tx, ITEMS, item('gpu', 'k-replay')));
    });
    expect(again).toEqual({ id: first.id, label: 'gpu' });
    expect(requires()).toEqual([`compute:kit:compose ${ACME}`]);
    expect(trace).toEqual(['prepare', 'prepare']);
    expect((await audit()).map((row) => row.action)).toEqual(['compute:kit:compose']);

    // Another request under the same key is CONFLICT at check, before any decision.
    iam.reset();
    expect(
      await codeOf(compose(USER, (context) => context.check!(ITEMS, item('cpu', 'k-replay')))),
    ).toBe('CONFLICT');
    expect(requires()).toEqual([`compute:kit:compose ${ACME}`]);
  });

  it('rolls a failed sub-call back to its savepoint; the composite may go on', async () => {
    iam.allow({ token: USER });
    const codes = await compose(USER, async (context) => {
      await context.check!(NOTES, note('bad', 'boom'));
      await context.check!(NOTES, note('good'));
      return context.sql.transaction(async (tx) => [
        await codeOf(context.invoke!(tx, NOTES, note('bad', 'boom'))),
        await codeOf(context.invoke!(tx, NOTES, note('good'))),
      ]);
    });
    expect(codes).toEqual(['CONFLICT', 'ok']);
    expect(await notes()).toEqual(['good']);
    expect((await audit()).map((row) => row.action)).toEqual([
      'compute:kit:write',
      'compute:kit:compose',
    ]);
  });

  it('decides reads with authorize and public methods not at all', async () => {
    iam.allow({ token: USER });
    const result = await compose(USER, async (context) => {
      await context.check!('plugins/kit/notes/count', { tenantId: ACME, noteId: 'n' });
      await context.check!('plugins/kit/info/ping', {});
      return context.sql.transaction(async (tx) => ({
        count: await context.invoke!(tx, 'plugins/kit/notes/count', {
          tenantId: ACME,
          noteId: 'n',
        }),
        ping: await context.invoke!(tx, 'plugins/kit/info/ping', {}),
      }));
    });
    expect(result).toEqual({ count: { count: 0 }, ping: { pong: true, caller: false } });
    expect(
      iam.calls.filter((entry) => entry.method !== 'authenticate').map((entry) => entry.method),
    ).toEqual(['require', 'authorize']);
    // Reads and public calls write no audit rows.
    expect((await audit()).map((row) => row.action)).toEqual(['compute:kit:compose']);
  });

  it('lets a root caller compose in another tenant, decided in that tenant', async () => {
    iam.allow({ token: ADMIN });
    await compose(ADMIN, async (context) => {
      await context.check!(NOTES, note('root-note'));
      await context.sql.transaction((tx) => context.invoke!(tx, NOTES, note('root-note')));
    });
    expect(requires()).toEqual([`compute:kit:compose ${ACME}`, `compute:kit:write ${ACME}`]);
    expect((await audit())[0]!.admission).toMatchObject({ tenantId: ACME, identityId: 'id-admin' });
    // An outsider is refused by the composite's own pre-check, before its body runs.
    expect(await codeOf(compose(OUTSIDER, async () => 'ran'))).toBe('ACCESS_DENIED');
  });

  it('forgets grants when the call ends', async () => {
    iam.allow({ token: USER });
    await compose(USER, async (context) => {
      await context.check!(NOTES, note('late'));
    });
    const captured = hooks.captured!;
    expect(await codeOf(captured.check!(NOTES, note('late')))).toBe('INVALID_STATE');
    expect(
      await codeOf(
        compute.context.sql.transaction((tx: SqlTx) => captured.invoke!(tx, NOTES, note('late'))),
      ),
    ).toBe('ACCESS_DENIED');
    expect(await notes()).toEqual([]);
  });

  it('gives every other method refusing check and invoke', async () => {
    iam.allow({ token: USER });
    let codes: string[] = [];
    hooks.onNote = async (context) => {
      codes = [
        await codeOf(context.check!(NOTES, note('x'))),
        await codeOf(context.invoke!(context.sql as unknown as SqlTx, NOTES, note('x'))),
      ];
    };
    await call('notes', 'add', USER, note('direct'));
    expect(codes).toEqual(['INVALID_STATE', 'INVALID_STATE']);
    // Sub-calls, too: an invoked handler cannot compose.
    codes = [];
    await compose(USER, async (context) => {
      await context.check!(NOTES, note('nested'));
      await context.sql.transaction((tx) => context.invoke!(tx, NOTES, note('nested')));
    });
    expect(codes).toEqual(['INVALID_STATE', 'INVALID_STATE']);
  });
});

describe('a read declared transaction: manual', () => {
  it('runs with a read-only sql, after its one decision', async () => {
    iam.allow({ token: USER });
    const result = await call('notes', 'peek', USER, { tenantId: ACME, noteId: 'p1' });
    // The INSERT was refused by the read-only executor, so nothing was written.
    expect(result.writeCode).not.toBe('written');
    expect(await notes()).toEqual([]);
    // The decision (a read: authorize) came first, and no IAM call happened inside a transaction.
    expect(trace).toEqual(['peek handler']);
    expect(hooks.decisionsBeforePeek).toBe(1);
    expect(insideTransaction).toEqual([]);
  });

  it('denies a cross-tenant caller before the handler runs', async () => {
    iam.allow({ token: OUTSIDER });
    expect(await codeOf(call('notes', 'peek', OUTSIDER, { tenantId: ACME, noteId: 'p2' }))).toBe(
      'ACCESS_DENIED',
    );
    expect(trace).toEqual([]);
    // Turned away by the tenant pre-check: no decision was even asked of IAM.
    expect(iam.calls.filter((entry) => entry.method === 'authorize')).toEqual([]);
  });

  it('is refused by IAM before the handler runs when the caller lacks the action', async () => {
    iam.allow({ token: USER });
    iam.deny({ token: USER, action: 'compute:kit:read' });
    expect(await codeOf(call('notes', 'peek', USER, { tenantId: ACME, noteId: 'p3' }))).toBe(
      'ACCESS_DENIED',
    );
    expect(trace).toEqual([]);
  });
});

describe('transaction contracts', () => {
  const build = (definition: Partial<MethodDefinition>) =>
    betterCompute({
      ...options({} as never, fakeIam()),
      database: { query() {}, transaction() {}, migrate() {} } as never,
      plugins: [
        definePlugin({
          id: 'odd',
          catalog: { actions: ['compute:odd:do'] },
          api: () => ({
            things: {
              make: {
                action: 'compute:odd:do',
                kind: 'mutation',
                resource: (input: { tenantId: string }) => ({ type: 'tenant', id: input.tenantId }),
                validate: (input: unknown) => input as { tenantId: string },
                handler: async () => ({}),
                ...definition,
              } as MethodDefinition,
            },
          }),
        }),
      ],
    });

  it('refuses manual on a read whose row follows the list recipe', () => {
    const buildList = (definition: Partial<MethodDefinition>) =>
      betterCompute({
        ...options({} as never, fakeIam()),
        database: { query() {}, transaction() {}, migrate() {} } as never,
        modules: [
          defineModule({
            name: 'fakevps',
            api: () => ({
              instances: {
                list: {
                  action: 'compute:instances:read',
                  kind: 'read',
                  resource: (input: { tenantId: string }) => ({ type: 'tenant', id: input.tenantId }),
                  validate: (input: unknown) => input as { tenantId: string },
                  handler: async () => ({ items: [] }),
                  ...definition,
                } as MethodDefinition,
              },
            }),
          }),
        ],
      });
    expect(() => buildList({})).not.toThrow();
    expect(() => buildList({ transaction: 'manual' })).toThrow(
      /a list method does not run with transaction manual; use defineListMethod/,
    );
  });

  it('takes manual on reads and mutations, without an admission', () => {
    expect(() => build({ transaction: 'manual' })).not.toThrow();
    expect(() => build({ transaction: 'auto' })).not.toThrow();
    expect(() => build({ transaction: 'sometimes' as never })).toThrow(
      /transaction must be auto or manual/,
    );
    expect(() => build({ transaction: 'manual', kind: 'read' })).not.toThrow();
    expect(() => build({ transaction: 'manual', kind: 'public', action: null } as never)).toThrow(
      /a public method does not run with transaction manual/,
    );
    expect(() =>
      build({
        transaction: 'manual',
        admission: {
          prepare: async () => ({ status: 'decide', resource: { type: 'tenant', id: 't' } }),
        },
      }),
    ).toThrow(/takes no admission/);
  });
});
