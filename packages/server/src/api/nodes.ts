import {
  ComputeError,
  defineMethod,
  provisionStateTable,
  transition,
  type Condition,
  type Connectivity,
  type ComputeEvent,
  type Json,
  type Label,
  type MethodContext,
  type MethodDefinition,
  type NodeRole,
  type NodeTrust,
  type ProvisionState,
  type SqlTx,
} from '@better-compute/core';
import { markAcceptanceRequested } from '../controllers/lifecycle.js';
import {
  drainingReason,
  drainWorkKind,
  nodeWorkKind,
  refreshNodeAuthz,
} from '../controllers/node-state.js';
import { defineListMethod, type ListRecipe } from '../list.js';
import { fields, int, limit, ms, notFound, page, visibleIn, type Page } from './common.js';
import { eventCursor, eventTypePrefix, readEvents } from './events.js';
import { parser, v } from './input.js';

// `nodes` (PLAN.md §9.2, module server): machines as their tenant sees them. Every method but `list`
// is decided on `compute-node/{id}`; a tenant sees the nodes the projection holds for it. Updates are
// guarded by `version` (optimistic concurrency, §8.3); a stale `version` is `CONFLICT`.

/** A node as `list` shows it. */
export interface NodeInfo {
  id: string;
  siteId: string;
  poolId?: string;
  ownerTenantId: string;
  role: NodeRole;
  provisionState: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  connectivity: Connectivity;
  trust: NodeTrust;
  /** NoSchedule taints and conditions (operator taints read `taint:<key>`). */
  noScheduleReasons: string[];
  hardwareKeyTrusted: boolean;
  generation: number;
  observedGeneration: number;
  /** Bumped by `revokeIdentity`: certificates of earlier generations are revoked. */
  identityGeneration: number;
  version: number;
}

/** A node as `get` shows it: labels, conditions and its session. */
export interface NodeDetail extends NodeInfo {
  labels: Label[];
  conditions: Condition[];
  session?: {
    epoch: number;
    gatewayId?: string;
    connectedAt?: number;
    disconnectedAt?: number;
    lastSeen?: number;
  };
}

/** One entry of a node's event stream (the outbox, oldest first). */
export type NodeEvent = ComputeEvent;

interface NodeRef {
  tenantId: string;
  nodeId: string;
}
export type GetNodeInput = NodeRef;
export interface NodeEventsInput extends NodeRef {
  /** Only events whose type starts with this (`node.`, `security.`). */
  type?: string;
  /** At most 200 (100 by default). */
  limit?: number;
  cursor?: string;
}
export interface ListNodesInput {
  tenantId: string;
  poolId?: string;
  siteId?: string;
  cordoned?: boolean;
  provisionState?: ProvisionState;
  /** At most 50 (the default). */
  limit?: number;
  cursor?: string;
}
export interface NodeChangeInput extends NodeRef {
  /** The version the caller last read; a node that changed since is `CONFLICT`. */
  version?: number;
  reason?: string;
}
export interface LabelNodeInput extends NodeRef {
  /** Operator labels to set; inventory and system labels cannot be overwritten. */
  set?: Record<string, string>;
  /** Operator labels to remove. */
  remove?: string[];
  version?: number;
}
export interface TaintNodeInput extends NodeRef {
  /** Operator taints (NoSchedule) to add, stored as `taint:<key>`. */
  add?: string[];
  remove?: string[];
  version?: number;
}
export interface RevokeIdentityResult {
  node: NodeInfo;
  revokedCertificates: number;
}

export type NodesApi = {
  nodes: {
    list: MethodDefinition<ListNodesInput, Page<NodeInfo>>;
    get: MethodDefinition<GetNodeInput, NodeDetail>;
    events: MethodDefinition<NodeEventsInput, Page<NodeEvent>>;
    cordon: MethodDefinition<NodeChangeInput, NodeInfo>;
    uncordon: MethodDefinition<NodeChangeInput, NodeInfo>;
    drain: MethodDefinition<NodeChangeInput, NodeInfo>;
    label: MethodDefinition<LabelNodeInput, NodeDetail>;
    taint: MethodDefinition<TaintNodeInput, NodeInfo>;
    adopt: MethodDefinition<NodeChangeInput, NodeInfo>;
    revokeIdentity: MethodDefinition<NodeChangeInput, RevokeIdentityResult>;
  };
};

