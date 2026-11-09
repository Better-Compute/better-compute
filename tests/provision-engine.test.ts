import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  field,
  manifest,
  type CommandQueue,
  type EventPublisher,
  type ModuleContext,
  type ProfileDocument,
  type SqlExecutor,
  type WorkQueue,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { quorumMigration } from '@better-compute/server';
import {
  abortWorkflow,
  advanceWorkflow,
  awaitCommand,
  defineProfile,
  defineStep,
  evaluateWhen,
  expandProfile,
  pauseWorkflow,
  provisionMigrations,
  provisionModule,
  resumeWorkflow,
  retryWorkflow,
  startWorkflow,
  batchNodeWorkflow,
  stepNotReady,
  stepRegistry,
  stepWaiting,
  type AdvanceOptions,
  type EngineContext,
} from '@better-compute/provision';

// The workflow engine on PGlite (PLAN.md §11.2), driven transition by transition with the sim clock.

const START = Date.UTC(2026, 8, 1);
const SITE_AGENT = 'node_site0000000000000000000000';
let db: SqlExecutor;
let now = START;

const events: { type: string; data: Record<string, unknown> }[] = [];
const wakes: { key: string; notBefore?: number }[] = [];
const work: WorkQueue = {
  async enqueue(_tx, kind, key, options) {
    wakes.push({ key: `${kind}:${key}`, ...(options?.notBefore !== undefined ? { notBefore: options.notBefore } : {}) });
  },
};
const eventLog: EventPublisher = {
  async publish(_tx, event) {
    events.push({ type: event.type, data: event.data as Record<string, unknown> });
  },
};
const commands: CommandQueue = {
  async enqueue(tx, command) {
    const existing = await tx.query<{ id: string; seq: number }>(
      'SELECT id, seq FROM commands WHERE node_id = $1 AND idempotency_key = $2',
      [command.nodeId, command.idempotencyKey],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, seq: Number(existing.rows[0].seq) };
    const seq = await tx.query<{ seq: number }>(
      'UPDATE nodes SET next_cmd_seq = next_cmd_seq + 1 WHERE id = $1 RETURNING next_cmd_seq - 1 AS seq',
      [command.nodeId],
    );
    const id = `cmd_${command.idempotencyKey.replace(/[^a-z0-9]/gi, '').slice(-40)}${seq.rows[0]!.seq}`;
    await tx.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', to_timestamp($6 / 1000.0), false, false, false, $7)`,
      [id, command.nodeId, seq.rows[0]!.seq, command.kind, new TextEncoder().encode(JSON.stringify(command.payload)), command.notAfter, command.idempotencyKey],
    );
    return { id, seq: Number(seq.rows[0]!.seq) };
  },
  async cancel(tx, id) {
    await tx.query(
      `UPDATE commands SET state = 'cancelled' WHERE id = $1 AND state IN ('pending', 'dispatched', 'acked', 'running')`,
      [id],
    );
  },
};

const ran: string[] = [];
let notReadyUntil = 0;
const record = defineStep({
  id: 'test.record',
  runsOn: 'control-plane',
  timeout: '1m',
  retrySafe: true,
  input: manifest({ label: field.string().optional(), fail: field.boolean().optional() }),
  async run(input, context) {
    ran.push(`${input.label ?? 'record'}#${context.attempt}`);
    if (input.fail) throw new Error(`boom ${input.label ?? ''}`.trim());
    if (Date.now() < notReadyUntil) throw stepNotReady(1_000);
    return { label: input.label ?? null, node: context.node?.id ?? null };
  },
});
const kexec = defineStep({
  id: 'boot.kexec',
  runsOn: 'ramdisk',
  timeout: '15m',
  retrySafe: false,
  await: 'rejoin',
  command: 'boot.kexec',
  input: manifest({}),
});
/** A control-plane step that relays two commands as metal's do (`awaitCommand`): one to the site agent, one to the machine. */
const relayed = defineStep({
  id: 'test.relayed',
  runsOn: 'control-plane',
  timeout: '1m',
  retrySafe: true,
  input: manifest({}),
  async run(_input, stepContext) {
    await stepContext.sql.transaction((tx) =>
      stepContext.commands.enqueue(tx, {
        nodeId: SITE_AGENT,
        kind: 'boot.prepareRamdisk',
        payload: {},
        idempotencyKey: `${stepContext.idempotencyKey}#${stepContext.attempt}:entry`,
        notAfter: Date.now() + 600_000,
      }),
    );
    await awaitCommand(stepContext, { nodeId: stepContext.node!.id, kind: 'disk.wipe', key: 'wipe', payload: {} });
    return null;
  },
});
/** A control-plane step that sends its command only once the test opens `gate` (a step still running when it is aborted). */
let gate: Promise<void> = Promise.resolve();
let gated: (() => void) | undefined;
let lateEnqueue: unknown;
const late = defineStep({
  id: 'test.late',
  runsOn: 'control-plane',
  timeout: '1m',
  retrySafe: true,
  input: manifest({}),
  async run(_input, stepContext) {
    gated?.();
    await gate;
    lateEnqueue = await stepContext.sql
      .transaction((tx) =>
        stepContext.commands.enqueue(tx, {
          nodeId: stepContext.node!.id,
          kind: 'disk.wipe',
          payload: {},
          idempotencyKey: `${stepContext.idempotencyKey}#${stepContext.attempt}:late`,
          notAfter: Date.now() + 600_000,
        }),
      )
      .catch((error: unknown) => error);
    return null;
  },
});
/** A step that must not be sent twice (as deploy.deploy or raid.apply): it fails every time it runs. */
const once = defineStep({
  id: 'test.once',
  runsOn: 'control-plane',
  timeout: '1m',
  retrySafe: false,
  input: manifest({}),
  async run(_input, stepContext) {
    ran.push(`once#${stepContext.attempt}`);
    throw new Error('half done');
  },
});
/** A step that waits for an operator (as metal.ensureRamdisk for metal.confirmMac) while `operatorWait` is set, then is not ready, then done. */
let operatorWait: number | undefined;
let afterWait: 'not-ready' | 'done' = 'done';
const decided = defineStep({
  id: 'test.decided',
  runsOn: 'control-plane',
  timeout: '1m',
  retrySafe: true,
  input: manifest({}),
  async run() {
    if (operatorWait !== undefined) throw stepWaiting(operatorWait, 15_000);
    if (afterWait === 'not-ready') throw stepNotReady(1_000);
    return null;
  },
});
const registry = stepRegistry([record, kexec, relayed, late, once, decided]);

