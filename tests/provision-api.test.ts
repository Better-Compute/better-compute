import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiSurface,
  field,
  manifest,
  type AuthzRow,
  type AuthzWriter,
  type CommandQueue,
  type MethodContext,
  type ProfileDocument,
  type SqlExecutor,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { advanceWorkflow, defineStep, provisionMigrations, provisionModule, type ProvisionApi } from '@better-compute/provision';

// The profiles and workflows groups of PLAN.md §9.2 (v0.2 rows), called through their handlers.

let db: SqlExecutor;
const authzRows = new Map<string, AuthzRow>();
const authz: AuthzWriter = {
  async upsert(_tx, row) {
    authzRows.set(`${row.type}/${row.id}/${row.tenantId}`, row);
  },
  async remove(_tx, ref) {
    for (const key of [...authzRows.keys()])
      if (key.startsWith(`${ref.type}/${ref.id}/`) && (!ref.tenantId || key.endsWith(`/${ref.tenantId}`))) authzRows.delete(key);
  },
  async setPending() {},
};
const commands: CommandQueue = {
  async enqueue(tx, command) {
    const id = `cmd_${Math.random().toString(36).slice(2, 12)}`;
    await tx.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested, idempotency_key)
       VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM commands WHERE node_id = $2), $3, '\\x', 'pending',
         to_timestamp($4 / 1000.0), false, false, false, $5)`,
      [id, command.nodeId, command.kind, command.notAfter, command.idempotencyKey],
    );
    return { id, seq: 1 };
  },
  async cancel(tx, id) {
    await tx.query(`UPDATE commands SET state = 'cancelled' WHERE id = $1`, [id]);
  },
};
const record = defineStep({
  id: 'test.record',
  runsOn: 'control-plane',
  timeout: '1m',
  retrySafe: true,
  input: manifest({ label: field.string().optional() }),
  async run() {
    return null;
  },
});
const shipped = { id: 'shipped-adopt', version: 1, target: 'metal', entry: 'adopt' } as const satisfies ProfileDocument;
const module = provisionModule({ steps: [record], profiles: [shipped] });
let context: MethodContext;
let api: ProvisionApi;
const NODE = 'node_01j00000000000000000000001';
const OTHER_NODE = 'node_01j00000000000000000000002';

async function call<G extends keyof ProvisionApi, M extends keyof ProvisionApi[G]>(group: G, method: M, input: unknown) {
  const definition = api[group][method] as unknown as { validate(i: unknown): unknown; handler(c: MethodContext, i: unknown): Promise<any> };
  return definition.handler(context, definition.validate(input));
}

beforeAll(async () => {
  db = pglite();
  await db.migrate(provisionMigrations);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'ten_a', 'shared', 'eu', 1)`);
  for (const id of [NODE, OTHER_NODE])
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_a', 'ten_a', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
      [id],
    );
  const work = { async enqueue() {} };
  const events = { async publish() {} };
  context = { sql: db, authz, work, events, commands, requestId: 'req_test' } as unknown as MethodContext;
  api = module.api!(context);
});
afterAll(() => db.close());

const gpuHost = (version = 1, extra: Partial<ProfileDocument> = {}): ProfileDocument => ({
  id: 'gpu-host',
  version,
  target: 'metal',
  role: 'host',
  steps: [{ use: 'test.record', with: { label: `v${version}` } }, { use: 'power.setPower', on: 'site' }],
  ...extra,
});

describe('the §9.2 rows', () => {
  it('declares exactly the profiles and workflows rows, with their actions, kinds and resources', () => {
    for (const group of ['profiles', 'workflows'] as const) {
      const rows = apiSurface.filter((row) => row.group === group);
      expect(Object.keys(api[group]).sort()).toEqual(rows.map((row) => row.method).sort());
      for (const row of rows) {
        const method = (api[group] as Record<string, { action: string; kind: string; resource(i: unknown): { type: string } | undefined }>)[row.method]!;
        expect([method.action, method.kind]).toEqual([row.action, row.kind]);
        const probe = { tenantId: 'ten_a', profileId: 'p', nodeId: NODE, workflowId: 'wf_x' };
        expect(method.resource(probe)?.type).toBe(row.resource);
      }
    }
  });
});