/** Work-queue kinds (§8.4): the node reconciler's (NodeLifecycle), and the Drain controller's. */
const nodeWork = nodeWorkKind;
const taintPrefix = 'taint:';

// --- Inputs --------------------------------------------------------------------------------------

const labelKey = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/;
const labelValue = v.string({ pattern: /^[A-Za-z0-9._:/@+=-]*$/, max: 256 });
const taintKey = v.string({
  pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._/=:-]{0,126}[A-Za-z0-9])?$/,
  max: 128,
});
const provisionStates = provisionStateTable.states as unknown as readonly [
  ProvisionState,
  ...ProvisionState[],
];

const nodeRef = { tenantId: fields.tenantId, nodeId: fields.nodeId };
const getInput: (input: unknown) => GetNodeInput = parser(nodeRef);
const eventsInput: (input: unknown) => NodeEventsInput = parser({
  ...nodeRef,
  type: v.optional(eventTypePrefix),
  limit: limit(200, 100),
  cursor: v.optional(eventCursor),
});
const listInput: (input: unknown) => ListNodesInput = parser({
  tenantId: fields.tenantId,
  poolId: v.optional(fields.poolId),
  siteId: v.optional(fields.siteId),
  cordoned: v.optional(v.boolean()),
  provisionState: v.optional(v.option(provisionStates)),
  limit: limit(50),
  cursor: v.optional(fields.cursor),
});
const changeInput: (input: unknown) => NodeChangeInput = parser({
  ...nodeRef,
  version: v.optional(fields.version),
  reason: v.optional(fields.reason),
});
const parseLabel = parser({
  ...nodeRef,
  set: v.optional(v.record(labelKey, labelValue, { max: 64 })),
  remove: v.optional(v.list(v.string({ pattern: labelKey, max: 128 }), { max: 64, unique: true })),
  version: v.optional(fields.version),
});
function labelInput(input: unknown): LabelNodeInput {
  const parsed = parseLabel(input);
  const set = Object.keys(parsed.set ?? {});
  if (!set.length && !parsed.remove?.length)
    throw new ComputeError('INVALID_INPUT', 'Name labels to set or remove');
  if (set.some((key) => parsed.remove?.includes(key)))
    throw new ComputeError('INVALID_INPUT', 'A label cannot be set and removed at once');
  return parsed;
}
const parseTaint = parser({
  ...nodeRef,
  add: v.optional(v.list(taintKey, { max: 32, unique: true })),
  remove: v.optional(v.list(taintKey, { max: 32, unique: true })),
  version: v.optional(fields.version),
});
function taintInput(input: unknown): TaintNodeInput {
  const parsed = parseTaint(input);
  if (!parsed.add?.length && !parsed.remove?.length)
    throw new ComputeError('INVALID_INPUT', 'Name taints to add or remove');
  if (parsed.add?.some((key) => parsed.remove?.includes(key)))
    throw new ComputeError('INVALID_INPUT', 'A taint cannot be added and removed at once');
  return parsed;
}

// --- Rows ----------------------------------------------------------------------------------------

interface NodeRow {
  id: string;
  site_id: string;
  pool_id: string | null;
  owner_tenant_id: string;
  role: NodeRole;
  provision_state: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  connectivity: Connectivity;
  trust: NodeTrust;
  no_schedule_reasons: string[];
  hardware_key_trusted: boolean;
  generation: unknown;
  observed_generation: unknown;
  identity_gen: unknown;
  version: unknown;
}
const columns = `n.id, n.site_id, n.pool_id, n.owner_tenant_id, n.role, n.provision_state,
  n.maintenance, n.cordoned, n.connectivity, n.trust, n.no_schedule_reasons, n.hardware_key_trusted,
  n.generation, n.observed_generation, n.identity_gen, n.version`;

function toNode(row: NodeRow): NodeInfo {
  const node: NodeInfo = {
    id: row.id,
    siteId: row.site_id,
    ownerTenantId: row.owner_tenant_id,
    role: row.role,
    provisionState: row.provision_state,
    maintenance: row.maintenance,
    cordoned: row.cordoned,
    connectivity: row.connectivity,
    trust: row.trust,
    noScheduleReasons: [...(row.no_schedule_reasons ?? [])],
    hardwareKeyTrusted: row.hardware_key_trusted,
    generation: int(row.generation),
    observedGeneration: int(row.observed_generation),
    identityGeneration: int(row.identity_gen),
    version: int(row.version),
  };
  if (row.pool_id !== null) node.poolId = row.pool_id;
  return node;
}