const stored = new Map<string, ProfileDocument>();
const options: AdvanceOptions = {
  steps: registry,
  profiles: { async get(_tx, _tenant, id, version) { return stored.get(`${id}@${version}`); } },
};
const context = (): EngineContext & { sql: SqlExecutor } => ({ sql: db, work, events: eventLog, commands } as never);
function profile(document: Omit<ProfileDocument, 'version' | 'target'> & { version?: number }): ProfileDocument {
  const full = defineProfile({ version: 1, target: 'metal', ...document } as ProfileDocument);
  stored.set(`${full.id}@${full.version}`, full);
  return full;
}

let seq = 0;
let node: string;
async function addNode(): Promise<string> {
  const id = `node_${String(++seq).padStart(26, '0')}`;
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
       trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', NULL, 'ten_a', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [id],
  );
  await db.query(
    `INSERT INTO node_sessions (node_id, session_epoch, boot_id, role, connected_at) VALUES ($1, 1, 'boot-1', 'ramdisk', compute_now())`,
    [id],
  );
  return id;
}

async function start(profileId: string, nodeId = node) {
  return db.transaction((tx) =>
    startWorkflow(context(), options, tx, { tenantId: 'ten_a', profileId, profileVersion: 1, nodeId }),
  );
}
const advance = (id: string) => advanceWorkflow(context(), options, id);
async function workflow(id: string) {
  return (await db.query<{ state: string; outcome: string | null; error: { code: string; message: string } | null; step_id: string | null }>(
    'SELECT state, outcome, error, step_id FROM workflows WHERE id = $1',
    [id],
  )).rows[0]!;
}
async function steps(id: string) {
  const { rows } = await db.query<{ id: string; state: string; attempt: number; command_id: string | null; action: string }>(
    'SELECT id, state, attempt, command_id, action FROM workflow_steps WHERE workflow_id = $1 ORDER BY index',
    [id],
  );
  return rows;
}
const states = async (id: string) => Object.fromEntries((await steps(id)).map((s) => [s.id, s.state]));
/** Every command sent under the workflow's keys: idempotency key → state. */
async function stepCommands(id: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ idempotency_key: string; state: string }>(
    `SELECT idempotency_key, state FROM commands WHERE starts_with(idempotency_key, $1) ORDER BY idempotency_key`,
    [`wf:${id}:`],
  );
  return Object.fromEntries(rows.map((row) => [row.idempotency_key, row.state]));
}
async function settleCommand(id: string, state: string, reason?: string) {
  await db.query('UPDATE commands SET state = $2, reason = $3 WHERE id = $1', [id, state, reason ?? null]);
}
async function tick(ms: number) {
  now += ms;
  await setSimClock(db, now);
}

