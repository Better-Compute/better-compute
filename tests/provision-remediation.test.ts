import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommandQueue, EventPublisher, ModuleContext, SqlExecutor, WorkQueue } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { recordXid } from '@better-compute/inventory';
import {
  abortWorkflow,
  provisionMigrations,
  provisionModule,
  reconcileHealth,
  type HealthOutcome,
} from '@better-compute/provision';

// Remediation (PLAN.md §10.1): node-level faults run as workflows within the pool's disruption
// budget, after the node drains, unless the pool's circuit breaker is open.

let db: SqlExecutor;
const provision = provisionModule();
const events: string[] = [];
const eventLog: EventPublisher = {
  async publish(_tx, event) {
    events.push(event.type);
  },
};
const work: WorkQueue = { async enqueue() {} };
let n = 0;
const commands: CommandQueue = {
  async enqueue(tx, command) {
    const existing = await tx.query<{ id: string }>('SELECT id FROM commands WHERE node_id = $1 AND idempotency_key = $2', [command.nodeId, command.idempotencyKey]);
    if (existing.rows[0]) return { id: existing.rows[0].id, seq: 0 };
    const id = `cmd_${++n}`;
    await tx.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', to_timestamp($6 / 1000.0), false, false, false, $7)`,
      [id, command.nodeId, n, command.kind, new TextEncoder().encode(JSON.stringify(command.payload)), command.notAfter, command.idempotencyKey],
    );
    return { id, seq: n };
  },
  async cancel() {},
};
let context: ModuleContext;
const sent: { kind: string; payload: Record<string, unknown> }[] = [];

/** A healthy node agent: reboots rejoin with a new boot, everything else succeeds. */
async function agent(fail = false) {
  const { rows } = await db.query<{ id: string; node_id: string; kind: string; body: Uint8Array }>(`SELECT id, node_id, kind, body FROM commands WHERE state = 'pending'`);
  for (const command of rows) {
    sent.push({ kind: command.kind, payload: JSON.parse(new TextDecoder().decode(command.body)) });
    if (command.kind === 'node.reboot' && !fail)
      await db.query(`UPDATE node_sessions SET boot_id = $2, connected_at = compute_now() WHERE node_id = $1`, [command.node_id, `boot-${command.id}`]);
    await db.query('UPDATE commands SET state = $2 WHERE id = $1', [command.id, fail ? 'failed' : 'succeeded']);
  }
}
/** Runs the workflow reconciler and the agent until the node's workflows settle. */
async function runWorkflows(nodeId: string, fail = false) {
  for (let i = 0; i < 20; i++) {
    await provision.reconcilers![0]!.run({ ...context, signal: new AbortController().signal } as never, nodeId);
    await agent(fail);
    const active = await db.query(`SELECT 1 FROM workflows WHERE node_id = $1 AND state IN ('pending', 'running', 'paused')`, [nodeId]);
    if (!active.rowCount) return;
  }
}
async function addNode(pool: string, id: string) {
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
       generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_r', $2, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [id, pool],
  );
  await db.query(`INSERT INTO node_sessions (node_id, session_epoch, boot_id, role, connected_at) VALUES ($1, 1, 'boot-0', 'node', compute_now())`, [id]);
  await db.query(
    `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1 || '-gpu0', $1, 'gpu', true, true, '{}')`,
    [id],
  );
}
async function pool(id: string, nodes: number): Promise<string[]> {
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, 'root', 'site_r', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [id],
  );
  const ids = Array.from({ length: nodes }, (_, i) => `node_${id}_${i}`);
  for (const nodeId of ids) await addNode(id, nodeId);
  return ids;
}
const xid = (nodeId: string, value: number) => db.transaction((tx) => recordXid(tx, nodeId, { gpuUuid: `${nodeId}-gpu0`, xid: value }));
const nodeRow = async (id: string) =>
  (await db.query<{ no_schedule_reasons: string[]; maintenance: boolean }>('SELECT no_schedule_reasons, maintenance FROM nodes WHERE id = $1', [id])).rows[0]!;

beforeAll(async () => {
  db = pglite();
  await db.migrate(provisionMigrations);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_r', 'root', 'shared', 'eu', 1)`);
  const base = { sql: db, work, events: eventLog, commands };
  context = { ...base, workflows: provision.workflowEngine(base as never) } as unknown as ModuleContext;
});
afterAll(() => db.close());
beforeEach(() => {
  events.length = 0;
  sent.length = 0;
});