async function visibleNode(
  tx: SqlTx,
  { tenantId, nodeId }: NodeRef,
  lock = '',
): Promise<NodeRow | undefined> {
  const { rows } = await tx.query<NodeRow>(
    `SELECT ${columns} FROM nodes n WHERE n.id = $2 AND ${visibleIn('node', 'n.id', '$1')} ${lock}`,
    [tenantId, nodeId],
  );
  return rows[0];
}

/** Locks a node for an update and checks the caller's `version`. */
async function lockNode(context: MethodContext, input: NodeChangeInput): Promise<NodeRow> {
  const row = await visibleNode(context.sql, input, 'FOR UPDATE OF n');
  if (!row) throw notFound('Node');
  if (input.version !== undefined && int(row.version) !== input.version)
    throw new ComputeError(
      'CONFLICT',
      `The node changed (it is at version ${int(row.version)})`,
      undefined,
      {
        version: int(row.version),
      },
    );
  return row;
}

/**
 * `UPDATE … WHERE id AND version` (§8.3), bumping the version; `sets` use `$3…` and may be empty
 * (labels live in their own table but still move the node's version). Zero rows is `CONFLICT`.
 */
async function updateNode(
  context: MethodContext,
  row: NodeRow,
  sets: string,
  params: readonly unknown[] = [],
): Promise<NodeRow> {
  const { rows } = await context.sql.query<NodeRow>(
    `UPDATE nodes n SET ${sets ? `${sets}, ` : ''}version = n.version + 1
     WHERE n.id = $1 AND n.version = $2 RETURNING ${columns}`,
    [row.id, row.version, ...params],
  );
  if (!rows[0]) throw new ComputeError('CONFLICT', 'The node changed meanwhile; read it again');
  return rows[0];
}

async function publish(
  context: MethodContext,
  tenantId: string,
  nodeId: string,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await context.events.publish(context.sql, {
    type,
    tenantId,
    subject: `node/${nodeId}`,
    data: { nodeId, ...data },
  });
}

async function detail(tx: SqlTx, row: NodeRow): Promise<NodeDetail> {
  // One statement at a time: a transaction is one connection.
  const labels = await tx.query<{ key: string; value: string; source: Label['source'] }>(
    'SELECT key, value, source FROM node_labels WHERE node_id = $1 ORDER BY key',
    [row.id],
  );
  const conditions = await tx.query<{
    type: string;
    status: Condition['status'];
    reason: string | null;
    since: Date;
  }>('SELECT type, status, reason, since FROM node_conditions WHERE node_id = $1 ORDER BY type', [
    row.id,
  ]);
  const sessions = await tx.query<{
    session_epoch: unknown;
    gateway_id: string | null;
    connected_at: Date | null;
    disconnected_at: Date | null;
    last_seen: Date | null;
  }>(
    `SELECT session_epoch, gateway_id, connected_at, disconnected_at, last_seen
     FROM node_sessions WHERE node_id = $1`,
    [row.id],
  );
  const node: NodeDetail = {
    ...toNode(row),
    labels: labels.rows.map((label) => ({
      key: label.key,
      value: label.value,
      source: label.source,
    })),
    conditions: conditions.rows.map((condition) => ({
      type: condition.type,
      status: condition.status,
      ...(condition.reason === null ? {} : { reason: condition.reason }),
      since: ms(condition.since)!,
    })),
  };
  const session = sessions.rows[0];
  if (session) {
    node.session = { epoch: int(session.session_epoch) };
    if (session.gateway_id !== null) node.session.gatewayId = session.gateway_id;
    for (const [key, value] of [
      ['connectedAt', session.connected_at],
      ['disconnectedAt', session.disconnected_at],
      ['lastSeen', session.last_seen],
    ] as const) {
      const time = ms(value);
      if (time !== undefined) node.session[key] = time;
    }
  }
  return node;
}

const reasonData = (reason?: string): Record<string, Json> => (reason ? { reason } : {});

// --- The group -----------------------------------------------------------------------------------

function nodeMutation<I extends NodeRef, O>(
  action: `compute:nodes:${string}`,
  validate: (input: unknown) => I,
  handler: (context: MethodContext, input: I) => Promise<O>,
): MethodDefinition<I, O> {
  return defineMethod<I, O>({
    action,
    kind: 'mutation',
    resource: (input) => ({ type: 'node', id: input.nodeId }),
    validate,
    handler,
  });
}

