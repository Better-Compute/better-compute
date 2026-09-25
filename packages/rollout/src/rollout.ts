import { createHash } from 'node:crypto';
import {
  ComputeError,
  draftId,
  newId,
  type DaemonSpec,
  type ModuleContext,
  type NodeRecord,
  type SqlTx,
} from '@better-compute/core';
import { PROTOCOL_VERSION } from '@better-compute/protocol';
import {
  releaseBinaries,
  verifyReleaseManifest,
  type ReleaseArtifact,
  type ReleaseManifest,
  type ReleaseTrust,
  type SignedReleaseManifest,
} from '@better-compute/pki';

// The Rollout controller (PLAN.md §6 "Self-update (v0.4)"): a signed bcd release goes out in waves
// (1% → 10% → 50% → 100% by default) within each pool's disruption budget. A node is told the new
// version through `NodeSpec.daemon`; bcd verifies it, swaps A/B slots and rejoins with the new
// `daemon_version`, which completes it. Too many failures in a wave pause the rollout; between
// waves it soaks. Abort can roll nodes back to the version they ran before.

export type RolloutState = 'running' | 'paused' | 'completed' | 'aborted';
export type RolloutNodeState =
  | 'pending'
  | 'upgrading'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'rolling-back'
  | 'rolled-back';

export interface DaemonRelease {
  version: string;
  product: string;
  sequence: number;
  /** Platform (`linux-amd64`) → the bare binary's entry. */
  binaries: Record<string, ReleaseArtifact>;
  expiresAt: number;
  registeredBy: string;
  registeredAt: number;
}

export interface RolloutGates {
  /** Waves as cumulative percentages of the rollout's nodes (default [1, 10, 50, 100]). */
  waves: number[];
  /** A wave pauses the rollout when failed / (succeeded + failed) exceeds this (default 0.05). */
  maxFailureRatio: number;
  /** Wait after a wave's last node reached the target before starting the next (default 600). */
  soakSeconds: number;
  /** A node that has not reported the target version by then failed (default 900). */
  upgradeTimeoutSeconds: number;
}

export const defaultGates: RolloutGates = {
  waves: [1, 10, 50, 100],
  maxFailureRatio: 0.05,
  soakSeconds: 600,
  upgradeTimeoutSeconds: 900,
};

export interface Rollout extends RolloutGates {
  id: string;
  tenantId: string;
  version: string;
  state: RolloutState;
  /** Absent: every pool the tenant owns. */
  poolIds?: string[];
  wave: number;
  waveStartedAt: number;
  waveDoneAt?: number;
  rollback: boolean;
  reason?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Node counts by state. */
  nodes: Record<RolloutNodeState, number>;
}

/** The share of a pool that may be disrupted at once unless `pools.policy.disruptionBudget` says. */
export const defaultDisruptionBudget = 0.05;

const time = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? undefined : new Date(value).getTime();
const parse = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

async function tableExists(tx: SqlTx, table: string): Promise<boolean> {
  const { rows } = await tx.query<{ found: string | null }>(
    'SELECT to_regclass($1)::text AS found',
    [table],
  );
  return Boolean(rows[0]?.found);
}

/**
 * The daemon version each node last reported in Hello (`node_sessions.daemon_version`). Until that
 * column exists nothing is known, so nodes never complete: safe, never wrong.
 */
