import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  defineMethod,
  defineModule,
  type Caller,
  type Check,
  type MethodContext,
  type SqlExecutor,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute } from '@better-compute/server';
import { createCaches } from '../packages/server/src/caches.js';
import {
  createListRecipe,
  defineListMethod,
  readOnlyExecutor,
} from '../packages/server/src/list.js';
import { fakeIam } from './support/fake-iam.js';
import { ACME, ROOT, options } from './support/server.js';
import { ADMIN, USER, serverHarness, type Harness } from './support/server-api.js';

// The list recipe (PLAN.md §9.2, P7, P11): the envelope's coarse gate, the method's SQL, then
// per-item checks in batches of at most 50 outside any transaction, answered from the read-decision
// cache where possible; a failed batch fails the request, a resolver NOT_FOUND retries once.

const caller: Caller = {
  identityId: 'id-user',
  identityKind: 'user',
  tenantId: ACME,
  sessionId: 'ses-user',
  sessionKind: 'user',
  mfa: false,
};

/** A method context whose IAM answers `authorizeMany` with `answer`, recording each batch. */
function contextWith(answer: (checks: Check[], call: number) => unknown) {
  const batches: Check[][] = [];
  const context = {
    caller,
    credential: { token: USER },
    iam: {
      async authorizeMany(_credential: unknown, tenantId: string, checks: Check[]) {
        expect(tenantId).toBe(ACME);
        batches.push(checks);
        return answer(checks, batches.length);
      },
    },
  } as unknown as MethodContext;
  return { context, batches };
}

const items = (count: number, prefix = 'n') =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));
const check = { action: 'compute:nodes:read', type: 'node', id: (item: { id: string }) => item.id };

function recipe(caches = createCaches()) {
  return createListRecipe({ typePrefix: 'compute-', caches, retryDelayMs: 0 });
}

