import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester, Item } from './resources.js';

// Platform-admin views: a rollout's progress wave by wave (`rollouts.get`, v0.4), the fleet's
// drift from its applied FleetConfig (`fleet.status`, v0.2), and a node table's filtering and
// sorting. Pure derivations over API results, so they test without a server.

// --- Rollouts --------------------------------------------------------------------------------------

export interface RolloutNodeRow {
  nodeId: string;
  poolId: string;
  wave: number;
  state: string;
  error?: string;
}

export interface RolloutDetail {
  id: string;
  version: string;
  state: 'running' | 'paused' | 'completed' | 'aborted';
  waves: number[];
  wave: number;
  reason?: string;
  nodeList: RolloutNodeRow[];
}

export interface WaveProgress {
  index: number;
  /** Cumulative percentage of the fleet this wave reaches. */
  percent: number;
  nodes: number;
  counts: Record<string, number>;
  status: 'done' | 'current' | 'waiting';
}

export interface RolloutProgress {
  version: string;
  state: RolloutDetail['state'];
  reason?: string;
  waves: WaveProgress[];
  /** Nodes on the version (or skipped) over all nodes. */
  done: number;
  total: number;
  failed: number;
  /** What an admin may do now. */
  can: { pause: boolean; resume: boolean; abort: boolean };
  /** Failed nodes with their errors, first. */
  failures: RolloutNodeRow[];
}

export function rolloutProgress(rollout: RolloutDetail): RolloutProgress {
  const byWave = new Map<number, RolloutNodeRow[]>();
  for (const node of rollout.nodeList)
    byWave.set(node.wave, [...(byWave.get(node.wave) ?? []), node]);
  const finished = (state: string) =>
    state === 'succeeded' || state === 'skipped' || state === 'rolled-back';
  const waves = rollout.waves.map((percent, index): WaveProgress => {
    const nodes = byWave.get(index) ?? [];
    const counts: Record<string, number> = {};
    for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
    const settled = nodes.every((node) => finished(node.state) || node.state === 'failed');
    return {
      index,
      percent,
      nodes: nodes.length,
      counts,
      status:
        index < rollout.wave || (index === rollout.wave && settled && rollout.state === 'completed')
          ? 'done'
          : index === rollout.wave
            ? 'current'
            : 'waiting',
    };
  });
  const active = rollout.state === 'running' || rollout.state === 'paused';
  return {
    version: rollout.version,
    state: rollout.state,
    ...(rollout.reason ? { reason: rollout.reason } : {}),
    waves,
    done: rollout.nodeList.filter((node) => finished(node.state)).length,
    total: rollout.nodeList.length,
    failed: rollout.nodeList.filter((node) => node.state === 'failed').length,
    can: {
      pause: rollout.state === 'running',
      resume: rollout.state === 'paused',
      abort: active,
    },
    failures: rollout.nodeList.filter((node) => node.state === 'failed'),
  };
}

/** `rollouts.get`, with its progress derived. */
export function createRolloutView(
  api: ComputeRequester,
  options: { tenantId: string; rolloutId: string },
): ValueResource<RolloutProgress & { rollout: RolloutDetail }> {
  return createValueResource({
    load: async (signal) => {
      const rollout = await api.$request<RolloutDetail>(
        'rollouts/get',
        { tenantId: options.tenantId, rolloutId: options.rolloutId },
        { signal },
      );
      return { ...rolloutProgress(rollout), rollout };
    },
  });
}

// --- Fleet drift ----------------------------------------------------------------------------------

export interface FleetChangeRow {
  kind: string;
  name: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  fields?: string[];
  blocked?: string;
  note?: string;
}

export interface FleetStatusInput {
  applied?: { planHash: string; appliedBy: string; appliedAt: number; checkedAt?: number };
  drift?: { changes: FleetChangeRow[]; summary: Record<string, number>; blocked: boolean };
}

export interface FleetDriftView {
  managed: boolean;
  drifted: boolean;
  appliedAt?: number;
  appliedBy?: string;
  checkedAt?: number;
  /** Changes grouped by object kind, in a stable order. */
  groups: { kind: string; changes: FleetChangeRow[] }[];
  blocked: boolean;
}