export async function reportedVersions(
  tx: SqlTx,
  nodeIds: readonly string[],
): Promise<Map<string, string>> {
  if (!nodeIds.length) return new Map();
  const column = await tx.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'node_sessions' AND column_name = 'daemon_version'`,
  );
  if (!column.rows.length) return new Map();
  const { rows } = await tx.query<{ node_id: string; daemon_version: string | null }>(
    'SELECT node_id, daemon_version FROM node_sessions WHERE node_id = ANY($1::text[])',
    [nodeIds],
  );
  return new Map(
    rows
      .filter((row) => row.daemon_version)
      .map((row) => [row.node_id, row.daemon_version!.replace(/^v/, '')]),
  );
}

// --- Releases ------------------------------------------------------------------------------------

interface ReleaseRow {
  version: string;
  product: string;
  sequence: string | number;
  binaries: unknown;
  expires_at: Date | string;
  registered_by: string;
  registered_at: Date | string;
}

const toRelease = (row: ReleaseRow): DaemonRelease => ({
  version: row.version,
  product: row.product,
  sequence: Number(row.sequence),
  binaries: parse<Record<string, ReleaseArtifact>>(row.binaries),
  expiresAt: time(row.expires_at)!,
  registeredBy: row.registered_by,
  registeredAt: time(row.registered_at)!,
});

export async function readRelease(tx: SqlTx, version: string): Promise<DaemonRelease | undefined> {
  const { rows } = await tx.query<ReleaseRow>('SELECT * FROM daemon_releases WHERE version = $1', [
    version.replace(/^v/, ''),
  ]);
  return rows[0] ? toRelease(rows[0]) : undefined;
}

/**
 * `DaemonSection.signature` for a registered release: the UTF-8 JSON of its SignedReleaseManifest
 * (`{ manifest, signatures }`, as registered), base64 for the wire's bytes. bcd takes a binary only
 * with it: it verifies the manifest against its own release pins, then that it names this version
 * and lists the section's sha256 for its platform, so a compromised control plane cannot push a
 * binary of its own.
 */
export async function releaseSignature(tx: SqlTx, version: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ manifest: unknown }>(
    'SELECT manifest FROM daemon_releases WHERE version = $1',
    [version.replace(/^v/, '')],
  );
  if (!rows[0]) return undefined;
  return Buffer.from(JSON.stringify(parse<SignedReleaseManifest>(rows[0].manifest)), 'utf8').toString(
    'base64',
  );
}

export async function listReleases(tx: SqlTx): Promise<DaemonRelease[]> {
  const { rows } = await tx.query<ReleaseRow>(
    'SELECT * FROM daemon_releases ORDER BY sequence DESC',
  );
  return rows.map(toRelease);
}

/**
 * Verifies a signed bcd manifest under the release pins and records it. The sequence may never go
 * backwards (a rollback of the release channel); registering the same manifest again is a no-op.
 */
export async function registerRelease(
  tx: SqlTx,
  signed: SignedReleaseManifest,
  options: { trust: ReleaseTrust; identityId: string; now: number },
): Promise<DaemonRelease> {
  const { rows: latest } = await tx.query<{ sequence: string | number }>(
    'SELECT max(sequence) AS sequence FROM daemon_releases',
  );
  const floor =
    latest[0]?.sequence === null || latest[0]?.sequence === undefined
      ? 0
      : Number(latest[0].sequence);
  let manifest: ReleaseManifest;
  try {
    manifest = verifyReleaseManifest(signed, options.trust, {
      product: 'bcd',
      clock: { now: () => options.now },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ACCESS_DENIED')
      throw new ComputeError('INVALID_INPUT', (error as Error).message, undefined, {
        reason: (error as { details?: { reason?: string } }).details?.reason,
      });
    throw error;
  }
  const version = manifest.version.replace(/^v/, '');
  const existing = await readRelease(tx, version);
  if (existing) {
    if (existing.sequence !== manifest.sequence)
      throw new ComputeError('CONFLICT', `bcd ${version} is registered with another sequence`);
    return existing;
  }
  // A new release must move the channel forward: an older sequence is a rollback.
  if (manifest.sequence <= floor)
    throw new ComputeError(
      'INVALID_INPUT',
      `sequence ${manifest.sequence} is not above the latest registered ${floor} (rollback)`,
      undefined,
      { reason: 'rollback' },
    );
  const { binaries, ambiguous } = releaseBinaries(manifest);
  if (ambiguous.length)
    throw new ComputeError(
      'INVALID_INPUT',
      `The manifest lists several binaries for ${ambiguous.join(', ')}`,
    );
  if (!Object.keys(binaries).some((platform) => platform.startsWith('linux-')))
    throw new ComputeError('INVALID_INPUT', 'The manifest lists no linux binary');
  const { rows } = await tx.query<ReleaseRow>(
    `INSERT INTO daemon_releases (version, product, sequence, manifest, binaries, expires_at, registered_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, to_timestamp($6 / 1000.0), $7)
     RETURNING *`,
    [
      version,
      manifest.product,
      manifest.sequence,
      JSON.stringify(signed),
      JSON.stringify(binaries),
      manifest.expiresAt,
      options.identityId,
    ],
  );
  return toRelease(rows[0]!);
}

// --- Rollouts ------------------------------------------------------------------------------------

interface RolloutRow {
  id: string;
  tenant_id: string;
  version: string;
  state: RolloutState;
  pool_ids: unknown;
  waves: unknown;
  wave: number;
  wave_started_at: Date | string;
  wave_done_at: Date | string | null;
  max_failure_ratio: number;
  soak_seconds: number;
  upgrade_timeout_seconds: number;
  rollback: boolean;
  reason: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const nodeStates: readonly RolloutNodeState[] = [
  'pending',
  'upgrading',
  'succeeded',
  'failed',
  'skipped',
  'rolling-back',
  'rolled-back',
];

async function toRollout(tx: SqlTx, row: RolloutRow): Promise<Rollout> {
  const counts = await tx.query<{ state: RolloutNodeState; count: number }>(
    'SELECT state, count(*)::int AS count FROM rollout_nodes WHERE rollout_id = $1 GROUP BY state',
    [row.id],
  );
  const nodes = Object.fromEntries(nodeStates.map((state) => [state, 0])) as Record<
    RolloutNodeState,
    number
  >;
  for (const count of counts.rows) nodes[count.state] = count.count;
  const rollout: Rollout = {
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    state: row.state,
    waves: parse<number[]>(row.waves),
    wave: row.wave,
    waveStartedAt: time(row.wave_started_at)!,
    maxFailureRatio: Number(row.max_failure_ratio),
    soakSeconds: row.soak_seconds,
    upgradeTimeoutSeconds: row.upgrade_timeout_seconds,
    rollback: row.rollback,
    createdBy: row.created_by,
    createdAt: time(row.created_at)!,
    updatedAt: time(row.updated_at)!,
    nodes,
  };
  const pools = parse<string[] | null>(row.pool_ids);
  if (pools) rollout.poolIds = pools;
  if (row.wave_done_at) rollout.waveDoneAt = time(row.wave_done_at)!;
  if (row.reason) rollout.reason = row.reason;
  return rollout;
}

export async function readRollout(
  tx: SqlTx,
  tenantId: string,
  rolloutId: string,
  lock = false,
): Promise<Rollout | undefined> {
  const { rows } = await tx.query<RolloutRow>(
    `SELECT * FROM rollouts WHERE id = $1 AND tenant_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [rolloutId, tenantId],
  );
  return rows[0] ? toRollout(tx, rows[0]) : undefined;
}

