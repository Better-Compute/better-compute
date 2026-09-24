import { ComputeError, type GangSpec, type NodeView } from '@better-compute/core';
import type { NodePlan } from './pipeline.js';

// Gang scheduling (PLAN.md §10.3, v0.5): a gang books `size` nodes at once, every one taking the
// request's `devices` and `resources`, all on nodes that share one value of `topologyKey` (a node
// label such as `fabric.domain`), in one transaction. All or nothing: a lost race on any member
// rolls the whole gang back.

export const maxGangSize = 64;
const labelKeyPattern = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;

/** Validates a gang; `INVALID_INPUT` names the problem. */
export function assertGang(gang: unknown): asserts gang is GangSpec {
  const fail = (message: string): never => {
    throw new ComputeError('INVALID_INPUT', `gang: ${message}`);
  };
  if (typeof gang !== 'object' || gang === null || Array.isArray(gang)) fail('must be an object');
  const { size, topologyKey, ...rest } = gang as Record<string, unknown>;
  if (Object.keys(rest).length) fail(`unknown field ${JSON.stringify(Object.keys(rest)[0])}`);
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 2 || size > maxGangSize)
    fail(`size must be an integer from 2 to ${maxGangSize}`);
  if (
    topologyKey !== undefined &&
    (typeof topologyKey !== 'string' || !labelKeyPattern.test(topologyKey))
  )
    fail('topologyKey must be a node label key');
}

/** One candidate gang: its topology group and the nodes it would book. */
export interface GangPlan {
  /** The `topologyKey` value the members share (`*` without a key). */
  group: string;
  members: NodePlan[];
  /** Σ member scores. */
  score: number;
}

/**
 * Groups the per-node plans by the gang's topology key and keeps, per group with enough nodes, the
 * `size` best members. Best groups first (score, then group name, so plans are reproducible).
 * Nodes without the label never join a keyed gang.
 */
export function planGangs(
  ranked: readonly NodePlan[],
  views: readonly NodeView[],
  gang: GangSpec,
): { gangs: GangPlan[]; reason?: string } {
  const labels = new Map(views.map((view) => [view.id, view.labels]));
  const groups = new Map<string, NodePlan[]>();
  for (const plan of ranked) {
    const group = gang.topologyKey ? labels.get(plan.nodeId)?.[gang.topologyKey] : '*';
    if (group === undefined) continue;
    const members = groups.get(group) ?? [];
    members.push(plan);
    groups.set(group, members);
  }
  const gangs: GangPlan[] = [];
  let largest = 0;
  for (const [group, members] of groups) {
    largest = Math.max(largest, members.length);
    if (members.length < gang.size) continue;
    const chosen = members.slice(0, gang.size);
    gangs.push({
      group,
      members: chosen,
      score: chosen.reduce((sum, plan) => sum + plan.score, 0),
    });
  }
  gangs.sort((a, b) => b.score - a.score || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  if (gangs.length > 0) return { gangs };
  const scope = gang.topologyKey ? `one ${gang.topologyKey}` : 'the pool';
  return {
    gangs,
    reason: `no gang of ${gang.size} nodes fits in ${scope} (at most ${largest} node${largest === 1 ? '' : 's'} fit together)`,
  };
}

/** A random pick among the best `topN` gangs (default 5), like `choosePlan` for single nodes. */
export function chooseGang(
  gangs: readonly GangPlan[],
  random: () => number,
  topN = 5,
): GangPlan | undefined {
  const window = Math.min(Math.max(1, Math.floor(topN)), gangs.length);
  if (window === 0) return undefined;
  return gangs[Math.min(window - 1, Math.max(0, Math.floor(random() * window)))];
}