beforeAll(async () => {
  db = pglite();
  await db.migrate(provisionMigrations);
  await useSimClock(db, START);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'ten_a', 'shared', 'eu', 1)`);
  // The site agent that runs `on: site` steps.
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
       trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', NULL, 'ten_a', 'site', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [SITE_AGENT],
  );
  await db.query(
    `INSERT INTO node_sessions (node_id, session_epoch, boot_id, role, connected_at) VALUES ($1, 1, 'site-boot', 'site', compute_now())`,
    [SITE_AGENT],
  );
});
afterAll(() => db.close());
beforeEach(async () => {
  node = await addNode();
  events.length = 0;
  wakes.length = 0;
  ran.length = 0;
  notReadyUntil = 0;
});

describe('expandProfile', () => {
  it('resolves registered steps and driver operations, and phases acceptance, on-failure and cleanup', async () => {
    const doc = defineProfile({
      id: 'expand-1',
      version: 1,
      target: 'metal',
      drivers: { power: 'redfish', boot: { driver: 'ipxe', config: { http: true } } },
      steps: [
        { use: 'power.setPower', on: 'site', with: { action: 'cycle' } },
        { use: 'boot.kexec', await: 'rejoin', timeout: '20m', onFailure: { use: 'power.setPower', on: 'site', with: { action: 'reset' } } },
      ],
      acceptance: [{ use: 'diag.dcgm', fallback: 'test.record', with: { label: 'accept' } }],
      cleanup: [{ use: 'boot.cleanUp', on: 'site' }],
    });
    const { steps, issues } = await expandProfile(doc, registry);
    expect(issues).toEqual([]);
    expect(steps.map((s) => [s.id, s.phase, s.action, s.runsOn, s.commandKind ?? null])).toEqual([
      ['main.1', 'main', 'power.setPower', 'site', 'driver.invoke'],
      ['main.2', 'main', 'boot.kexec', 'ramdisk', 'boot.kexec'],
      ['main.3', 'main', 'test.record', 'control-plane', null],
      ['main.2.on-failure', 'on-failure', 'power.setPower', 'site', 'driver.invoke'],
      ['cleanup.1', 'cleanup', 'boot.cleanUp', 'site', 'driver.invoke'],
    ]);
    expect(steps[0]!.args).toEqual({ concern: 'power', operation: 'setPower', args: { action: 'cycle' }, driver: 'redfish' });
    expect(steps[1]).toMatchObject({ await: 'rejoin', timeoutMs: 20 * 60_000, onFailure: 'step' });
    expect(steps[4]!.args).toMatchObject({ driver: 'ipxe', config: { http: true } });
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports every step that does not resolve and every rejected input', async () => {
    const doc = defineProfile({
      id: 'expand-2',
      version: 1,
      target: 'metal',
      steps: [{ use: 'nope.missing' }, { use: 'test.record', with: { label: 7 } }, { use: 'test.record', on: 'site' }],
    });
    const { issues } = await expandProfile(doc, registry);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].use', 'steps[1].with.label', 'steps[2].on']);
  });

  it("lets a relaying control-plane step be written with on: its agent, and nothing else", async () => {
    const relay = defineStep({
      id: 'relay.ping',
      runsOn: 'control-plane',
      relays: ['site'],
      timeout: '1m',
      retrySafe: true,
      input: manifest({}),
      run: async () => null,
    });
    const doc = defineProfile({ id: 'relay', version: 1, target: 'metal', steps: [{ use: 'relay.ping', on: 'site' }, { use: 'relay.ping', on: 'ramdisk' }] });
    const { steps, issues } = await expandProfile(doc, stepRegistry([relay]));
    expect(steps[0]).toMatchObject({ action: 'relay.ping', runsOn: 'control-plane' });
    expect(issues.map((i) => i.path)).toEqual(['steps[1].on']);
    const { extension: _stamp, ...input } = relay;
    expect(() => defineStep({ ...input, relays: ['moon'] as never })).toThrow(/relays\[0\]/);
    expect(() =>
      defineStep({ id: 'agent.x', runsOn: 'site', command: 'agent.x', timeout: '1m', retrySafe: true, input: manifest({}), relays: ['site'] }),
    ).toThrow(/only for control-plane steps/);
  });

  it('holds a relaying step to the kinds it declares in sends (the batch scope, §13)', async () => {
    const relay = (id: string, sent: string) =>
      defineStep({
        id,
        runsOn: 'control-plane',
        sends: ['inventory.refresh'],
        timeout: '1m',
        retrySafe: true,
        input: manifest({}),
        async run(_input, stepContext) {
          await stepContext.sql.transaction((tx) =>
            stepContext.commands.enqueue(tx, { nodeId: stepContext.node!.id, kind: sent, payload: {}, idempotencyKey: `${id}-1`, notAfter: Date.now() + 60_000 }),
          );
          return null;
        },
      });
    const own: AdvanceOptions = { ...options, steps: stepRegistry([relay('test.honest', 'inventory.refresh'), relay('test.liar', 'disk.wipe')]) };
    for (const [id, expected] of [
      ['test.honest', 'succeeded'],
      ['test.liar', 'failed'],
    ] as const) {
      profile({ id: `sends-${id}`, steps: [{ use: id }] });
      const target = await addNode();
      const { id: workflowId } = await db.transaction((tx) =>
        startWorkflow(context(), own, tx, { tenantId: 'ten_a', profileId: `sends-${id}`, profileVersion: 1, nodeId: target }),
      );
      await advanceWorkflow(context(), own, workflowId);
      const row = await workflow(workflowId);
      expect(row.state, id).toBe(expected);
      if (expected === 'failed') expect(row.error?.message).toMatch(/does not declare in sends/);
    }
  });

  it('batches a workflow’s self-executed destructive kinds on its node (remediation, §13)', async () => {
    const reboot = defineStep({ id: 'node.reboot', runsOn: 'node', command: 'node.reboot', timeout: '5m', retrySafe: false, await: 'rejoin', input: manifest({}) });
    const own: AdvanceOptions = { ...options, steps: stepRegistry([record, kexec, reboot]) };
    const destructive = new Set(['node.reboot', 'boot.kexec']);
    const created: { scope: readonly { subject: string; kind: string }[]; reason: string }[] = [];
    const batchContext = {
      registry: { commandKind: (kind: string) => ({ kind, destructive: destructive.has(kind) }) as never },
      commands: {
        async createBatch(_tx: unknown, input: { scope: readonly { subject: string; kind: string }[]; reason: string }) {
          created.push(input);
          return { batchId: `batch_${created.length}`, held: true, required: 2, size: input.scope.length };
        },
      } as never,
    };
    profile({ id: 'batch-reboot', steps: [{ use: 'test.record' }, { use: 'node.reboot' }] });
    const target = await addNode();
    const { id } = await db.transaction((tx) =>
      startWorkflow(context(), own, tx, { tenantId: 'ten_a', profileId: 'batch-reboot', profileVersion: 1, nodeId: target }),
    );
    expect(await db.transaction((tx) => batchNodeWorkflow(batchContext, tx, id, { tenantId: 'ten_a', nodeId: target, reason: 'r' }))).toBe('batch_1');
    expect(created[0]!.scope).toEqual([{ subject: target, kind: 'node.reboot' }]);
    // Idempotent: the workflow keeps its batch.
    expect(await db.transaction((tx) => batchNodeWorkflow(batchContext, tx, id, { tenantId: 'ten_a', nodeId: target, reason: 'r' }))).toBe('batch_1');
    expect(created).toHaveLength(1);
    // A relayed destructive kind needs its owner's scope.
    destructive.add('bmc.power');
    await db.query(`UPDATE workflows SET batch_id = NULL, command_kinds = '{bmc.power}' WHERE id = $1`, [id]);
    await expect(db.transaction((tx) => batchNodeWorkflow(batchContext, tx, id, { tenantId: 'ten_a', nodeId: target, reason: 'r' }))).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('refuses retries on a step that is not retry-safe, in a profile and in a step definition', async () => {
    const doc = defineProfile({
      id: 'unsafe-retries',
      version: 1,
      target: 'metal',
      steps: [
        { use: 'test.once', retries: 2 },
        { use: 'test.record', retries: 2 },
        { use: 'test.once', retries: 0, onFailure: { use: 'test.once', retries: 1 } },
      ],
      cleanup: [{ use: 'boot.kexec', retries: 1 }],
    });
    const { issues } = await expandProfile(doc, registry);
    expect(issues).toEqual([
      { path: 'steps[0].retries', message: expect.stringMatching(/test\.once is not retry-safe.*retries: 2/) },
      { path: 'steps[2].onFailure.retries', message: expect.stringMatching(/test\.once is not retry-safe/) },
      { path: 'cleanup[0].retries', message: expect.stringMatching(/boot\.kexec is not retry-safe/) },
    ]);
    stored.set('unsafe-retries@1', doc);
    await expect(start('unsafe-retries')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/not retry-safe/) });
    const { extension: _stamp, ...input } = once;
    expect(() => defineStep({ ...input, retries: 1 })).toThrow(/retries.*retrySafe/);
    expect(() => defineStep({ ...input, retries: 0 })).not.toThrow();
  });

  it('evaluates when: against node labels', () => {
    const labels = { 'gpu.model': 'H100', nvswitch: 'true', 'mig.capable': 'false' };
    expect(evaluateWhen('nvswitch', labels)).toBe(true);
    expect(evaluateWhen('mig.capable', labels)).toBe(false);
    expect(evaluateWhen('!mig.capable && gpu.model=H100', labels)).toBe(true);
    expect(evaluateWhen('gpu.model!=H100', labels)).toBe(false);
    expect(evaluateWhen('   ', labels)).toBe(false);
  });
});

describe('running a workflow', () => {
  it('runs control-plane steps in the worker and agent steps as exactly one command each', async () => {
    profile({
      id: 'happy',
      steps: [
        { use: 'test.record', with: { label: 'first' } },
        { use: 'power.setPower', on: 'site', with: { action: 'cycle' } },
        { use: 'test.record', with: { label: 'last' } },
      ],
    });
    const { id } = await start('happy');
    expect(wakes).toEqual([{ key: `workflow:${node}` }]);

    const first = await advance(id);
    expect(first.done).toBe(false);
    expect(ran).toEqual(['first#0']);
    const waiting = await steps(id);
    expect(waiting.map((s) => s.state)).toEqual(['succeeded', 'waiting', 'pending']);
    const command = await db.query<{ kind: string; idempotency_key: string; body: Uint8Array }>(
      'SELECT kind, idempotency_key, body FROM commands WHERE id = $1',
      [waiting[1]!.command_id],
    );
    expect(command.rows[0]).toMatchObject({ kind: 'driver.invoke', idempotency_key: `wf:${id}:main.2` });
    expect(JSON.parse(new TextDecoder().decode(command.rows[0]!.body))).toMatchObject({
      workflowId: id,
      stepId: 'main.2',
      args: { concern: 'power', operation: 'setPower', args: { action: 'cycle' } },
    });
    expect(first.wakeAt).toBeGreaterThan(now);

    // Nothing changes until the command settles.
    await advance(id);
    expect((await steps(id))[1]!.state).toBe('waiting');
    await settleCommand(waiting[1]!.command_id!, 'succeeded');
    const done = await advance(id);
    expect(done.done).toBe(true);
    expect(ran).toEqual(['first#0', 'last#0']);
    expect(await workflow(id)).toMatchObject({ state: 'succeeded', outcome: null });
    expect(events.map((e) => e.type)).toEqual([
      'workflow.created',
      'workflow.started',
      'workflow.step.started',
      'workflow.step.succeeded',
      'workflow.step.started',
      'workflow.step.succeeded',
      'workflow.step.started',
      'workflow.step.succeeded',
      'workflow.succeeded',
    ]);
  });

  it('allows one active workflow per node', async () => {
    profile({ id: 'one', steps: [{ use: 'test.record' }] });
    await start('one');
    await expect(start('one')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(start('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('retries a failed command under a new idempotency key, then fails the workflow after cleanup', async () => {
    profile({
      id: 'retries',
      steps: [{ use: 'power.setPower', on: 'site', retries: 1 }, { use: 'test.record', with: { label: 'never' } }],
      cleanup: [{ use: 'test.record', with: { label: 'cleanup' } }],
    });
    const { id } = await start('retries');
    await advance(id);
    const [firstTry] = await steps(id);
    await settleCommand(firstTry!.command_id!, 'failed', 'BMC unreachable');
    await advance(id);
    const [secondTry] = await steps(id);
    expect(secondTry).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(secondTry!.command_id).not.toBe(firstTry!.command_id);
    const key = await db.query<{ idempotency_key: string }>('SELECT idempotency_key FROM commands WHERE id = $1', [secondTry!.command_id]);
    expect(key.rows[0]!.idempotency_key).toBe(`wf:${id}:main.1#1`);

    await settleCommand(secondTry!.command_id!, 'failed', 'BMC unreachable');
    const result = await advance(id);
    expect(result.done).toBe(true);
    expect(ran).toEqual(['cleanup#0']);
    expect(await states(id)).toEqual({ 'main.1': 'failed', 'main.2': 'cancelled', 'cleanup.1': 'succeeded' });
    expect(await workflow(id)).toMatchObject({
      state: 'failed',
      error: { code: 'COMMAND_FAILED', message: 'main.1 (power.setPower): BMC unreachable' },
    });
    expect(events.filter((e) => e.type.startsWith('workflow.step.')).map((e) => e.type)).toContain('workflow.step.retrying');
  });

  it('never retries a step that is not retry-safe, whatever its row says (a workflow from before the check)', async () => {
    profile({ id: 'once', steps: [{ use: 'test.once' }] });
    const { id } = await start('once');
    await db.query('UPDATE workflow_steps SET retries = 2 WHERE workflow_id = $1', [id]);
    expect((await advance(id)).done).toBe(true);
    expect(ran).toEqual(['once#0']);
    expect(await steps(id)).toMatchObject([{ state: 'failed', attempt: 0 }]);
    expect(await workflow(id)).toMatchObject({ state: 'failed', error: { message: expect.stringMatching(/half done/) } });
    expect(events.map((e) => e.type)).not.toContain('workflow.step.retrying');
  });

  it('continues past a failed step with onFailure: continue, and skips steps whose when: is false', async () => {
    await db.query(`INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, 'nvswitch', 'false', 'inventory')`, [node]);
    profile({
      id: 'continue',
      steps: [
        { use: 'test.record', with: { label: 'bad', fail: true }, onFailure: 'continue' },
        { use: 'test.record', with: { label: 'fm' }, when: 'nvswitch' },
        { use: 'test.record', with: { label: 'ok' } },
      ],
    });
    const { id } = await start('continue');
    expect((await advance(id)).done).toBe(true);
    expect(ran).toEqual(['bad#0', 'ok#0']);
    expect(await states(id)).toEqual({ 'main.1': 'failed', 'main.2': 'skipped', 'main.3': 'succeeded' });
    expect((await workflow(id)).state).toBe('succeeded');
  });
});