export async function listRollouts(tx: SqlTx, tenantId: string): Promise<Rollout[]> {
  const { rows } = await tx.query<RolloutRow>(
    'SELECT * FROM rollouts WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100',
    [tenantId],
  );
  return Promise.all(rows.map((row) => toRollout(tx, row)));
}

export interface RolloutNode {
  nodeId: string;
  poolId: string;
  wave: number;
  state: RolloutNodeState;
  fromVersion?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export async function readRolloutNodes(tx: SqlTx, rolloutId: string): Promise<RolloutNode[]> {
  const { rows } = await tx.query<{
    node_id: string;
    pool_id: string;
    wave: number;
    state: RolloutNodeState;
    from_version: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    error: string | null;
  }>('SELECT * FROM rollout_nodes WHERE rollout_id = $1 ORDER BY ordinal', [rolloutId]);
  return rows.map((row) => ({
    nodeId: row.node_id,
    poolId: row.pool_id,
    wave: row.wave,
    state: row.state,
    ...(row.from_version ? { fromVersion: row.from_version } : {}),
    ...(row.started_at ? { startedAt: time(row.started_at)! } : {}),
    ...(row.finished_at ? { finishedAt: time(row.finished_at)! } : {}),
    ...(row.error ? { error: row.error } : {}),
  }));
}

/** The wave (index) of the node at `ordinal` among `total`, by cumulative percentages. */
export function waveOf(ordinal: number, total: number, waves: readonly number[]): number {
  for (const [index, percent] of waves.entries()) {
    // Every wave holds at least one more node than the one before, while nodes remain.
    const upTo = Math.max(Math.ceil((total * percent) / 100), index + 1);
    if (ordinal < upTo) return index;
  }
  return waves.length - 1;
}

export function checkGates(input: Partial<RolloutGates>): RolloutGates {
  const gates = { ...defaultGates, ...input };
  const { waves } = gates;
  if (
    !Array.isArray(waves) ||
    waves.length < 1 ||
    waves.length > 10 ||
    waves.some(
      (percent, index) =>
        !Number.isInteger(percent) ||
        percent < 1 ||
        percent > 100 ||
        (index > 0 && percent <= waves[index - 1]!),
    ) ||
    waves.at(-1) !== 100
  )
    throw new ComputeError('INVALID_INPUT', 'waves must be increasing percentages ending at 100');
  if (!(gates.maxFailureRatio >= 0 && gates.maxFailureRatio <= 1))
    throw new ComputeError('INVALID_INPUT', 'maxFailureRatio must be between 0 and 1');
  if (
    !Number.isInteger(gates.soakSeconds) ||
    gates.soakSeconds < 0 ||
    gates.soakSeconds > 7 * 86400
  )
    throw new ComputeError('INVALID_INPUT', 'soakSeconds must be 0 to 604800');
  if (
    !Number.isInteger(gates.upgradeTimeoutSeconds) ||
    gates.upgradeTimeoutSeconds < 60 ||
    gates.upgradeTimeoutSeconds > 86400
  )
    throw new ComputeError('INVALID_INPUT', 'upgradeTimeoutSeconds must be 60 to 86400');
  return gates;
}

export interface CreateRolloutInput extends Partial<RolloutGates> {
  tenantId: string;
  version: string;
  poolIds?: string[];
  idempotencyKey?: string;
}

/**
 * Plans a rollout: every desired-state node of the tenant's pools in scope, shuffled by a hash of
 * the rollout id so canaries spread across pools, assigned to waves. Nodes already on the version
 * start `succeeded`. A node in another active rollout makes this `CONFLICT` (one writer per node).
 */
export async function createRollout(
  context: Pick<ModuleContext, 'events'>,
  tx: SqlTx,
  input: CreateRolloutInput,
  identityId: string,
): Promise<Rollout> {
  const gates = checkGates(input);
  const version = input.version.replace(/^v/, '');
  const release = await readRelease(tx, version);
  if (!release) throw new ComputeError('NOT_FOUND', `bcd ${version} is not registered`);
  const id = input.idempotencyKey
    ? await draftId('rollout', input.tenantId, identityId, input.idempotencyKey)
    : newId('rollout');
  if (input.idempotencyKey) {
    const existing = await readRollout(tx, input.tenantId, id);
    if (existing) {
      if (existing.version !== version)
        throw new ComputeError('CONFLICT', 'This idempotency key was used for a different rollout');
      return existing;
    }
  }
  const pools = await tx.query<{ id: string }>(
    `SELECT id FROM pools WHERE owner_tenant_id = $1 ${input.poolIds ? 'AND id = ANY($2::text[])' : ''}
       AND (to_jsonb(pools) ->> 'archived_at') IS NULL ORDER BY id`,
    input.poolIds ? [input.tenantId, input.poolIds] : [input.tenantId],
  );
  if (input.poolIds) {
    const found = new Set(pools.rows.map((row) => row.id));
    const missing = input.poolIds.filter((poolId) => !found.has(poolId));
    if (missing.length) throw new ComputeError('NOT_FOUND', `Pool ${missing[0]} not found`);
  }
  const { rows: nodes } = await tx.query<{ id: string; pool_id: string }>(
    `SELECT id, pool_id FROM nodes WHERE pool_id = ANY($1::text[]) AND generation > 0 ORDER BY id`,
    [pools.rows.map((row) => row.id)],
  );
  if (!nodes.length) throw new ComputeError('INVALID_STATE', 'No node in scope runs bcd yet');
  const busy = await tx.query<{ node_id: string; rollout_id: string }>(
    `SELECT rn.node_id, rn.rollout_id FROM rollout_nodes rn JOIN rollouts r ON r.id = rn.rollout_id
      WHERE r.state IN ('running', 'paused') AND rn.node_id = ANY($1::text[]) LIMIT 1`,
    [nodes.map((node) => node.id)],
  );
  if (busy.rows[0])
    throw new ComputeError(
      'CONFLICT',
      `Node ${busy.rows[0].node_id} is in active rollout ${busy.rows[0].rollout_id}`,
      undefined,
      { rolloutId: busy.rows[0].rollout_id },
    );
  const order = [...nodes].sort((a, b) => {
    const ha = createHash('sha256').update(`${id}:${a.id}`).digest('hex');
    const hb = createHash('sha256').update(`${id}:${b.id}`).digest('hex');
    return ha < hb ? -1 : 1;
  });
  await tx.query(
    `INSERT INTO rollouts (id, tenant_id, version, state, pool_ids, waves, max_failure_ratio,
                           soak_seconds, upgrade_timeout_seconds, created_by, idempotency_key)
     VALUES ($1, $2, $3, 'running', $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
    [
      id,
      input.tenantId,
      version,
      input.poolIds ? JSON.stringify(input.poolIds) : null,
      JSON.stringify(gates.waves),
      gates.maxFailureRatio,
      gates.soakSeconds,
      gates.upgradeTimeoutSeconds,
      identityId,
      input.idempotencyKey ?? null,
    ],
  );
  const versions = await reportedVersions(
    tx,
    order.map((node) => node.id),
  );
  for (const [ordinal, node] of order.entries()) {
    const current = versions.get(node.id);
    const done = current === version;
    await tx.query(
      `INSERT INTO rollout_nodes (rollout_id, node_id, pool_id, wave, ordinal, state, from_version, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'succeeded' THEN compute_now() END)`,
      [
        id,
        node.id,
        node.pool_id,
        waveOf(ordinal, order.length, gates.waves),
        ordinal,
        done ? 'succeeded' : 'pending',
        current ?? null,
      ],
    );
  }
  await context.events.publish(tx, {
    type: 'rollout.started',
    tenantId: input.tenantId,
    subject: `rollout/${id}`,
    data: { version, nodes: order.length, waves: gates.waves },
  });
  return (await readRollout(tx, input.tenantId, id))!;
}

/** Pauses, resumes or aborts (optionally rolling upgraded nodes back to their previous version). */
export async function changeRollout(
  context: Pick<ModuleContext, 'events' | 'desired'>,
  tx: SqlTx,
  input: {
    tenantId: string;
    rolloutId: string;
    action: 'pause' | 'resume' | 'abort';
    reason?: string;
    rollback?: boolean;
  },
): Promise<Rollout> {
  const rollout = await readRollout(tx, input.tenantId, input.rolloutId, true);
  if (!rollout) throw new ComputeError('NOT_FOUND', `Rollout ${input.rolloutId} not found`);
  const active = rollout.state === 'running' || rollout.state === 'paused';
  if (!active) throw new ComputeError('INVALID_STATE', `Rollout ${rollout.id} is ${rollout.state}`);
  const set = async (state: RolloutState, reason: string | null, rollback = rollout.rollback) =>
    tx.query(
      'UPDATE rollouts SET state = $2, reason = $3, rollback = $4, updated_at = compute_now() WHERE id = $1',
      [rollout.id, state, reason, rollback],
    );
  if (input.action === 'pause') {
    await set('paused', input.reason ?? 'paused by an operator');
  } else if (input.action === 'resume') {
    await set('running', null);
  } else {
    await set('aborted', input.reason ?? 'aborted by an operator', input.rollback === true);
    // Nodes not started stay where they are; with rollback, upgraded ones go back.
    await tx.query(
      `UPDATE rollout_nodes SET state = 'skipped', error = 'aborted', finished_at = compute_now()
        WHERE rollout_id = $1 AND state = 'pending'`,
      [rollout.id],
    );
    const moved = input.rollback
      ? await tx.query<{ node_id: string }>(
          `UPDATE rollout_nodes rn SET state = 'rolling-back', started_at = compute_now(), finished_at = NULL
            WHERE rn.rollout_id = $1 AND rn.state IN ('upgrading', 'succeeded')
              AND rn.from_version IS NOT NULL
              AND EXISTS (SELECT 1 FROM daemon_releases d WHERE d.version = rn.from_version)
            RETURNING rn.node_id`,
          [rollout.id],
        )
      : await tx.query<{ node_id: string }>(
          // Without rollback, an upgrade in flight stops: the node keeps what it runs.
          `UPDATE rollout_nodes SET state = 'failed', error = 'aborted', finished_at = compute_now()
            WHERE rollout_id = $1 AND state = 'upgrading' RETURNING node_id`,
          [rollout.id],
        );
    for (const row of moved.rows) await context.desired.invalidate(tx, row.node_id);
  }
  await context.events.publish(tx, {
    type: `rollout.${input.action === 'abort' ? 'aborted' : input.action === 'pause' ? 'paused' : 'resumed'}`,
    tenantId: rollout.tenantId,
    subject: `rollout/${rollout.id}`,
    data: { version: rollout.version, ...(input.reason ? { reason: input.reason } : {}) },
  });
  return (await readRollout(tx, input.tenantId, rollout.id))!;
}

// --- The controller ------------------------------------------------------------------------------

export interface AdvanceOutcome {
  state: RolloutState;
  wave: number;
  started: string[];
  succeeded: string[];
  failed: string[];
  skipped: string[];
  /** Why nothing more started now (`budget`, `soak`, `paused`, …). */
  waiting?: string;
}

interface PoolLoad {
  nodes: number;
  disrupted: number;
  budget: number;
}

/**
 * The shared disruption view (agreed with provision's remediation): in pool P, a node is disrupted
 * while it has an active workflow or a rollout upgrade/rollback in flight. Each side reads the
 * other's table only when it exists.
 */
async function poolLoads(tx: SqlTx, poolIds: readonly string[]): Promise<Map<string, PoolLoad>> {
  if (!poolIds.length) return new Map();
  const workflows = await tableExists(tx, 'workflows');
  const { rows } = await tx.query<{
    pool_id: string;
    nodes: number;
    disrupted: number;
    budget: number | null;
  }>(
    `SELECT p.id AS pool_id,
            (SELECT count(*)::int FROM nodes n WHERE n.pool_id = p.id) AS nodes,
            (SELECT count(*)::int FROM nodes n WHERE n.pool_id = p.id AND (
               EXISTS (SELECT 1 FROM rollout_nodes rn JOIN rollouts r ON r.id = rn.rollout_id
                        WHERE rn.node_id = n.id AND rn.state IN ('upgrading', 'rolling-back'))
               ${
                 workflows
                   ? `OR EXISTS (SELECT 1 FROM workflows w WHERE w.node_id = n.id
                                 AND w.state IN ('pending', 'running', 'paused'))`
                   : ''
               })) AS disrupted,
            (p.policy ->> 'disruptionBudget')::float8 AS budget
       FROM pools p WHERE p.id = ANY($1::text[])`,
    [poolIds],
  );
  return new Map(
    rows.map((row) => [
      row.pool_id,
      {
        nodes: row.nodes,
        disrupted: row.disrupted,
        budget:
          row.budget !== null && row.budget >= 0 && row.budget <= 1
            ? row.budget
            : defaultDisruptionBudget,
      },
    ]),
  );
}

/**
 * One controller pass over a rollout, in `tx` with the rollout row locked: settles nodes in flight
 * (target version reported → succeeded; timeout → failed), applies the failure gate, soaks and
 * advances waves, and starts pending nodes of the current wave within each pool's budget.
 */
export async function advanceRollout(
  context: Pick<ModuleContext, 'events' | 'desired'> & Partial<Pick<ModuleContext, 'commands'>>,
  tx: SqlTx,
  rolloutId: string,
  /**
   * With `downloadsUrl`, daemons restricted to upgrades (`proto_max` below `protoMin`, default the
   * server's `PROTOCOL_VERSION.min`) also get a `daemon.upgrade` command.
   */
  options: { downloadsUrl?: string; protoMin?: number } = {},
): Promise<AdvanceOutcome | undefined> {
  const { rows } = await tx.query<RolloutRow & { now: Date }>(
    'SELECT r.*, compute_now() AS now FROM rollouts r WHERE r.id = $1 FOR UPDATE',
    [rolloutId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const now = row.now.getTime();
  const outcome: AdvanceOutcome = {
    state: row.state,
    wave: row.wave,
    started: [],
    succeeded: [],
    failed: [],
    skipped: [],
  };
  if (row.state === 'completed') return outcome;
  const publish = (type: string, data: Record<string, unknown>) =>
    context.events.publish(tx, {
      type,
      tenantId: row.tenant_id,
      subject: `rollout/${row.id}`,
      data: { version: row.version, ...data } as never,
    });

  // 1. Settle nodes in flight.
  const { rows: flying } = await tx.query<{
    node_id: string;
    state: RolloutNodeState;
    from_version: string | null;
    started_at: Date;
  }>(
    `SELECT node_id, state, from_version, started_at FROM rollout_nodes
      WHERE rollout_id = $1 AND state IN ('upgrading', 'rolling-back') ORDER BY ordinal`,
    [row.id],
  );
  const versions = await reportedVersions(
    tx,
    flying.map((node) => node.node_id),
  );
  const timeoutMs = row.upgrade_timeout_seconds * 1000;
  for (const node of flying) {
    const target = node.state === 'upgrading' ? row.version : node.from_version;
    const reported = versions.get(node.node_id);
    if (reported !== undefined && reported === target) {
      await tx.query(
        `UPDATE rollout_nodes SET state = $3, finished_at = compute_now() WHERE rollout_id = $1 AND node_id = $2`,
        [row.id, node.node_id, node.state === 'upgrading' ? 'succeeded' : 'rolled-back'],
      );
      outcome.succeeded.push(node.node_id);
    } else if (now - node.started_at.getTime() >= timeoutMs) {
      await tx.query(
        `UPDATE rollout_nodes SET state = 'failed', finished_at = compute_now(), error = $3
          WHERE rollout_id = $1 AND node_id = $2`,
        [row.id, node.node_id, node.state === 'upgrading' ? 'timeout' : 'rollback-timeout'],
      );
      // The node goes back to its previous version (NodeSpec follows the node's state).
      await context.desired.invalidate(tx, node.node_id);
      outcome.failed.push(node.node_id);
    }
  }
  if (row.state !== 'running') {
    outcome.waiting = row.state;
    return outcome;
  }

  // 2. The failure gate for the current wave.
  const { rows: wave } = await tx.query<{
    state: RolloutNodeState;
    count: number;
    last: Date | null;
  }>(
    `SELECT state, count(*)::int AS count, max(finished_at) AS last FROM rollout_nodes
      WHERE rollout_id = $1 AND wave = $2 GROUP BY state`,
    [row.id, row.wave],
  );
  const count = (state: RolloutNodeState) =>
    wave.find((entry) => entry.state === state)?.count ?? 0;
  const failed = count('failed');
  const succeeded = count('succeeded');
  if (failed > 0 && failed / (succeeded + failed) > Number(row.max_failure_ratio)) {
    const reason = `failure gate: ${failed} of ${succeeded + failed} node(s) in wave ${row.wave + 1} failed`;
    await tx.query(
      `UPDATE rollouts SET state = 'paused', reason = $2, updated_at = compute_now() WHERE id = $1`,
      [row.id, reason],
    );
    await publish('rollout.paused', { reason, wave: row.wave, failed, succeeded });
    outcome.state = 'paused';
    outcome.waiting = 'failure-gate';
    return outcome;
  }

  // 3. A finished wave soaks from its last node's finish, then the next wave (or the end) begins.
  const open = count('pending') + count('upgrading');
  const waves = parse<number[]>(row.waves);
  if (open === 0) {
    const last = Math.max(0, ...wave.map((entry) => entry.last?.getTime() ?? 0));
    if (now - last < row.soak_seconds * 1000) {
      if (!row.wave_done_at)
        await tx.query(
          'UPDATE rollouts SET wave_done_at = to_timestamp($2 / 1000.0) WHERE id = $1',
          [row.id, last || now],
        );
      outcome.waiting = 'soak';
      return outcome;
    }
    if (row.wave + 1 >= waves.length) {
      await tx.query(
        `UPDATE rollouts SET state = 'completed', wave_done_at = COALESCE(wave_done_at, compute_now()),
                             updated_at = compute_now() WHERE id = $1`,
        [row.id],
      );
      await publish('rollout.completed', {});
      outcome.state = 'completed';
      return outcome;
    }
    await tx.query(
      `UPDATE rollouts SET wave = wave + 1, wave_started_at = compute_now(), wave_done_at = NULL,
                           updated_at = compute_now() WHERE id = $1`,
      [row.id],
    );
    outcome.wave = row.wave + 1;
    await publish('rollout.wave', { wave: row.wave + 1, percent: waves[row.wave + 1] });
    row.wave += 1;
  }

  // 4. Start pending nodes of the current wave within each pool's disruption budget.
  const { rows: pending } = await tx.query<{
    node_id: string;
    pool_id: string;
    connectivity: string | null;
    present: boolean;
  }>(
    `SELECT rn.node_id, rn.pool_id, n.connectivity, n.id IS NOT NULL AS present
       FROM rollout_nodes rn LEFT JOIN nodes n ON n.id = rn.node_id
      WHERE rn.rollout_id = $1 AND rn.wave = $2 AND rn.state = 'pending' ORDER BY rn.ordinal`,
    [row.id, row.wave],
  );
  const loads = await poolLoads(tx, [...new Set(pending.map((node) => node.pool_id))]);
  const current = await reportedVersions(
    tx,
    pending.map((node) => node.node_id),
  );
  for (const node of pending) {
    const skip = async (error: string) => {
      await tx.query(
        `UPDATE rollout_nodes SET state = 'skipped', error = $3, finished_at = compute_now()
          WHERE rollout_id = $1 AND node_id = $2`,
        [row.id, node.node_id, error],
      );
      outcome.skipped.push(node.node_id);
    };
    if (!node.present) {
      await skip('node-gone');
      continue;
    }
    if (node.connectivity !== 'connected') {
      // An offline node gets the release's version as the pool default once the rollout completes.
      await skip('offline');
      continue;
    }
    if (current.get(node.node_id) === row.version) {
      await tx.query(
        `UPDATE rollout_nodes SET state = 'succeeded', finished_at = compute_now()
          WHERE rollout_id = $1 AND node_id = $2`,
        [row.id, node.node_id],
      );
      outcome.succeeded.push(node.node_id);
      continue;
    }
    const load = loads.get(node.pool_id);
    const allowed = load ? Math.max(1, Math.floor(load.nodes * load.budget)) : 1;
    if (load && load.disrupted >= allowed) {
      outcome.waiting = 'budget';
      continue;
    }
    await tx.query(
      `UPDATE rollout_nodes SET state = 'upgrading', started_at = compute_now(), from_version = $3
        WHERE rollout_id = $1 AND node_id = $2`,
      [row.id, node.node_id, current.get(node.node_id) ?? null],
    );
    if (load) load.disrupted += 1;
    await context.desired.invalidate(tx, node.node_id);
    if (options.downloadsUrl && context.commands)
      await nudgeRestricted(
        { commands: context.commands },
        tx,
        {
          nodeId: node.node_id,
          rolloutId: row.id,
          version: row.version,
          now,
          timeoutMs,
          protoMin: options.protoMin ?? PROTOCOL_VERSION.min,
        },
        options.downloadsUrl,
      );
    outcome.started.push(node.node_id);
  }
  return outcome;
}

/**
 * A daemon below the server's `proto_min` gets `Welcome.upgrade_required` and accepts only
 * `daemon.upgrade` (§7.6), so it would never apply `NodeSpec.daemon`: send it the same target as a
 * command. Known from `node_sessions.proto_max` (core/0008); unknown means "not restricted".
 */
async function nudgeRestricted(
  context: Pick<ModuleContext, 'commands'>,
  tx: SqlTx,
  input: {
    nodeId: string;
    rolloutId: string;
    version: string;
    now: number;
    timeoutMs: number;
    protoMin: number;
  },
  downloadsUrl: string,
): Promise<boolean> {
  const column = await tx.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'node_sessions' AND column_name = 'proto_max'`,
  );
  if (!column.rows.length) return false;
  const { rows } = await tx.query<{ proto_max: number | null; arch: string | null }>(
    `SELECT s.proto_max,
            (SELECT l.value FROM node_labels l WHERE l.node_id = s.node_id AND l.key = 'cpu.arch') AS arch
       FROM node_sessions s WHERE s.node_id = $1`,
    [input.nodeId],
  );
  const session = rows[0];
  if (!session || session.proto_max === null || session.proto_max >= input.protoMin) return false;
  const platform = platformOf({
    labels: session.arch ? [{ key: 'cpu.arch', value: session.arch, source: 'inventory' }] : [],
  } as unknown as Pick<NodeRecord, 'labels'>);
  const binary = platform ? (await readRelease(tx, input.version))?.binaries[platform] : undefined;
  if (!platform || !binary) return false;
  const signature = await releaseSignature(tx, input.version);
  await context.commands.enqueue(tx, {
    nodeId: input.nodeId,
    kind: 'daemon.upgrade',
    // proto3 JSON of DaemonSection: bytes as base64.
    payload: {
      version: input.version,
      url: `${downloadsUrl.replace(/\/+$/, '')}/bcd/${input.version}/${platform}`,
      sha256: Buffer.from(binary.sha256, 'hex').toString('base64'),
      ...(signature ? { signature } : {}),
    },
    idempotencyKey: `rollout:${input.rolloutId}:${input.nodeId}`,
    notAfter: input.now + input.timeoutMs,
  });
  return true;
}

// --- NodeSpec ------------------------------------------------------------------------------------

const arches: Readonly<Record<string, string>> = {
  x86_64: 'amd64',
  amd64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64',
};

/** The node's platform (`linux-amd64`) from its `cpu.arch` label. */
export function platformOf(node: Pick<NodeRecord, 'labels'>): string | undefined {
  const arch = node.labels.find((label) => label.key === 'cpu.arch')?.value;
  const normal = arch ? arches[arch.toLowerCase()] : undefined;
  return normal ? `linux-${normal}` : undefined;
}

/**
 * The version a node should run: its row in the latest rollout that touched it (the rollout's
 * version while upgrading or done; its previous version after a failure or rollback); otherwise
 * the version of the latest completed rollout covering its pool. Undefined: leave bcd alone.
 */
export async function targetVersion(tx: SqlTx, node: NodeRecord): Promise<string | undefined> {
  const { rows } = await tx.query<{
    state: RolloutNodeState;
    from_version: string | null;
    version: string;
  }>(
    `SELECT rn.state, rn.from_version, r.version FROM rollout_nodes rn JOIN rollouts r ON r.id = rn.rollout_id
      WHERE rn.node_id = $1 AND rn.state IN ('upgrading', 'succeeded', 'failed', 'rolling-back', 'rolled-back')
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [node.id],
  );
  const own = rows[0];
  if (own) {
    if (own.state === 'upgrading' || own.state === 'succeeded') return own.version;
    return own.from_version ?? undefined;
  }
  if (!node.poolId) return undefined;
  const { rows: defaults } = await tx.query<{ version: string }>(
    `SELECT r.version FROM rollouts r JOIN pools p ON p.owner_tenant_id = r.tenant_id
      WHERE p.id = $1 AND r.state = 'completed'
        AND (r.pool_ids IS NULL OR r.pool_ids ? $1)
      ORDER BY r.updated_at DESC, r.id DESC LIMIT 1`,
    [node.poolId],
  );
  return defaults[0]?.version;
}

/** `NodeSpec.daemon` for a node, or undefined (no rollout touched it, or no binary for it). */
export async function daemonSpecFor(
  tx: SqlTx,
  node: NodeRecord,
  downloadsUrl: string,
): Promise<DaemonSpec | undefined> {
  const version = await targetVersion(tx, node);
  if (!version) return undefined;
  const platform = platformOf(node);
  if (!platform) return undefined;
  const release = await readRelease(tx, version);
  const binary = release?.binaries[platform];
  if (!binary) return undefined;
  const signature = await releaseSignature(tx, version);
  return {
    version,
    url: `${downloadsUrl.replace(/\/+$/, '')}/bcd/${version}/${platform}`,
    sha256: binary.sha256,
    ...(signature ? { signature } : {}),
  };
}
