import type {
  Atom,
  DeviceRequest,
  GpuLink,
  NodeView,
  PlacementRequest,
  SchedulerPlugin,
} from '@better-compute/core';
import { ineligibility, type EligibilityPool } from './eligibility.js';
import { matchesSelector } from './selector.js';

// The pure half of placement (PLAN.md §10.3 steps 3–6): no SQL, no clock. Placers load
// `NodeView`s, call `planPlacement`, then commit the chosen plan with guarded statements.

/** Interconnect quality, best first (`nvidia-smi topo`): NV > PIX > PXB > PHB > NODE > SYS. */
export const gpuLinkOrder: readonly GpuLink[] = ['NV', 'PIX', 'PXB', 'PHB', 'NODE', 'SYS'];
const worstKnownRank = gpuLinkOrder.length - 1;

/** The built-in scorer weights; `SchedulerOptions.weights` overrides them by id. */
export const defaultScorerWeights: Readonly<Record<string, number>> = Object.freeze({
  binpack: 1,
  topology: 1,
  fragmentation: 0.25,
  spread: 0,
  /** Requests with an `imageId` (VPS): nodes whose runtime already caches the image. */
  'image-cached': 0.5,
});

/** One node that can take the whole request, with the atoms it would book and its score. */
export interface NodePlan {
  nodeId: string;
  /** Atom ids, in request order. */
  atoms: string[];
  /** Scalar claims (`vcpu`, `memoryGiB`, …) as requested. */
  resources: Record<string, number>;
  /** The worst interconnect between any two picked GPUs; absent for ≤1 GPU or unknown links. */
  worstLink?: GpuLink;
  /** Per-scorer values in [0, 1]. */
  scores: Record<string, number>;
  /** Σ weight × score. */
  score: number;
}

/** A node the pipeline turned down, and which step did. */
export interface Rejection {
  nodeId: string;
  /** `eligible`, `excluded`, `labels`, `fits`, `topology`, or a plugin filter id. */
  filter: string;
  reason: string;
}

/**
 * A `nodeLabels` value that asks only for the label to exist, with any value: e.g. a driver the
 * host's bcd advertised in Hello (`bc.dev/driver.<id>=<version>`) whatever its version.
 */
export const anyLabelValue = '*';

/**
 * The first `request.nodeLabels` entry a node does not carry with exactly that value (or at all,
 * for `anyLabelValue`), as `key=value`; `undefined` when it carries them all (or none are asked).
 */
export function missingNodeLabel(
  wanted: Readonly<Record<string, string>> | undefined,
  labels: Readonly<Record<string, string>>,
): string | undefined {
  if (!wanted) return undefined;
  for (const key in wanted) {
    const value = wanted[key]!;
    if (value === anyLabelValue ? labels[key] === undefined : labels[key] !== value)
      return `${key}=${value}`;
  }
  return undefined;
}

export interface PlacementPlan {
  /** Best first; ties break on node id so plans are reproducible. */
  ranked: NodePlan[];
  rejected: Rejection[];
}

export interface PlanOptions {
  plugins?: readonly SchedulerPlugin[];
  weights?: Readonly<Record<string, number>>;
  /** Nodes whose runtime caches `request.imageId` (the `image-cached` scorer; see `readImageCachedNodes`). */
  imageCached?: ReadonlySet<string>;
}

/** The GPU an atom lives on: MIG instances and slots report links through their parent. */
function gpuOf(atom: Atom): string {
  return atom.parentId ?? atom.id;
}

/** The link between two atoms' GPUs, looked up in both directions; same GPU counts as `NV`. */
export function linkBetween(node: NodeView, a: Atom, b: Atom): GpuLink | undefined {
  const left = gpuOf(a);
  const right = gpuOf(b);
  if (left === right) return 'NV';
  return node.links?.[left]?.[right] ?? node.links?.[right]?.[left];
}