export function nodesApi(lists: ListRecipe): NodesApi {
  return {
    nodes: {
      list: defineListMethod<ListNodesInput, Page<NodeInfo>>({
        action: 'compute:nodes:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: listInput,
        async handler(context, input) {
          const size = input.limit ?? 50;
          let result: Page<NodeInfo> = { items: [] };
          const items = await lists.authorizeItems(
            context,
            input.tenantId,
            async () => {
              const { rows } = await context.sql.query<NodeRow>(
                `SELECT ${columns} FROM nodes n
                 WHERE ${visibleIn('node', 'n.id', '$1')}
                   AND ($2::text IS NULL OR n.pool_id = $2) AND ($3::text IS NULL OR n.site_id = $3)
                   AND ($4::bool IS NULL OR n.cordoned = $4)
                   AND ($5::text IS NULL OR n.provision_state = $5)
                   AND ($6::text IS NULL OR n.id > $6)
                 ORDER BY n.id LIMIT $7`,
                [
                  input.tenantId,
                  input.poolId ?? null,
                  input.siteId ?? null,
                  input.cordoned ?? null,
                  input.provisionState ?? null,
                  input.cursor ?? null,
                  size + 1,
                ],
              );
              result = page(rows, size, toNode, (row) => row.id);
              return result.items;
            },
            { action: 'compute:nodes:read', type: 'node', id: (node) => node.id },
          );
          return { ...result, items };
        },
      }),
      get: defineMethod<GetNodeInput, NodeDetail>({
        action: 'compute:nodes:read',
        kind: 'read',
        resource: (input) => ({ type: 'node', id: input.nodeId }),
        validate: getInput,
        async handler(context, input) {
          const row = await visibleNode(context.sql, input);
          if (!row) throw notFound('Node');
          return detail(context.sql, row);
        },
      }),
      events: defineMethod<NodeEventsInput, Page<NodeEvent>>({
        action: 'compute:nodes:read',
        kind: 'read',
        resource: (input) => ({ type: 'node', id: input.nodeId }),
        validate: eventsInput,
        async handler(context, input) {
          if (!(await visibleNode(context.sql, input))) throw notFound('Node');
          return readEvents(context.sql, {
            tenantId: input.tenantId,
            subject: `node/${input.nodeId}`,
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            limit: input.limit ?? 100,
          });
        },
      }),
      cordon: nodeMutation('compute:nodes:cordon', changeInput, async (context, input) => {
        const row = await lockNode(context, input);
        if (row.cordoned) return toNode(row);
        const node = toNode(await updateNode(context, row, 'cordoned = true'));
        await context.work.enqueue(context.sql, nodeWork, node.id);
        await publish(context, input.tenantId, node.id, 'node.cordoned', reasonData(input.reason));
        return node;
      }),
      uncordon: nodeMutation('compute:nodes:cordon', changeInput, async (context, input) => {
        const row = await lockNode(context, input);
        const draining = row.no_schedule_reasons.includes(drainingReason);
        if (!row.cordoned && !draining) return toNode(row);
        // Uncordoning also ends a drain in progress.
        const node = toNode(
          await updateNode(
            context,
            row,
            'cordoned = false, no_schedule_reasons = array_remove(n.no_schedule_reasons, $3)',
            [drainingReason],
          ),
        );
        await context.work.enqueue(context.sql, nodeWork, node.id);
        await publish(
          context,
          input.tenantId,
          node.id,
          'node.uncordoned',
          reasonData(input.reason),
        );
        return node;
      }),
      drain: nodeMutation('compute:nodes:drain', changeInput, async (context, input) => {
        const row = await lockNode(context, input);
        if (row.cordoned && row.no_schedule_reasons.includes(drainingReason)) return toNode(row);
        // A drain cordons the node and hands its allocations to the Drain controller, which
        // releases them within the pool's disruption budget.
        const node = toNode(
          await updateNode(
            context,
            row,
            `cordoned = true, no_schedule_reasons = CASE WHEN $3 = ANY(n.no_schedule_reasons)
               THEN n.no_schedule_reasons ELSE array_append(n.no_schedule_reasons, $3) END`,
            [drainingReason],
          ),
        );
        // The node reconciler re-evaluates the node now; the Drain controller (keyed `drain`)
        // releases its allocations once it runs.
        await context.work.enqueue(context.sql, nodeWork, node.id);
        await context.work.enqueue(context.sql, drainWorkKind, node.id);
        await publish(context, input.tenantId, node.id, 'node.draining', reasonData(input.reason));
        return node;
      }),
      label: nodeMutation('compute:nodes:update', labelInput, async (context, input) => {
        const row = await lockNode(context, input);
        const set = Object.entries(input.set ?? {});
        if (set.length) {
          const { rows: taken } = await context.sql.query<{ key: string }>(
            `SELECT key FROM node_labels WHERE node_id = $1 AND key = ANY($2::text[])
               AND source <> 'operator'`,
            [row.id, set.map(([key]) => key)],
          );
          if (taken.length)
            throw new ComputeError(
              'INVALID_INPUT',
              `set.${taken[0]!.key}: inventory or the system owns this label`,
            );
          await context.sql.query(
            `INSERT INTO node_labels (node_id, key, value, source)
             SELECT $1, key, value, 'operator' FROM unnest($2::text[], $3::text[]) AS l(key, value)
             ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [row.id, set.map(([key]) => key), set.map(([, value]) => value)],
          );
        }
        if (input.remove?.length)
          await context.sql.query(
            `DELETE FROM node_labels WHERE node_id = $1 AND key = ANY($2::text[])
               AND source = 'operator'`,
            [row.id, input.remove],
          );
        const updated = await updateNode(context, row, '');
        await context.work.enqueue(context.sql, nodeWork, row.id);
        await publish(context, input.tenantId, row.id, 'node.labeled', {
          set: Object.fromEntries(set),
          removed: input.remove ?? [],
        });
        return detail(context.sql, updated);
      }),
      taint: nodeMutation('compute:nodes:update', taintInput, async (context, input) => {
        const row = await lockNode(context, input);
        const add = (input.add ?? []).map((key) => `${taintPrefix}${key}`);
        const remove = (input.remove ?? []).map((key) => `${taintPrefix}${key}`);
        const reasons = row.no_schedule_reasons.filter((reason) => !remove.includes(reason));
        for (const reason of add) if (!reasons.includes(reason)) reasons.push(reason);
        const same =
          reasons.length === row.no_schedule_reasons.length &&
          reasons.every((reason, index) => reason === row.no_schedule_reasons[index]);
        if (same) return toNode(row);
        // Only operator taints move; Health and Liveness own every other reason.
        const node = toNode(
          await updateNode(context, row, 'no_schedule_reasons = $3::text[]', [reasons]),
        );
        await context.work.enqueue(context.sql, nodeWork, node.id);
        await publish(context, input.tenantId, node.id, 'node.tainted', {
          added: input.add ?? [],
          removed: input.remove ?? [],
        });
        return node;
      }),
      adopt: nodeMutation('compute:nodes:provision', changeInput, async (context, input) => {
        const row = await lockNode(context, input);
        // Re-runs acceptance (§3.3 step 7): adopted | adopting → adopting, and a new attempt even
        // after a failed one (NodeLifecycle keeps a failure until asked again).
        const next = transition(provisionStateTable, row.provision_state, 'adopt');
        const node = toNode(await updateNode(context, row, 'provision_state = $3', [next]));
        await refreshNodeAuthz(context.sql, context.authz, node.id);
        await markAcceptanceRequested(context.sql, context.work, node.id);
        await publish(context, input.tenantId, node.id, 'node.adopting', reasonData(input.reason));
        return node;
      }),
      revokeIdentity: nodeMutation(
        'compute:nodes:revoke-identity',
        changeInput,
        async (context, input) => {
          const row = await lockNode(context, input);
          const revoked = await context.sql.query(
            `UPDATE node_certs SET revoked_at = compute_now(), revocation_reason = $2
             WHERE node_id = $1 AND revoked_at IS NULL`,
            [row.id, input.reason ?? 'identity revoked'],
          );
          // A new identity generation: certificates of the old one never come back (§13).
          const node = toNode(await updateNode(context, row, 'identity_gen = n.identity_gen + 1'));
          await context.work.enqueue(context.sql, nodeWork, node.id);
          await publish(context, input.tenantId, node.id, 'security.node.identity-revoked', {
            identityGeneration: node.identityGeneration,
            revokedCertificates: revoked.rowCount,
            ...reasonData(input.reason),
          });
          return { node, revokedCertificates: revoked.rowCount };
        },
      ),
    },
  };
}