describe('profiles', () => {
  it('creates, reads, lists and projects a profile for IAM', async () => {
    const created = await call('profiles', 'create', { tenantId: 'ten_a', document: gpuHost() });
    expect(created).toMatchObject({ id: 'gpu-host', tenantId: 'ten_a', visibility: 'private', version: 1 });
    expect(authzRows.get('profile/gpu-host/ten_a')?.attributes).toEqual({ target: 'metal', version: 1, visibility: 'private' });
    await expect(call('profiles', 'create', { tenantId: 'ten_a', document: gpuHost() })).rejects.toMatchObject({ code: 'CONFLICT' });
    await call('profiles', 'create', { tenantId: 'ten_a', document: gpuHost(2) });

    expect((await call('profiles', 'get', { tenantId: 'ten_a', profileId: 'gpu-host' })).document.version).toBe(2);
    expect((await call('profiles', 'get', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 1 })).document.version).toBe(1);
    await expect(call('profiles', 'get', { tenantId: 'ten_b', profileId: 'gpu-host' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Shipped profiles are visible to every tenant.
    expect((await call('profiles', 'get', { tenantId: 'ten_b', profileId: 'shipped-adopt' })).tenantId).toBe('builtin');

    const page = await call('profiles', 'list', { tenantId: 'ten_a', limit: 2 });
    expect(page.items.map((p: { id: string; document: { version: number } }) => `${p.id}@${p.document.version}`)).toEqual(['gpu-host@1', 'gpu-host@2']);
    const rest = await call('profiles', 'list', { tenantId: 'ten_a', limit: 2, cursor: page.cursor });
    // The remediation profiles ship with provision; shipped profiles are read-only for everyone.
    expect(rest.items.map((p: { id: string }) => p.id)).toEqual(['remediate-gpu-reset', 'remediate-reboot']);
    const last = await call('profiles', 'list', { tenantId: 'ten_a', limit: 2, cursor: rest.cursor });
    expect(last.items.map((p: { id: string }) => p.id)).toEqual(['shipped-adopt']);
    expect(last.cursor).toBeUndefined();
  });

  it('rejects invalid documents as INVALID_INPUT', async () => {
    await expect(
      call('profiles', 'create', { tenantId: 'ten_a', document: { ...gpuHost(9), steps: [{ use: 'Bad Id' }] } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call('profiles', 'create', { tenantId: 'ten_a', document: gpuHost(9), extra: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('validates and renders against the registered steps', async () => {
    await call('profiles', 'create', { tenantId: 'ten_a', document: gpuHost(3, { steps: [{ use: 'missing.step' }] }) });
    const invalid = await call('profiles', 'validate', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 3 });
    expect(invalid).toMatchObject({ valid: false, issues: [{ path: 'steps[0].use' }] });
    await expect(call('profiles', 'render', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 3 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const rendered = await call('profiles', 'render', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 1 });
    expect(rendered.steps.map((s: { id: string; action: string }) => [s.id, s.action])).toEqual([
      ['main.1', 'test.record'],
      ['main.2', 'power.setPower'],
    ]);
    expect(await call('profiles', 'validate', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 1 })).toEqual({ valid: true, issues: [] });
  });

  it('updates an unused version, and freezes a version once a workflow used it', async () => {
    const updated = await call('profiles', 'update', {
      tenantId: 'ten_a',
      profileId: 'gpu-host',
      profileVersion: 3,
      document: gpuHost(3),
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    await expect(
      call('profiles', 'update', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 3, visibility: 'public', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await db.transaction((tx) =>
      module.workflowEngine(context).start(tx, { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 3, nodeId: OTHER_NODE }),
    );
    await expect(
      call('profiles', 'update', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 3, document: gpuHost(3) }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // Visibility may still change.
    expect((await call('profiles', 'update', { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 3, visibility: 'public' })).visibility).toBe('public');
  });

  it('deletes a version, then the rest, dropping the authz row with the last one', async () => {
    await call('profiles', 'create', { tenantId: 'ten_a', document: { ...gpuHost(), id: 'temp' } });
    await call('profiles', 'create', { tenantId: 'ten_a', document: { ...gpuHost(2), id: 'temp' } });
    expect(await call('profiles', 'delete', { tenantId: 'ten_a', profileId: 'temp', profileVersion: 1 })).toEqual({ deleted: 1 });
    expect(authzRows.has('profile/temp/ten_a')).toBe(true);
    expect(await call('profiles', 'delete', { tenantId: 'ten_a', profileId: 'temp' })).toEqual({ deleted: 1 });
    expect(authzRows.has('profile/temp/ten_a')).toBe(false);
    await expect(call('profiles', 'delete', { tenantId: 'ten_a', profileId: 'temp' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('workflows', () => {
  it('reads, lists, aborts and retries a node workflow', async () => {
    const { id } = await db.transaction((tx) =>
      module.workflowEngine(context).start(tx, { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 1, nodeId: NODE }),
    );
    const ref = { tenantId: 'ten_a', nodeId: NODE, workflowId: id };
    const view = await call('workflows', 'get', ref);
    expect(view).toMatchObject({ id, nodeId: NODE, state: 'pending', profileId: 'gpu-host', profileVersion: 1 });
    expect(view.steps.map((s: { id: string; state: string; idempotencyKey: string }) => [s.id, s.state, s.idempotencyKey])).toEqual([
      ['main.1', 'pending', `wf:${id}:main.1`],
      ['main.2', 'pending', `wf:${id}:main.2`],
    ]);
    await expect(call('workflows', 'get', { ...ref, nodeId: OTHER_NODE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call('workflows', 'get', { ...ref, tenantId: 'ten_b' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const listed = await call('workflows', 'list', { tenantId: 'ten_a', nodeId: NODE });
    expect(listed.items.map((w: { id: string }) => w.id)).toEqual([id]);

    const aborted = await call('workflows', 'abort', { ...ref, reason: 'changed my mind' });
    expect(aborted).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED', message: 'changed my mind' } });
    await expect(call('workflows', 'retry', ref)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(call('workflows', 'abort', { ...ref, workflowId: 'not-a-wf' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('pauses between steps and resumes (§11.2)', async () => {
    const PAUSED_NODE = 'node_01j00000000000000000000003';
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_a', 'ten_a', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
      [PAUSED_NODE],
    );
    const { id } = await db.transaction((tx) =>
      module.workflowEngine(context).start(tx, { tenantId: 'ten_a', profileId: 'gpu-host', profileVersion: 1, nodeId: PAUSED_NODE }),
    );
    const ref = { tenantId: 'ten_a', nodeId: PAUSED_NODE, workflowId: id };
    // Started: main.1 (a control-plane step) runs, then main.2 waits for a site agent.
    await advanceWorkflow(context as never, module.engineOptions, id);
    expect((await call('workflows', 'get', ref)).state).toBe('running');
    const paused = await call('workflows', 'pause', ref);
    expect(paused.state).toBe('paused');
    // Paused: the step in flight may still settle, but the engine starts nothing more.
    const before = paused.steps.map((s: { state: string }) => s.state);
    await advanceWorkflow(context as never, module.engineOptions, id);
    expect((await call('workflows', 'get', ref)).steps.map((s: { state: string }) => s.state)).toEqual(before);
    await expect(call('workflows', 'pause', ref)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await call('workflows', 'resume', ref)).state).toBe('running');
    await expect(call('workflows', 'resume', ref)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(call('workflows', 'pause', { ...ref, tenantId: 'ten_b' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => api.workflows.pause.validate({ ...ref, fromStep: 'main.1' })).toThrow();
    await call('workflows', 'abort', ref);
  });
});