describe('remediation', () => {
  it('reboots a node after XID 79, then clears the fault and its NoSchedule', async () => {
    const [node] = await pool('p_reboot', 30);
    await xid(node!, 79);
    expect((await nodeRow(node!)).no_schedule_reasons).toEqual(['Xid79']);
    const started = await reconcileHealth(context, node!);
    expect(started).toMatchObject({ action: 'started', remediation: 'reboot' });
    expect(await reconcileHealth(context, node!)).toEqual({ action: 'waiting', reason: 'remediating' });
    await runWorkflows(node!);
    expect(sent.map((c) => c.kind)).toEqual(['node.reboot']);
    expect(sent[0]!.payload).toEqual({ reason: 'health remediation', delayMs: 1000 });
    expect(await reconcileHealth(context, node!)).toEqual({ action: 'cleared', conditions: ['Xid79'] });
    expect((await nodeRow(node!)).no_schedule_reasons).toEqual([]);
    expect(await reconcileHealth(context, node!)).toEqual({ action: 'healthy' });
    expect(events).toEqual(expect.arrayContaining(['node.remediation.started', 'node.remediation.succeeded']));
  });

  it('resets the GPUs with a pending row remap and asks for fresh inventory', async () => {
    const [node] = await pool('p_reset', 30);
    await xid(node!, 63);
    expect(await reconcileHealth(context, node!)).toMatchObject({ action: 'started', remediation: 'gpu-reset' });
    await runWorkflows(node!);
    expect(sent.map((c) => [c.kind, c.payload])).toEqual([
      ['gpu.reset', { gpuUuids: [`${node}-gpu0`] }],
      ['inventory.refresh', { sections: ['gpus'], rescan: true }],
    ]);
    // The row remap clears with the next inventory; until then a retry is allowed, then escalation.
    expect((await reconcileHealth(context, node!)).action).toBe('started');
    await runWorkflows(node!);
    expect(await reconcileHealth(context, node!)).toMatchObject({ action: 'escalated' });
    expect((await nodeRow(node!)).maintenance).toBe(true);
  });

  it('waits for the node to drain', async () => {
    const [node] = await pool('p_drain', 30);
    await db.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
       VALUES ('alloc_drain', 'ten', 'p_drain', $1, 'reservation', 'rsv_x', tstzrange(compute_now() - interval '1 hour', compute_now() + interval '1 hour'), 1)`,
      [node],
    );
    await xid(node!, 95);
    expect(await reconcileHealth(context, node!)).toEqual({ action: 'waiting', reason: 'draining' });
    await db.query(`UPDATE allocations SET released_at = compute_now() WHERE id = 'alloc_drain'`);
    expect((await reconcileHealth(context, node!)).action).toBe('started');
  });

  it('keeps within the disruption budget', async () => {
    const [a, b] = await pool('p_budget', 20); // 5% of 20 = 1 node at a time
    await xid(a!, 79);
    await xid(b!, 79);
    expect((await reconcileHealth(context, a!)).action).toBe('started');
    expect(await reconcileHealth(context, b!)).toEqual({ action: 'waiting', reason: 'budget' });
    await runWorkflows(a!);
    expect((await reconcileHealth(context, b!)).action).toBe('started');
  });

  it("honours the pool's own disruption budget", async () => {
    const nodes = await pool('p_budget_policy', 20);
    await db.query(`UPDATE pools SET policy = '{"disruptionBudget": 0.1}' WHERE id = 'p_budget_policy'`); // 2 of 20
    for (const nodeId of nodes.slice(0, 3)) await xid(nodeId, 48);
    await xid(nodes[0]!, 79);
    await xid(nodes[1]!, 79);
    // The breaker counts Xid48 too; lift those to test the budget alone.
    await db.query(`UPDATE node_conditions SET status = 'false' WHERE type = 'Xid48' AND node_id = ANY($1)`, [nodes]);
    expect((await reconcileHealth(context, nodes[0]!)).action).toBe('started');
    expect((await reconcileHealth(context, nodes[1]!)).action).toBe('started');
  });

  it('opens the circuit breaker when more than 10% of a pool turns unhealthy within 10 minutes', async () => {
    const nodes = await pool('p_breaker', 20);
    // One unhealthy node of 20 (5%): remediate it.
    await xid(nodes[0]!, 79);
    expect((await reconcileHealth(context, nodes[0]!)).action).toBe('started');
    await runWorkflows(nodes[0]!);
    expect((await reconcileHealth(context, nodes[0]!)).action).toBe('cleared');
    // Then three more within the window (15% > 10%): the pool pauses remediation.
    await xid(nodes[1]!, 79);
    await xid(nodes[2]!, 79);
    await xid(nodes[3]!, 48);
    expect(await reconcileHealth(context, nodes[1]!)).toEqual({ action: 'waiting', reason: 'breaker' });
    expect(events).toContain('pool.remediation.paused');
  });

  it('escalates to maintenance when the remediation does not complete', async () => {
    const [node] = await pool('p_fail', 30);
    await xid(node!, 79);
    const started = await reconcileHealth(context, node!);
    if (started.action !== 'started') throw new Error(started.action);
    // A reboot step ignores its command's fate and fails only on rejoin timeout; an operator abort ends it here.
    await db.transaction((tx) => abortWorkflow(context as never, tx, started.workflowId));
    await runWorkflows(node!);
    const outcome: HealthOutcome = await reconcileHealth(context, node!);
    expect(outcome).toEqual({ action: 'escalated', reason: 'remediation cancelled' });
    expect(await nodeRow(node!)).toMatchObject({ maintenance: true, no_schedule_reasons: ['Xid79'] });
  });

  it('registers the health reconciler and its workflows, unless turned off', () => {
    expect(provision.reconcilers!.map((r) => r.name)).toEqual(['workflow', 'health']);
    expect(provision.engineOptions.steps.get('node.reboot')).toBeDefined();
    expect(provisionModule({ remediation: false }).reconcilers!.map((r) => r.name)).toEqual(['workflow']);
  });
});