describe("await: 'rejoin'", () => {
  it('completes on a new boot even though the command itself never succeeds', async () => {
    profile({ id: 'kexec-ok', steps: [{ use: 'boot.kexec' }, { use: 'test.record', with: { label: 'after' } }] });
    const { id } = await start('kexec-ok');
    await advance(id);
    const [step] = await steps(id);
    expect(step!.state).toBe('waiting');
    // The old boot's command expires: that is not a failure for a self-terminating step.
    await settleCommand(step!.command_id!, 'expired');
    await advance(id);
    expect((await steps(id))[0]!.state).toBe('waiting');

    await db.query(`UPDATE node_sessions SET boot_id = 'boot-2', role = 'node', connected_at = compute_now() WHERE node_id = $1`, [node]);
    expect((await advance(id)).done).toBe(true);
    expect(await states(id)).toEqual({ 'main.1': 'succeeded', 'main.2': 'succeeded' });
    const result = await db.query<{ result: unknown }>(`SELECT result FROM workflow_steps WHERE workflow_id = $1 AND id = 'main.1'`, [id]);
    expect(result.rows[0]!.result).toEqual({ bootId: 'boot-2', role: 'node' });
  });

  it('fires onFailure only on rejoin timeout, then fails the workflow', async () => {
    profile({
      id: 'kexec-timeout',
      steps: [{ use: 'boot.kexec', timeout: '15m', onFailure: { use: 'test.record', with: { label: 'reset' } } }],
    });
    const { id } = await start('kexec-timeout');
    await advance(id);
    await tick(14 * 60_000);
    await advance(id);
    expect(ran).toEqual([]);
    await tick(2 * 60_000);
    expect((await advance(id)).done).toBe(true);
    expect(ran).toEqual(['reset#0']);
    expect(await states(id)).toEqual({ 'main.1': 'failed', 'main.1.on-failure': 'succeeded' });
    expect(await workflow(id)).toMatchObject({ state: 'failed', error: { code: 'REJOIN_TIMEOUT' } });
  });
});