/** Rank of the worst pairwise link (0 = all NV); `undefined` when any pair is unknown. */
function worstRank(node: NodeView, atoms: readonly Atom[]): number | undefined {
  let worst = 0;
  for (let i = 0; i < atoms.length; i++)
    for (let j = i + 1; j < atoms.length; j++) {
      const link = linkBetween(node, atoms[i]!, atoms[j]!);
      if (link === undefined) return undefined;
      worst = Math.max(worst, gpuLinkOrder.indexOf(link));
    }
  return worst;
}

function numaOf(atom: Atom): string {
  const value = atom.attributes['numaNode'];
  return value === undefined ? '' : String(value);
}

function pairRank(node: NodeView, a: Atom, b: Atom): number {
  const link = linkBetween(node, a, b);
  return link === undefined ? worstKnownRank + 1 : gpuLinkOrder.indexOf(link);
}

/**
 * The default atom pick (§10.3 step 4): NVLink-complete sets first, then the fewest NUMA nodes.
 * Greedy from every seed: grow the set by the atom whose worst link to the set is best, same NUMA
 * node as the seed breaking ties, then id. Sets compare by (worst link, NUMA spread, Σ ranks, ids).
 */
export function defaultAtomPick(count: number, free: readonly Atom[], node: NodeView): Atom[] {
  const sorted = [...free].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (count >= sorted.length) return sorted.slice(0, count);
  if (count <= 0) return [];
  let best: { atoms: Atom[]; key: (number | string)[] } | undefined;
  for (const seed of sorted) {
    const chosen = [seed];
    const rest = sorted.filter((atom) => atom !== seed);
    while (chosen.length < count) {
      let pick = 0;
      let pickKey: number[] | undefined;
      rest.forEach((candidate, index) => {
        const worst = Math.max(...chosen.map((member) => pairRank(node, member, candidate)));
        const key = [worst, numaOf(candidate) === numaOf(seed) ? 0 : 1];
        if (!pickKey || key[0]! < pickKey[0]! || (key[0] === pickKey[0] && key[1]! < pickKey[1]!)) {
          pick = index;
          pickKey = key;
        }
      });
      chosen.push(rest.splice(pick, 1)[0]!);
    }
    let worst = 0;
    let sum = 0;
    for (let i = 0; i < chosen.length; i++)
      for (let j = i + 1; j < chosen.length; j++) {
        const rank = pairRank(node, chosen[i]!, chosen[j]!);
        worst = Math.max(worst, rank);
        sum += rank;
      }
    const spread = new Set(chosen.map(numaOf)).size;
    const ordered = [...chosen].sort((a, b) => (a.id < b.id ? -1 : 1));
    const key = [worst, spread, sum, ordered.map((atom) => atom.id).join(',')];
    if (!best || compareKeys(key, best.key) < 0) best = { atoms: ordered, key };
  }
  return best!.atoms;
}

