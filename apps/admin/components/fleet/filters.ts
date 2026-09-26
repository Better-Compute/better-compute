import { CURRENT_BCD, isSchedulable, nodeSeverity, type FleetNode } from '@/lib/data/fleet';
import type { NodeHealth } from '@/lib/data/fleet-health';

// Node filters shared by the nodes page, the rack view and the palette: saved views ("presets") and facets,
// round-tripped through the URL (?preset=attention&health=offline,degraded&pool=pool_h100_fra1) so any view can
// be linked or bookmarked.

export interface NodeFilters {
  preset: PresetId;
  health: Set<NodeHealth>;
  pool: Set<string>;
  state: Set<string>;
  connectivity: Set<string>;
  model: Set<string>;
}

export const PRESETS = {
  all: { label: 'All nodes', test: () => true },
  attention: {
    label: 'Needs attention',
    test: (node: FleetNode) =>
      node.connectivity !== 'connected' || node.provisionState === 'failed' || ['critical', 'warning'].includes(nodeSeverity(node) ?? ''),
  },
  unschedulable: { label: 'Unschedulable', test: (node: FleetNode) => !isSchedulable(node) },
  idle: {
    label: 'Idle GPUs',
    test: (node: FleetNode) => isSchedulable(node) && node.gpus.some((gpu) => gpu.healthy && !gpu.allocation),
  },
  lifecycle: {
    label: 'In lifecycle',
    test: (node: FleetNode) => !['adopted', 'deployed'].includes(node.provisionState),
  },
  outdated: { label: `bcd < ${CURRENT_BCD}`, test: (node: FleetNode) => node.daemonVersion !== CURRENT_BCD },
  converging: { label: 'Converging', test: (node: FleetNode) => node.observedGeneration < node.generation },
} as const;
export type PresetId = keyof typeof PRESETS;

const list = (value: string | null) => new Set((value ?? '').split(',').filter(Boolean));

export function readFilters(params: URLSearchParams): NodeFilters {
  const preset = params.get('preset');
  return {
    preset: preset && preset in PRESETS ? (preset as PresetId) : 'all',
    health: list(params.get('health')) as Set<NodeHealth>,
    pool: list(params.get('pool')),
    state: list(params.get('state')),
    connectivity: list(params.get('conn')),
    model: list(params.get('model')),
  };
}

export function writeFilters(params: URLSearchParams, filters: NodeFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, values: Set<string>) => (values.size ? next.set(key, [...values].join(',')) : next.delete(key));
  if (filters.preset === 'all') next.delete('preset');
  else next.set('preset', filters.preset);
  set('health', filters.health);
  set('pool', filters.pool);
  set('state', filters.state);
  set('conn', filters.connectivity);
  set('model', filters.model);
  return next;
}

export function matches(node: FleetNode, filters: NodeFilters): boolean {
  return (
    PRESETS[filters.preset].test(node) &&
    (!filters.health.size || filters.health.has(node.health)) &&
    (!filters.pool.size || (node.poolId !== undefined && filters.pool.has(node.poolId))) &&
    (!filters.state.size || filters.state.has(node.provisionState)) &&
    (!filters.connectivity.size || filters.connectivity.has(node.connectivity)) &&
    (!filters.model.size || filters.model.has(node.gpuModel ?? 'CPU'))
  );
}

export const activeFilterCount = (filters: NodeFilters) =>
  (filters.preset === 'all' ? 0 : 1) + filters.health.size + filters.pool.size + filters.state.size + filters.connectivity.size + filters.model.size;

/** Value counts for a facet, most common first. */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => b[1] - a[1]));
}