const kindOrder = ['site', 'providerAccount', 'pool', 'ownerQuota', 'offer', 'flavor'];

export function fleetDriftView(status: FleetStatusInput): FleetDriftView {
  const changes = status.drift?.changes ?? [];
  const kinds = [...new Set(changes.map((change) => change.kind))].sort(
    (a, b) =>
      (kindOrder.indexOf(a) + 1 || 99) - (kindOrder.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  return {
    managed: Boolean(status.applied),
    drifted: Boolean(status.drift),
    ...(status.applied
      ? {
          appliedAt: status.applied.appliedAt,
          appliedBy: status.applied.appliedBy,
          ...(status.applied.checkedAt !== undefined
            ? { checkedAt: status.applied.checkedAt }
            : {}),
        }
      : {}),
    groups: kinds.map((kind) => ({
      kind,
      changes: changes
        .filter((change) => change.kind === kind)
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
    blocked: status.drift?.blocked ?? false,
  };
}

export function createFleetDriftView(
  api: ComputeRequester,
  options: { tenantId: string },
): ValueResource<FleetDriftView> {
  return createValueResource({
    load: async (signal) =>
      fleetDriftView(
        await api.$request<FleetStatusInput>(
          'fleet/status',
          { tenantId: options.tenantId },
          { signal },
        ),
      ),
  });
}

// --- Node table -------------------------------------------------------------------------------------

export interface NodeFilter {
  /** Matches the id, pool, site and label values (case-insensitive). */
  text?: string;
  connectivity?: readonly string[];
  provisionState?: readonly string[];
  cordoned?: boolean;
  poolId?: string;
  /** Only nodes with a true condition of these types (e.g. `GpuXid`). */
  conditions?: readonly string[];
}

export type NodeSort = 'id' | 'pool' | 'connectivity' | 'provisionState' | 'conditions';

const text = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '');

type NodeLike = Item & {
  poolId?: string;
  siteId?: string;
  connectivity?: string;
  provisionState?: string;
  cordoned?: boolean;
  labels?: { key: string; value: string }[];
  conditions?: { type: string; status: string }[];
};

const activeConditions = (node: NodeLike) =>
  (node.conditions ?? [])
    .filter((condition) => condition.status === 'true')
    .map((condition) => condition.type);

/** Filters and sorts node rows as the table shows them. */
export function nodeTable<T extends NodeLike>(
  nodes: readonly T[],
  options: { filter?: NodeFilter; sort?: NodeSort; descending?: boolean } = {},
): T[] {
  const filter = options.filter ?? {};
  const needle = text(filter.text);
  const rows = nodes.filter((node) => {
    if (needle) {
      const haystack = [
        node.id,
        node.poolId,
        node.siteId,
        ...(node.labels ?? []).map((label) => label.value),
      ]
        .map(text)
        .join(' ');
      if (!haystack.includes(needle)) return false;
    }
    if (filter.connectivity && !filter.connectivity.includes(node.connectivity ?? '')) return false;
    if (filter.provisionState && !filter.provisionState.includes(node.provisionState ?? ''))
      return false;
    if (filter.cordoned !== undefined && Boolean(node.cordoned) !== filter.cordoned) return false;
    if (filter.poolId && node.poolId !== filter.poolId) return false;
    if (filter.conditions?.length) {
      const active = activeConditions(node);
      if (!filter.conditions.some((type) => active.includes(type))) return false;
    }
    return true;
  });
  const sort = options.sort ?? 'id';
  const keyOf = (node: T): string | number =>
    sort === 'pool'
      ? (node.poolId ?? '')
      : sort === 'connectivity'
        ? (node.connectivity ?? '')
        : sort === 'provisionState'
          ? (node.provisionState ?? '')
          : sort === 'conditions'
            ? activeConditions(node).length
            : node.id;
  rows.sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    const order =
      typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return (options.descending ? -order : order) || a.id.localeCompare(b.id);
  });
  return rows;
}