describe('timeouts and not-ready steps', () => {
  it('cancels a command that outlives its step timeout', async () => {
    profile({ id: 'slow', steps: [{ use: 'power.setPower', on: 'site', timeout: '1m' }] });
    const { id } = await start('slow');
    await advance(id);
    const [step] = await steps(id);
    await tick(61_000);
    expect((await advance(id)).done).toBe(true);
    const command = await db.query<{ state: string }>('SELECT state FROM commands WHERE id = $1', [step!.command_id]);
    expect(command.rows[0]!.state).toBe('cancelled');
    expect(await workflow(id)).toMatchObject({ state: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('cancels the commands a control-plane step relayed when it times out', async () => {
    profile({ id: 'slow-relay', steps: [{ use: 'test.relayed', timeout: '1m' }] });
    const { id } = await start('slow-relay');
    await advance(id);
    expect(await stepCommands(id)).toEqual({ [`wf:${id}:main.1#0:entry`]: 'pending', [`wf:${id}:main.1#0:wipe`]: 'pending' });
    // Another step's command whose key only starts alike (main.10 is not main.1) is not this step's.
    await db.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested, idempotency_key)
       VALUES ($1, $2, 999, 'disk.wipe', ''::bytea, 'pending', compute_now() + interval '1 hour', false, false, false, $3)`,
      [`cmd_other_${id}`, node, `wf:${id}:main.10#0:wipe`],
    );
    await tick(61_000);
    expect((await advance(id)).done).toBe(true);
    expect(await workflow(id)).toMatchObject({ state: 'failed', error: { code: 'TIMEOUT' } });
    expect(await stepCommands(id)).toEqual({
      [`wf:${id}:main.1#0:entry`]: 'cancelled',
      [`wf:${id}:main.1#0:wipe`]: 'cancelled',
      [`wf:${id}:main.10#0:wipe`]: 'pending',
    });
  });

  it('re-runs a not-ready control-plane step later, until it is ready', async () => {
    profile({ id: 'not-ready', steps: [{ use: 'test.record', with: { label: 'poll' } }] });
    notReadyUntil = Date.now() + 60_000;
    const { id } = await start('not-ready');
    const first = await advance(id);
    expect(first.done).toBe(false);
    expect(first.wakeAt).toBe(now + 1_000);
    expect((await steps(id))[0]!.state).toBe('running');
    notReadyUntil = 0;
    expect((await advance(id)).done).toBe(true);
    expect(ran).toEqual(['poll#0', 'poll#0']);
  });

  it('lets a step wait for an operator outside its timeout (stepWaiting), and times it again once it goes on', async () => {
    profile({ id: 'operator', steps: [{ use: 'test.decided', timeout: '1m' }] });
    const run = async () => {
      const { id } = await start('operator', await addNode());
      operatorWait = now + 24 * 3_600_000;
      afterWait = 'not-ready';
      const first = await advance(id);
      expect(first).toMatchObject({ done: false, wakeAt: now + 15_000 });
      // Hours later (and a worker that was away meanwhile): still waiting, not a timeout.
      await tick(5 * 3_600_000);
      expect((await advance(id)).done).toBe(false);
      expect((await steps(id))[0]).toMatchObject({ state: 'running' });
      return id;
    };
    // The operator decides; the step goes on and finishes.
    let id = await run();
    operatorWait = undefined;
    afterWait = 'done';
    expect((await advance(id)).done).toBe(true);
    expect(await workflow(id)).toMatchObject({ state: 'succeeded' });
    // Or it goes on and then hangs: its one minute counts from there.
    id = await run();
    operatorWait = undefined;
    expect((await advance(id)).done).toBe(false);
    await tick(59_000);
    expect((await advance(id)).done).toBe(false);
    await tick(2_000);
    expect((await advance(id)).done).toBe(true);
    expect(await workflow(id)).toMatchObject({ state: 'failed', error: { code: 'TIMEOUT' } });
    // And nobody ever decides: past `until` plus the timeout it is a timeout after all.
    id = await run();
    await tick(19 * 3_600_000 + 61_000);
    expect((await advance(id)).done).toBe(true);
    expect(await workflow(id)).toMatchObject({ state: 'failed', error: { code: 'TIMEOUT' } });
    operatorWait = undefined;
    afterWait = 'done';
  });

  it('resumes a control-plane step that was running when a worker crashed', async () => {
    profile({ id: 'crash', steps: [{ use: 'test.record', with: { label: 'resumed' } }] });
    const { id } = await start('crash');
    // What a crashed worker leaves behind: the step marked running, never settled.
    await db.query(`UPDATE workflows SET state = 'running' WHERE id = $1`, [id]);
    await db.query(
      `UPDATE workflow_steps SET state = 'running', started_at = compute_now(), deadline = compute_now() + interval '1 minute'
        WHERE workflow_id = $1`,
      [id],
    );
    expect((await advance(id)).done).toBe(true);
    expect(ran).toEqual(['resumed#0']);
  });
});

describe('commands held for their batch approval (§13)', () => {
  const hold = (key: string) =>
    db.query(`UPDATE commands SET not_before = 'infinity', not_after = compute_now() + interval '24 hours' WHERE idempotency_key = $1`, [key]);
  const release = (key: string) => db.query(`UPDATE commands SET not_before = compute_now() WHERE idempotency_key = $1`, [key]);

  it('does not time out an agent step whose command is held, and counts its timeout from the release', async () => {
    profile({ id: 'held-agent', steps: [{ use: 'power.setPower', on: 'site', timeout: '1m' }] });
    const { id } = await start('held-agent');
    await advance(id);
    const key = `wf:${id}:main.1`;
    await hold(key);
    // Approvers take hours: the step neither times out nor cancels the command.
    for (const wait of [61_000, 6 * 3_600_000, 3_600_000]) {
      await tick(wait);
      expect((await advance(id)).done).toBe(false);
    }
    expect(await stepCommands(id)).toEqual({ [key]: 'pending' });
    expect((await steps(id))[0]).toMatchObject({ state: 'waiting' });
    // Approved just before the look-again time: the step has its whole timeout from the release.
    await tick(59_000);
    await release(key);
    await tick(2_000);
    expect((await advance(id)).done).toBe(false);
    expect(await stepCommands(id)).toEqual({ [key]: 'pending' });
    await tick(57_000);
    expect((await advance(id)).done).toBe(false);
    // One minute after the release with no result: now it is a timeout.
    await tick(2_000);
    expect((await advance(id)).done).toBe(true);
    expect(await stepCommands(id)).toEqual({ [key]: 'cancelled' });
    expect(await workflow(id)).toMatchObject({ state: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('does not time out a control-plane step whose relayed command is held, and finishes once it ran', async () => {
    profile({ id: 'held-relay', steps: [{ use: 'test.relayed', timeout: '1m' }] });
    const { id } = await start('held-relay');
    await advance(id);
    const key = `wf:${id}:main.1#0:wipe`;
    await hold(key);
    await tick(61_000);
    expect((await advance(id)).done).toBe(false);
    await tick(5 * 3_600_000);
    expect((await advance(id)).done).toBe(false);
    expect((await stepCommands(id))[key]).toBe('pending');
    await release(key);
    await tick(30_000);
    await db.query(`UPDATE commands SET state = 'succeeded' WHERE idempotency_key = $1`, [key]);
    expect((await advance(id)).done).toBe(true);
    expect(await workflow(id)).toMatchObject({ state: 'succeeded' });
  });

  it('gives a held command the lifetime of its batch, and an approved or absent batch the usual one', async () => {
    await db.migrate([quorumMigration]);
    const batch = (batchId: string, state: string, required: number) =>
      db.query(
        `INSERT INTO command_batches (id, tenant_id, reason, scope_root, scope_size, required, not_after, state)
         VALUES ($1, 'ten_a', 'r', decode(repeat('00', 32), 'hex'), 1, $3, compute_now() + interval '24 hours', $2)`,
        [batchId, state, required],
      );
    await batch('batch_held', 'pending', 2);
    await batch('batch_approved', 'approved', 2);
    await batch('batch_audit', 'pending', 0);
    const wipe = defineStep({ id: 'disk.wipe', runsOn: 'ramdisk', command: 'disk.wipe', timeout: '5m', retrySafe: false, input: manifest({}) });
    const own: AdvanceOptions = { ...options, steps: stepRegistry([record, relayed, wipe]) };
    const destructive = { ...context(), registry: { commandKind: (kind: string) => ({ kind, destructive: kind === 'disk.wipe' }) } } as never as ReturnType<typeof context>;
    profile({ id: 'held-lifetime', steps: [{ use: 'test.relayed', timeout: '1m' }, { use: 'disk.wipe' }] });
    const lifetimes: Record<string, number[]> = {};
    for (const batchId of ['batch_held', 'batch_approved', 'batch_audit']) {
      const target = await addNode();
      const { id } = await db.transaction((tx) =>
        startWorkflow(destructive, own, tx, { tenantId: 'ten_a', profileId: 'held-lifetime', profileVersion: 1, nodeId: target, batchId }),
      );
      await advanceWorkflow(destructive, own, id);
      // The relayed wipe went out (awaitCommand); let it succeed so the agent step sends its own.
      await db.query(`UPDATE commands SET state = 'succeeded' WHERE idempotency_key = ANY($1)`, [[`wf:${id}:main.1#0:wipe`, `wf:${id}:main.1#0:entry`]]);
      await advanceWorkflow(destructive, own, id);
      const { rows } = await db.query<{ seconds: string }>(
        `SELECT round(extract(epoch FROM not_after - compute_now()))::text AS seconds FROM commands
          WHERE idempotency_key = ANY($1) ORDER BY idempotency_key`,
        [[`wf:${id}:main.1#0:wipe`, `wf:${id}:main.2`]],
      );
      lifetimes[batchId] = rows.map((row) => Number(row.seconds));
    }
    // [awaitCommand's wipe, the agent step's wipe]: 24 h while held; else 10 min and the step's 5 min.
    expect(lifetimes).toEqual({ batch_held: [86_400, 86_400], batch_approved: [600, 300], batch_audit: [600, 300] });
  });
});

describe('operator verbs', () => {
  it('aborts mid-step: cancels the command, runs cleanup, ends cancelled', async () => {
    profile({
      id: 'abort',
      steps: [{ use: 'power.setPower', on: 'site' }, { use: 'test.record', with: { label: 'never' } }],
      cleanup: [{ use: 'test.record', with: { label: 'cleanup' } }],
    });
    const { id } = await start('abort');
    await advance(id);
    const [step] = await steps(id);
    await db.transaction((tx) => abortWorkflow(context(), tx, id, { reason: 'operator' }));
    expect((await db.query<{ state: string }>('SELECT state FROM commands WHERE id = $1', [step!.command_id])).rows[0]!.state).toBe('cancelled');
    expect((await advance(id)).done).toBe(true);
    expect(ran).toEqual(['cleanup#0']);
    expect(await states(id)).toEqual({ 'main.1': 'cancelled', 'main.2': 'cancelled', 'cleanup.1': 'succeeded' });
    expect(await workflow(id)).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED', message: 'operator' } });
    // Twice is fine.
    await db.transaction((tx) => abortWorkflow(context(), tx, id));
  });

  it('aborts a control-plane step: every command it relayed is cancelled, in flight or not', async () => {
    profile({ id: 'abort-relay', steps: [{ use: 'test.relayed' }], cleanup: [{ use: 'test.record', with: { label: 'cleanup' } }] });
    const { id } = await start('abort-relay');
    await advance(id);
    expect((await steps(id))[0]).toMatchObject({ state: 'running', command_id: null });
    // The site agent took its command; the machine (a ramdisk that is reconnecting) has not seen the wipe yet.
    await db.query(`UPDATE commands SET state = 'dispatched' WHERE idempotency_key = $1`, [`wf:${id}:main.1#0:entry`]);
    await db.transaction((tx) => abortWorkflow(context(), tx, id, { reason: 'operator' }));
    expect(await stepCommands(id)).toEqual({ [`wf:${id}:main.1#0:entry`]: 'cancelled', [`wf:${id}:main.1#0:wipe`]: 'cancelled' });
    expect((await advance(id)).done).toBe(true);
    expect(await workflow(id)).toMatchObject({ state: 'cancelled' });
    expect(await states(id)).toEqual({ 'main.1': 'cancelled', 'cleanup.1': 'succeeded' });
  });

  it('refuses a command from a step that was aborted while it ran', async () => {
    profile({ id: 'abort-late', steps: [{ use: 'test.late' }] });
    const { id } = await start('abort-late');
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const running = new Promise<void>((resolve) => (gated = resolve));
    lateEnqueue = undefined;
    const advancing = advance(id);
    await running;
    await db.transaction((tx) => abortWorkflow(context(), tx, id, { reason: 'operator' }));
    open();
    await advancing;
    gated = undefined;
    expect(lateEnqueue).toMatchObject({ code: 'INVALID_STATE' });
    expect(await stepCommands(id)).toEqual({});
  });

  it('pauses between steps and resumes', async () => {
    profile({ id: 'pause', steps: [{ use: 'power.setPower', on: 'site' }, { use: 'test.record', with: { label: 'after' } }] });
    const { id } = await start('pause');
    await advance(id);
    await db.transaction((tx) => pauseWorkflow(context(), tx, id));
    const [step] = await steps(id);
    await settleCommand(step!.command_id!, 'succeeded');
    expect((await advance(id)).done).toBe(true);
    // The step in flight settled, but nothing new started.
    expect(await states(id)).toEqual({ 'main.1': 'succeeded', 'main.2': 'pending' });
    expect((await workflow(id)).state).toBe('paused');
    await db.transaction((tx) => resumeWorkflow(context(), tx, id));
    expect((await advance(id)).done).toBe(true);
    expect((await workflow(id)).state).toBe('succeeded');
  });

  it('retries a failed workflow from the failed step with the next attempt', async () => {
    profile({
      id: 'retry-from',
      steps: [{ use: 'test.record', with: { label: 'one' } }, { use: 'power.setPower', on: 'site' }],
    });
    const { id } = await start('retry-from');
    await advance(id);
    const failedCommand = (await steps(id))[1]!.command_id!;
    await settleCommand(failedCommand, 'rejected', 'unsupported');
    await advance(id);
    expect((await workflow(id)).state).toBe('failed');

    await db.transaction((tx) => retryWorkflow(context(), tx, id));
    await advance(id);
    const retried = (await steps(id))[1]!;
    expect(retried).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(retried.command_id).not.toBe(failedCommand);
    await settleCommand(retried.command_id!, 'succeeded');
    expect((await advance(id)).done).toBe(true);
    expect((await workflow(id)).state).toBe('succeeded');
    // Step one kept its success and did not run again.
    expect(ran).toEqual(['one#0']);
    await expect(db.transaction((tx) => retryWorkflow(context(), tx, id))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('routing and owners', () => {
  it('sends site steps to the site agent, naming the target node', async () => {
    profile({ id: 'site-route', steps: [{ use: 'power.setPower', on: 'site' }] });
    const { id } = await start('site-route');
    await advance(id);
    const [step] = await steps(id);
    const command = await db.query<{ node_id: string; body: Uint8Array }>('SELECT node_id, body FROM commands WHERE id = $1', [step!.command_id]);
    expect(command.rows[0]!.node_id).toBe(SITE_AGENT);
    expect(JSON.parse(new TextDecoder().decode(command.rows[0]!.body))).toMatchObject({ targetNodeId: node });
  });

  it('waits for a site agent, and fails with NO_SITE_AGENT at the deadline', async () => {
    await db.query(`UPDATE node_sessions SET disconnected_at = compute_now() + interval '1 second' WHERE node_id = $1`, [SITE_AGENT]);
    try {
      profile({ id: 'no-agent', steps: [{ use: 'power.setPower', on: 'site', timeout: '1m' }] });
      const { id } = await start('no-agent');
      const first = await advance(id);
      expect(first.done).toBe(false);
      expect((await steps(id))[0]).toMatchObject({ state: 'running', command_id: null });
      await tick(61_000);
      expect((await advance(id)).done).toBe(true);
      expect(await workflow(id)).toMatchObject({ state: 'failed', error: { code: 'NO_SITE_AGENT' } });
    } finally {
      await db.query(`UPDATE node_sessions SET disconnected_at = NULL, connected_at = compute_now() WHERE node_id = $1`, [SITE_AGENT]);
    }
  });

  it('queues the owning module when a workflow finishes, and snapshots the profile', async () => {
    profile({ id: 'owned', steps: [{ use: 'test.record' }] });
    const { id } = await db.transaction((tx) =>
      startWorkflow(context(), options, tx, { tenantId: 'ten_a', profileId: 'owned', profileVersion: 1, nodeId: node, owner: 'metal' }),
    );
    wakes.length = 0;
    expect((await advance(id)).done).toBe(true);
    expect(wakes).toContainEqual({ key: `metal:${node}` });
    const snapshot = await db.query<{ profile_document: { id: string } }>('SELECT profile_document FROM workflows WHERE id = $1', [id]);
    expect(snapshot.rows[0]!.profile_document.id).toBe('owned');
  });
});

describe('provisionModule', () => {
  it('registers migrations, the reconciler, built-in steps and the engine', async () => {
    const module = provisionModule({ steps: [record], profiles: [defineProfile({ id: 'shipped', version: 1, target: 'metal', steps: [{ use: 'test.record' }] })] });
    expect(module.name).toBe('provision');
    expect(module.migrations!.map((m) => m.name)).toEqual([
      'provision/0001_workflows',
      'provision/0002_images',
      'provision/0003_workflow_owner',
      'provision/0004_gated_mig_layout',
      'provision/0005_image_pins',
      'provision/0006_workflow_batch',
    ]);
    expect(module.reconcilers!.map((r) => [r.name, r.shardBy])).toEqual([
      ['workflow', 'node'],
      ['provision.site-cache', 'none'],
      ['health', 'node'],
    ]);
    expect(module.engineOptions.steps.get('wait.agentJoined')).toBeDefined();
    expect(() => provisionModule({ steps: [record, record] })).toThrow(/registered twice/);

    const ctx = { ...context(), events: eventLog, work } as unknown as ModuleContext;
    const engine = module.workflowEngine(ctx);
    const { id } = await db.transaction((tx) =>
      engine.start(tx, { tenantId: 'ten_a', profileId: 'shipped', profileVersion: 1, nodeId: node }),
    );
    expect(await module.reconcilers![0]!.run({ ...ctx, signal: new AbortController().signal }, node)).toBe('DONE');
    expect((await workflow(id)).state).toBe('succeeded');
  });

  it('waits for the agent with wait.agentJoined', async () => {
    const module = provisionModule({ profiles: [defineProfile({ id: 'join', version: 1, target: 'metal', steps: [{ use: 'wait.agentJoined', with: { role: 'node' } }] })] });
    const ctx = { ...context(), events: eventLog, work } as unknown as ModuleContext;
    const { id } = await db.transaction((tx) =>
      module.workflowEngine(ctx).start(tx, { tenantId: 'ten_a', profileId: 'join', profileVersion: 1, nodeId: node }),
    );
    const run = () => module.reconcilers![0]!.run({ ...ctx, signal: new AbortController().signal }, node);
    wakes.length = 0;
    await run();
    expect((await workflow(id)).state).toBe('running');
    expect(wakes.at(-1)).toEqual({ key: `workflow:${node}`, notBefore: now + 5_000 });
    await db.query(`UPDATE node_sessions SET role = 'node', boot_id = 'boot-9' WHERE node_id = $1`, [node]);
    await run();
    expect((await workflow(id)).state).toBe('succeeded');
  });
});