describe('createListRecipe().authorizeItems', () => {
  it('checks at most 50 items per authorizeMany and keeps the allowed ones in order', async () => {
    const { context, batches } = contextWith((checks) =>
      checks.map((entry) => Number(entry.resource.id.slice(1)) % 3 !== 0),
    );
    const allowed = await recipe().authorizeItems(context, ACME, async () => items(120), check);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(batches[0]![0]).toEqual({
      action: 'compute:nodes:read',
      resource: { type: 'compute-node', id: 'n0' },
    });
    expect(allowed.map((item) => item.id)).toEqual(
      items(120)
        .map((item) => item.id)
        .filter((id) => Number(id.slice(1)) % 3 !== 0),
    );
  });

  it('answers cached allows without IAM and remembers new ones', async () => {
    const caches = createCaches();
    const { context, batches } = contextWith((checks) =>
      checks.map((entry) => entry.resource.id !== 'n1'),
    );
    const lists = recipe(caches);
    await lists.authorizeItems(context, ACME, async () => items(3), check);
    const again = await lists.authorizeItems(context, ACME, async () => items(4), check);
    // n0 and n2 were allowed and remembered; n1 (denied) and n3 (new) are asked again.
    expect(batches.map((batch) => batch.map((entry) => entry.resource.id))).toEqual([
      ['n0', 'n1', 'n2'],
      ['n1', 'n3'],
    ]);
    expect(again.map((item) => item.id)).toEqual(['n0', 'n2', 'n3']);
  });

  it('asks nothing for an empty page', async () => {
    const { context, batches } = contextWith(() => []);
    expect(await recipe().authorizeItems(context, ACME, async () => [], check)).toEqual([]);
    expect(batches).toEqual([]);
  });

  it('fails the request when a batch fails, never answering "all false" (P11)', async () => {
    const { context } = contextWith((_checks, call) => {
      if (call === 2) throw new ComputeError('INTERNAL_ERROR', 'IAM lane timeout');
      return _checks.map(() => true);
    });
    await expect(
      recipe().authorizeItems(context, ACME, async () => items(60), check),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'IAM lane timeout' });
  });

  it('fails the request when an answer does not match its batch', async () => {
    for (const answer of [[true], 'yes', [true, 'no']]) {
      const { context } = contextWith(() => answer);
      await expect(
        recipe().authorizeItems(context, ACME, async () => items(2), check),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    }
  });

  it('reloads the page and retries once after a resolver NOT_FOUND', async () => {
    let loads = 0;
    const { context, batches } = contextWith((checks, call) => {
      if (call === 1) throw new ComputeError('NOT_FOUND', 'Resource not visible in this tenant');
      return checks.map(() => true);
    });
    const allowed = await recipe().authorizeItems(
      context,
      ACME,
      async () => items(++loads === 1 ? 2 : 3),
      check,
    );
    expect(loads).toBe(2);
    expect(batches).toHaveLength(2);
    expect(allowed).toHaveLength(3);
  });

  it('fails when the retry meets NOT_FOUND again', async () => {
    let loads = 0;
    const { context } = contextWith(() => {
      throw Object.assign(new Error('not visible'), { code: 'NOT_FOUND' });
    });
    await expect(
      recipe().authorizeItems(context, ACME, async () => (loads++, items(1)), check),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(loads).toBe(2);
  });
});

describe('createListRecipe().mine', () => {
  it('passes rows the SQL scoped to the caller, and fails on anyone else’s', () => {
    const { context } = contextWith(() => []);
    const lists = recipe();
    const rows = [{ owner: 'id-user' }, { owner: 'id-user' }];
    expect(lists.mine(context, rows, (row) => row.owner)).toEqual(rows);
    expect(() => lists.mine(context, [...rows, { owner: 'id-other' }], (row) => row.owner)).toThrow(
      /another owner/,
    );
  });
});

describe('list methods', () => {
  it('are reads only', () => {
    expect(() =>
      defineListMethod({
        action: 'compute:nodes:read',
        kind: 'mutation',
        resource: () => undefined,
        validate: (input) => input,
        handler: async () => undefined,
      }),
    ).toThrow(/Only read methods/);
    void defineMethod;
  });

  it('read through a read-only executor', async () => {
    const h = await serverHarness();
    try {
      const sql = readOnlyExecutor(h.store);
      await expect(sql.query('SELECT 1 AS one')).resolves.toMatchObject({ rows: [{ one: 1 }] });
      await expect(
        sql.query("INSERT INTO projects VALUES ('p', 't', 'n', 'active', 1)"),
      ).rejects.toThrow(/read-only transaction/);
      await expect(sql.migrate()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally {
      await h.close();
    }
  });
});

describe('the list recipe through nodes.list, sites.list and projects.list', () => {
  let h: Harness;
  let siteId: string;
  const nodes: string[] = [];
  beforeAll(async () => {
    h = await serverHarness();
    siteId = await h.seed.site(ACME);
    for (let index = 0; index < 3; index += 1) nodes.push(await h.seed.node(ACME, siteId));
    // A node the projection does not hold for acme: SQL never offers it for a decision.
    await h.seed.node(ACME, siteId, { visible: false });
    nodes.sort();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => h.reset());

  const list = (token = USER, input: object = {}) =>
    h.call<{ items: { id: string }[]; cursor?: string }>('nodes/list', token, {
      tenantId: ACME,
      ...input,
    });

  it('decides the scope once, then each projected item, outside any transaction', async () => {
    const token = 'token-acme-lister-0123456789';
    h.iam.addCaller(token, { tenantId: ACME, identityId: 'id-lister', sessionId: 'ses-lister' });
    h.iam.allow({ token, action: 'compute:nodes:read', type: 'compute-tenant' });
    h.iam.allow({ token, action: 'compute:nodes:read', id: nodes[0] });
    h.iam.allow({ token, action: 'compute:nodes:read', id: nodes[2] });
    const open: number[] = [];
    const authorizeMany = h.iam.authorizeMany;
    h.iam.authorizeMany = async (...args) => {
      open.push(h.database.openTransactions());
      return authorizeMany(...args);
    };
    try {
      const page = await list(token);
      expect(page.items.map((node) => node.id)).toEqual([nodes[0], nodes[2]]);
      expect(h.iam.calls.map((call) => call.method)).toEqual([
        'authenticate',
        'authorize',
        'authorizeMany',
      ]);
      expect(h.iam.calls[1]!.decision).toEqual({
        tenantId: ACME,
        action: 'compute:nodes:read',
        resource: { type: 'compute-tenant', id: ACME },
      });
      expect(open).toEqual([0]);
      // Every statement ran read-only, in its own transaction.
      expect(h.database.log.every((entry) => entry === 'transaction (read only)')).toBe(true);
    } finally {
      h.iam.authorizeMany = authorizeMany;
    }
  });

  it('pages by id with a cursor', async () => {
    h.iam.allow({ token: USER, action: 'compute:nodes:read' });
    const first = await list(USER, { limit: 2 });
    expect(first.items.map((node) => node.id)).toEqual(nodes.slice(0, 2));
    expect(first.cursor).toBe(nodes[1]);
    const second = await list(USER, { limit: 2, cursor: first.cursor });
    expect(second.items.map((node) => node.id)).toEqual([nodes[2]]);
    expect(second.cursor).toBeUndefined();
  });

  it('fails the whole list when authorizeMany fails', async () => {
    h.iam.allow({ token: USER, action: 'compute:nodes:read' });
    const authorizeMany = h.iam.authorizeMany;
    h.iam.authorizeMany = async () => {
      throw new ComputeError('INTERNAL_ERROR', 'IAM unavailable');
    };
    try {
      expect((await h.failure('nodes/list', USER, { tenantId: ACME })).code).toBe('INTERNAL_ERROR');
    } finally {
      h.iam.authorizeMany = authorizeMany;
    }
  });

  it('retries a page once when the resolver has not caught up', async () => {
    h.iam.allow({ token: USER, action: 'compute:nodes:read' });
    const authorizeMany = h.iam.authorizeMany;
    let calls = 0;
    h.iam.authorizeMany = async (...args) => {
      if (++calls === 1) throw new ComputeError('NOT_FOUND', 'Resource not visible in this tenant');
      return authorizeMany(...args);
    };
    try {
      expect((await list()).items).toHaveLength(3);
      expect(calls).toBe(2);
    } finally {
      h.iam.authorizeMany = authorizeMany;
    }
  });

  it('refuses the coarse gate before any SQL', async () => {
    const token = 'token-acme-nobody-0123456789';
    h.iam.addCaller(token, { tenantId: ACME, identityId: 'id-nobody', sessionId: 'ses-nobody' });
    expect((await h.failure('nodes/list', token, { tenantId: ACME })).code).toBe('ACCESS_DENIED');
    expect(h.database.log).toEqual([]);
    expect(h.iam.count('authorizeMany')).toBe(0);
  });

  it('lets a root caller list a tenant, as IAM decides', async () => {
    h.iam.allow({ token: ADMIN, action: 'compute:sites:read' });
    const page = await h.call<{ items: { id: string }[] }>('sites/list', ADMIN, { tenantId: ACME });
    expect(page.items.map((site) => site.id)).toEqual([siteId]);
    expect(h.iam.calls.map((call) => call.decision?.tenantId).filter(Boolean)).toEqual([ACME]);
    void ROOT;
  });

  it('lists projects with the same recipe', async () => {
    h.iam.allow({ token: USER, action: 'compute:projects:manage' });
    h.iam.allow({ token: USER, action: 'compute:projects:read' });
    await h.call('projects/create', USER, { tenantId: ACME, name: 'alpha', idempotencyKey: 'a' });
    await h.call('projects/create', USER, { tenantId: ACME, name: 'beta', idempotencyKey: 'b' });
    h.iam.reset();
    const page = await h.call<{ items: { name: string }[] }>('projects/list', USER, {
      tenantId: ACME,
    });
    expect(page.items.map((project) => project.name).sort()).toEqual(['alpha', 'beta']);
    expect(h.iam.calls.map((call) => call.method)).toEqual(['authorize', 'authorizeMany']);
  });
});

describe('module list methods: the envelope applies the recipe after the page (§9.2 "+ items")', () => {
  // A module's list method of a "+ items" row that does not use defineListMethod (capacity's
  // pools.list, reservations.list): the envelope reads the page in a read-only transaction, then
  // decides its items; owner-scoped kinds listing the caller's own keep the SQL filter alone.
  let store: SqlExecutor;
  let page: unknown = {};
  const lister = defineModule({
    name: 'lister',
    api: () => ({
      profiles: {
        list: defineMethod<{ tenantId: string }, unknown>({
          action: 'compute:profiles:read',
          kind: 'read',
          resource: (input) => ({ type: 'tenant', id: input.tenantId }),
          validate: (input) => input as { tenantId: string },
          handler: async (context) => {
            await context.sql.query('SELECT 1');
            return page;
          },
        }),
      },
      instances: {
        list: defineMethod<{ tenantId: string; scope?: string }, unknown>({
          action: 'compute:instances:read',
          kind: 'read',
          resource: (input) => ({ type: 'tenant', id: input.tenantId }),
          validate: (input) => input as { tenantId: string; scope?: string },
          handler: async () => ({ items: [{ id: 'inst_a' }, { id: 'inst_b' }] }),
        }),
      },
    }),
  });
  const iam = fakeIam();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user', sessionId: 'ses-user' });
  let compute: ReturnType<typeof betterCompute>;
  beforeAll(async () => {
    store = pglite();
    compute = betterCompute({ ...options(store, iam), modules: [lister] });
    iam.allow({ token: USER, type: 'compute-tenant' });
    iam.allow({ token: USER, type: 'compute-profile', id: 'prf_a' });
    iam.allow({ token: USER, type: 'compute-profile', id: 'prf_c' });
    iam.allow({ token: USER, type: 'compute-instance', id: 'inst_a' });
  });
  afterAll(async () => {
    await store.close();
  });
  beforeEach(() => {
    iam.reset();
    compute.caches.clear();
  });
  type Lists = Record<string, Record<string, (credential: unknown, input: unknown) => unknown>>;
  const call = (group: string, input: object = {}) =>
    (compute.api as unknown as Lists)[group]!.list!({ token: USER }, { tenantId: ACME, ...input });

  it('keeps the allowed items of the page, its cursor, and the page order', async () => {
    page = { items: [{ id: 'prf_a' }, { id: 'prf_b' }, { id: 'prf_c' }], cursor: 'prf_c' };
    expect(await call('profiles')).toEqual({
      items: [{ id: 'prf_a' }, { id: 'prf_c' }],
      cursor: 'prf_c',
    });
    expect(iam.calls.map((entry) => entry.method)).toEqual([
      'authenticate',
      'authorize',
      'authorizeMany',
    ]);
  });

  it('keeps the owner filter alone for the caller’s own owner-scoped items', async () => {
    expect(await call('instances')).toEqual({ items: [{ id: 'inst_a' }, { id: 'inst_b' }] });
    expect(iam.count('authorizeMany')).toBe(0);
    expect(await call('instances', { scope: 'all' })).toEqual({ items: [{ id: 'inst_a' }] });
    expect(iam.count('authorizeMany')).toBe(1);
  });

  it('fails closed: a failed batch or a page it cannot decide fails the request', async () => {
    page = { items: [{ id: 'prf_a' }] };
    const authorizeMany = iam.authorizeMany;
    iam.authorizeMany = async () => {
      throw new ComputeError('INTERNAL_ERROR', 'IAM unavailable');
    };
    try {
      await expect(call('profiles')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    } finally {
      iam.authorizeMany = authorizeMany;
    }
    for (const bad of [[{ id: 'prf_a' }], { items: [{ name: 'no id' }] }, {}]) {
      page = bad;
      await expect(call('profiles')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    }
  });
});