function compareKeys(left: (number | string)[], right: (number | string)[]): number {
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/** Atoms of `request.class` on `node` that are free, healthy, bookable and match the selector. */
export function matchingAtoms(
  request: DeviceRequest,
  node: NodeView,
  taken: ReadonlySet<string> = new Set(),
): Atom[] {
  return node.free.filter(
    (atom) =>
      atom.class === request.class &&
      atom.bookable &&
      atom.healthy &&
      !taken.has(atom.id) &&
      matchesSelector(request.selector, { attributes: atom.attributes, labels: node.labels }),
  );
}

type Fit =
  | { ok: true; atoms: Atom[]; worstRank: number | undefined; gpuCount: number }
  | { ok: false; filter: string; reason: string };

function fitDevices(
  request: PlacementRequest,
  node: NodeView,
  plugins: readonly SchedulerPlugin[],
): Fit {
  const taken = new Set<string>();
  const picked: Atom[] = [];
  for (const device of request.devices) {
    const candidates = matchingAtoms(device, node, taken);
    if (candidates.length < device.count)
      return {
        ok: false,
        filter: 'fits',
        reason: `${candidates.length} of ${device.count} ${device.class} free${device.selector ? ' matching the selector' : ''}`,
      };
    let chosen: Atom[] | undefined;
    for (const plugin of plugins) {
      for (const picker of plugin.preferAllocation ?? []) {
        if (picker.class !== device.class) continue;
        const result = picker.pick(device, [...candidates], node);
        if (result === undefined) continue;
        const ids = new Set(result.map((atom) => atom.id));
        const valid =
          result.length === device.count &&
          ids.size === result.length &&
          result.every((atom) => candidates.some((candidate) => candidate.id === atom.id));
        if (!valid)
          return {
            ok: false,
            filter: plugin.id,
            reason: `preferAllocation ${plugin.id} picked atoms that are not ${device.count} distinct free candidates`,
          };
        chosen = candidates.filter((candidate) => ids.has(candidate.id));
        break;
      }
      if (chosen) break;
    }
    chosen ??= defaultAtomPick(device.count, candidates, node);
    const topology = device.topology ?? request.topology ?? 'any';
    if (topology === 'nvlink-all' && chosen.length > 1 && worstRank(node, chosen) !== 0)
      return {
        ok: false,
        filter: 'topology',
        reason: `no ${device.count} ${device.class} fully connected by NVLink`,
      };
    for (const atom of chosen) taken.add(atom.id);
    picked.push(...chosen);
  }
  const gpus = picked.filter((atom) => atom.class.startsWith('gpu'));
  return {
    ok: true,
    atoms: picked,
    worstRank: gpus.length > 1 ? worstRank(node, gpus) : gpus.length === 1 ? 0 : undefined,
    gpuCount: gpus.length,
  };
}

/**
 * A scalar's capacity, `floor(allocatable × ratio)`, as the database computes it in numeric: in
 * float, 100 × 0.29 is 28.999…96 and would lose the last unit (the SQL guards allow 29). The
 * epsilon only absorbs that rounding; the guarded commit still decides.
 */
export function scalarCapacity(scalar: { allocatable: number; ratio: number }): number {
  return Math.floor(scalar.allocatable * scalar.ratio + 1e-9);
}

function fitScalars(request: PlacementRequest, node: NodeView): true | string {
  for (const [resource, need] of Object.entries(request.resources ?? {})) {
    if (need <= 0) continue;
    const scalar = node.resources[resource];
    if (!scalar) return `no ${resource}`;
    const room = scalarCapacity(scalar) - scalar.allocated;
    if (need > room) return `${resource}: ${need} requested, ${Math.max(0, room)} free`;
  }
  return true;
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function builtInScores(
  request: PlacementRequest,
  node: NodeView,
  fit: Extract<Fit, { ok: true }>,
): Record<string, number> {
  const classes = new Set(request.devices.map((device) => device.class));
  const total = node.devices.filter(
    (device) => device.bookable && classes.has(device.class),
  ).length;
  const freeBefore = node.free.filter((atom) => classes.has(atom.class)).length;
  const freeAfter = Math.max(0, freeBefore - fit.atoms.length);
  const binpack = total > 0 ? 1 - freeAfter / total : 0;
  const topology =
    fit.gpuCount <= 1 ? 1 : fit.worstRank === undefined ? 0.5 : 1 - fit.worstRank / worstKnownRank;
  const fragmentation = freeAfter === 0 ? 1 : (freeAfter & (freeAfter - 1)) === 0 ? 0.5 : 0;
  return { binpack, topology, fragmentation, spread: 1 - binpack };
}

/**
 * Filters, picks atoms on and scores every candidate node for a request that must land on one
 * node (gangs across nodes arrive in v0.5). Plugin filters run after the built-in ones; plugin
 * pickers win over the default pick for their class; plugin scorers add to the built-ins.
 */
export function planPlacement(
  request: PlacementRequest,
  nodes: readonly NodeView[],
  pool: EligibilityPool,
  options: PlanOptions = {},
): PlacementPlan {
  const plugins = options.plugins ?? [];
  const weights = { ...defaultScorerWeights, ...options.weights };
  const excluded = new Set(request.excludeNodes ?? []);
  const ranked: NodePlan[] = [];
  const rejected: Rejection[] = [];

  nodeLoop: for (const node of nodes) {
    if (excluded.has(node.id)) {
      rejected.push({ nodeId: node.id, filter: 'excluded', reason: 'excluded by the request' });
      continue;
    }
    if (node.poolId !== request.poolId) {
      rejected.push({ nodeId: node.id, filter: 'eligible', reason: 'in another pool' });
      continue;
    }
    const why = ineligibility(node, pool, request.tenantId);
    if (why) {
      rejected.push({ nodeId: node.id, filter: 'eligible', reason: why.reason });
      continue;
    }
    const label = missingNodeLabel(request.nodeLabels, node.labels);
    if (label !== undefined) {
      rejected.push({ nodeId: node.id, filter: 'labels', reason: `needs label ${label}` });
      continue;
    }
    const scalars = fitScalars(request, node);
    if (scalars !== true) {
      rejected.push({ nodeId: node.id, filter: 'fits', reason: scalars });
      continue;
    }
    for (const plugin of plugins)
      for (const filter of plugin.filters ?? []) {
        const verdict = filter.filter(request, node);
        if (verdict !== true) {
          rejected.push({ nodeId: node.id, filter: filter.id, reason: verdict.reason });
          continue nodeLoop;
        }
      }
    const fit = fitDevices(request, node, plugins);
    if (!fit.ok) {
      rejected.push({ nodeId: node.id, filter: fit.filter, reason: fit.reason });
      continue;
    }

    const scores = builtInScores(request, node, fit);
    if (request.imageId !== undefined)
      scores['image-cached'] = options.imageCached?.has(node.id) ? 1 : 0;
    for (const plugin of plugins)
      for (const scorer of plugin.scorers ?? []) {
        scores[scorer.id] = clamp(scorer.score(request, node));
        if (!(scorer.id in weights)) weights[scorer.id] = scorer.weight ?? 1;
      }
    let score = 0;
    for (const [id, value] of Object.entries(scores)) score += (weights[id] ?? 0) * value;
    const plan: NodePlan = {
      nodeId: node.id,
      atoms: fit.atoms.map((atom) => atom.id),
      resources: { ...(request.resources ?? {}) },
      scores,
      score,
    };
    if (fit.worstRank !== undefined && fit.gpuCount > 1)
      plan.worstLink = gpuLinkOrder[fit.worstRank]!;
    ranked.push(plan);
  }

  ranked.sort(
    (a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
  );
  return { ranked, rejected };
}

/** §10.3 step 6: a random pick among the best `topN` (default 5), so concurrent placers spread. */
export function choosePlan(
  ranked: readonly NodePlan[],
  random: () => number,
  topN = 5,
): NodePlan | undefined {
  const window = Math.min(Math.max(1, Math.floor(topN)), ranked.length);
  if (window === 0) return undefined;
  const index = Math.min(window - 1, Math.max(0, Math.floor(random() * window)));
  return ranked[index];
}

/** One line for `Unschedulable`: `no node fits (3 nodes): 2 × fits: 1 of 4 gpu free; 1 × cordoned`. */
export function summarizeRejections(rejected: readonly Rejection[]): string {
  if (rejected.length === 0) return 'the pool has no nodes';
  const counts = new Map<string, number>();
  for (const { filter, reason } of rejected) {
    const key = filter === 'eligible' ? reason : `${filter}: ${reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([reason, count]) => `${count} × ${reason}`);
  const noun = rejected.length === 1 ? 'node' : 'nodes';
  return `no node fits (${rejected.length} ${noun}): ${parts.join('; ')}`;
}
