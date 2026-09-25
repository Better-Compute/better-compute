'use client';

import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useInView } from 'motion/react';
import {
  RiAddLine,
  RiArrowRightLine,
  RiCheckLine,
  RiCloseLine,
  RiDatabase2Line,
  RiFlashlightLine,
  RiShuffleLine,
  RiTimeLine,
} from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { cx } from '@/utils/cx';
import { DiagramFrame, ReplayButton, segmentClass } from './frame';
import { ease, useReducedMotionSafe } from './motion';

/**
 * Placement, and why double-booking cannot happen (PLAN.md §10.3, §10.4), on a five-node H100 pool.
 *
 * The planning half is a port of the pure code in packages/capacity/src: `planPlacement` (filter order,
 * rejection reasons), `defaultAtomPick` (NVLink-complete sets first, then the fewest NUMA nodes), the built-in
 * scorers and their default weights, `choosePlan` (a random pick among the top 5), `summarizeRejections`, and the
 * rule for when the inline placer plans from its SQL shortlist (`shortlistable`, `planFromShortlist`).
 *
 * The database half models what `inlinePlacer`'s guarded commit does: `INSERT INTO device_bookings … ON CONFLICT
 * DO NOTHING` under `EXCLUDE (device_id WITH =, during WITH &&)` returns fewer rows instead of raising 23P01, the
 * placer rolls back to `SAVEPOINT capacity_place_<n>` and replans without that node (at most 3 attempts), and a
 * request nothing fits goes `pending` with an `Unschedulable` condition. Nothing leaves the browser.
 */

// --- The pool --------------------------------------------------------------------------------------

type GpuLink = 'NV' | 'PIX' | 'PXB' | 'PHB' | 'NODE' | 'SYS';

/** Interconnect quality, best first (`nvidia-smi topo`), as in `gpuLinkOrder`. */
const gpuLinkOrder: readonly GpuLink[] = ['NV', 'PIX', 'PXB', 'PHB', 'NODE', 'SYS'];
const worstKnownRank = gpuLinkOrder.length - 1;

/** The built-in scorers with their default weights (`defaultScorerWeights`), in summation order. */
const scorers = [
  { id: 'binpack', label: 'binpack', weight: 1 },
  { id: 'topology', label: 'topology', weight: 1 },
  { id: 'fragmentation', label: 'frag.', weight: 0.25 },
  { id: 'spread', label: 'spread', weight: 0 },
] as const;
type ScorerId = (typeof scorers)[number]['id'];

/** `choosePlan`'s default window. */
const topN = 5;
/** `inlinePlacer`'s default `maxAttempts`. */
const maxAttempts = 3;
const poolId = 'pool_h100';

interface Atom {
  id: string;
  healthy: boolean;
  bookable: boolean;
  attributes: { gpuProduct: string; gpuModel: string; vramGiB: number; numaNode: number };
}

interface SimNode {
  id: string;
  form: string;
  fabric: string;
  provisionState: 'adopted' | 'deployed' | 'adopting';
  maintenance: boolean;
  cordoned: boolean;
  connectivity: 'connected' | 'unreachable';
  noScheduleReasons: readonly string[];
  devices: readonly Atom[];
  links: Readonly<Record<string, Readonly<Record<string, GpuLink>>>>;
}

function gpus(nodeId: string, product: string, vramGiB: number, unhealthy: number[] = []): Atom[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `${nodeId}-gpu${index}`,
    healthy: !unhealthy.includes(index),
    bookable: true,
    attributes: { gpuProduct: product, gpuModel: 'H100', vramGiB, numaNode: index < 4 ? 0 : 1 },
  }));
}

/** The topology matrix inventory writes to `capacity_device_links`, for every pair of GPU indexes. */
function topology(nodeId: string, link: (a: number, b: number) => GpuLink) {
  const result: Record<string, Record<string, GpuLink>> = {};
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++)
      if (a !== b) (result[`${nodeId}-gpu${a}`] ??= {})[`${nodeId}-gpu${b}`] = link(a, b);
  return result;
}

/** SXM5 boards: every pair meets on the NVSwitch. */
const nvswitch = (): GpuLink => 'NV';
/** H100 NVL cards: NVLink-bridged in pairs, PCIe within a NUMA node, SYS across. */
const bridged = (a: number, b: number): GpuLink =>
  Math.floor(a / 2) === Math.floor(b / 2) ? 'NV' : a < 4 === b < 4 ? 'NODE' : 'SYS';

function makeNode(
  id: string,
  spec: Partial<SimNode> & Pick<SimNode, 'form' | 'fabric' | 'devices' | 'links'>,
): SimNode {
  return {
    id,
    provisionState: 'adopted',
    maintenance: false,
    cordoned: false,
    connectivity: 'connected',
    noScheduleReasons: [],
    ...spec,
  };
}

const sxm5 = 'H100-SXM5-80GB';
const nvl = 'H100-NVL-94GB';

const nodes: readonly SimNode[] = [
  makeNode('node_a', {
    form: 'SXM5',
    fabric: 'NVSwitch',
    devices: gpus('node_a', sxm5, 80),
    links: topology('node_a', nvswitch),
  }),
  makeNode('node_b', {
    form: 'SXM5',
    fabric: 'NVSwitch',
    provisionState: 'deployed',
    devices: gpus('node_b', sxm5, 80),
    links: topology('node_b', nvswitch),
  }),
  makeNode('node_c', {
    form: 'NVL',
    fabric: 'NVLink pairs',
    devices: gpus('node_c', nvl, 94, [5]),
    links: topology('node_c', bridged),
  }),
  makeNode('node_d', {
    form: 'SXM5',
    fabric: 'NVSwitch',
    cordoned: true,
    devices: gpus('node_d', sxm5, 80),
    links: topology('node_d', nvswitch),
  }),
  makeNode('node_e', {
    form: 'SXM5',
    fabric: 'NVSwitch',
    connectivity: 'unreachable',
    devices: gpus('node_e', sxm5, 80),
    links: topology('node_e', nvswitch),
  }),
];

// --- Requests and selectors ------------------------------------------------------------------------

type Topology = 'any' | 'nvlink-all';
type SelectorKey = 'none' | 'sxm5' | 'vram';

interface Req {
  count: number;
  topology: Topology;
  selector: SelectorKey;
}

interface MatchExpression {
  key: 'gpuProduct' | 'vramGiB';
  op: 'In' | 'Gte';
  values: (string | number)[];
}

/** What `parseSelector` returns for each shorthand. */
const selectorOptions: Record<
  SelectorKey,
  { label: string; shorthand?: string; expressions?: MatchExpression[] }
> = {
  none: { label: 'none' },
  sxm5: {
    label: 'SXM5 only',
    shorthand: `gpuProduct in (${sxm5})`,
    expressions: [{ key: 'gpuProduct', op: 'In', values: [sxm5] }],
  },
  vram: {
    label: 'vramGiB ≥ 90',
    shorthand: 'vramGiB >= 90',
    expressions: [{ key: 'vramGiB', op: 'Gte', values: [90] }],
  },
};

/** `matchesExpression` for the two operators used here: `In` compares as strings, `Gte` numerically. */
function matchesExpression(expression: MatchExpression, atom: Atom): boolean {
  const value = atom.attributes[expression.key];
  if (expression.op === 'In')
    return expression.values.some((candidate) => String(candidate) === String(value));
  const left = Number(value);
  const right = Number(expression.values[0]);
  return Number.isFinite(left) && Number.isFinite(right) && left >= right;
}

function formatExpression(expression: MatchExpression): string {
  const values = expression.values
    .map((value) => (typeof value === 'string' ? `'${value}'` : String(value)))
    .join(', ');
  return `{ key: '${expression.key}', op: '${expression.op}', values: [${values}] }`;
}

// --- The pipeline (a port of pipeline.ts) ------------------------------------------------------------

interface Booking {
  allocationId: string;
  mine: boolean;
}
type Bookings = Readonly<Record<string, Booking>>;

interface View {
  node: SimNode;
  /** Atoms free for the request's interval: bookable, healthy, without an overlapping booking. */
  free: Atom[];
}

function viewsOf(bookings: Bookings): View[] {
  return nodes.map((node) => ({
    node,
    free: node.devices.filter((atom) => atom.bookable && atom.healthy && !bookings[atom.id]),
  }));
}

/** `ineligibility`, in its order (role `host` and trust `platform` hold for every node here). */
function ineligibility(node: SimNode): string | undefined {
  if (node.maintenance) return 'in maintenance';
  if (node.cordoned) return 'cordoned';
  if (node.provisionState !== 'adopted' && node.provisionState !== 'deployed')
    return `provision state ${node.provisionState}`;
  if (node.connectivity !== 'connected') return `connectivity ${node.connectivity}`;
  if (node.noScheduleReasons.length > 0)
    return `NoSchedule: ${node.noScheduleReasons.join(', ')}`;
  return undefined;
}

function linkBetween(node: SimNode, a: Atom, b: Atom): GpuLink | undefined {
  if (a.id === b.id) return 'NV';
  return node.links[a.id]?.[b.id] ?? node.links[b.id]?.[a.id];
}

function pairRank(node: SimNode, a: Atom, b: Atom): number {
  const link = linkBetween(node, a, b);
  return link === undefined ? worstKnownRank + 1 : gpuLinkOrder.indexOf(link);
}

/** Rank of the worst pairwise link (0 = all NV); `undefined` when any pair is unknown. */
function worstRank(node: SimNode, atoms: readonly Atom[]): number | undefined {
  let worst = 0;
  for (let i = 0; i < atoms.length; i++)
    for (let j = i + 1; j < atoms.length; j++) {
      const link = linkBetween(node, atoms[i]!, atoms[j]!);
      if (link === undefined) return undefined;
      worst = Math.max(worst, gpuLinkOrder.indexOf(link));
    }
  return worst;
}

const numaOf = (atom: Atom) => String(atom.attributes.numaNode);
const byId = (a: Atom, b: Atom) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function compareKeys(left: (number | string)[], right: (number | string)[]): number {
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/**
 * `defaultAtomPick`: greedy from every seed, growing the set by the atom whose worst link to it is best (same
 * NUMA node as the seed breaking ties); sets compare by (worst link, NUMA spread, Σ ranks, ids).
 */
function defaultAtomPick(count: number, free: readonly Atom[], node: SimNode): Atom[] {
  const sorted = [...free].sort(byId);
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
        if (
          !pickKey ||
          key[0]! < pickKey[0]! ||
          (key[0] === pickKey[0] && key[1]! < pickKey[1]!)
        ) {
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
    const ordered = [...chosen].sort(byId);
    const key = [worst, spread, sum, ordered.map((atom) => atom.id).join(',')];
    if (!best || compareKeys(key, best.key) < 0) best = { atoms: ordered, key };
  }
  return best!.atoms;
}

interface NodePlan {
  nodeId: string;
  atoms: string[];
  worstLink?: GpuLink;
  numa: number;
  scores: Record<ScorerId, number>;
  score: number;
}

interface Rejection {
  nodeId: string;
  /** `eligible`, `excluded`, `fits` or `topology`, as `planPlacement` reports them. */
  filter: string;
  reason: string;
}

interface Plan {
  ranked: NodePlan[];
  rejected: Rejection[];
}

/** `planPlacement` for one whole-GPU device request: filters, atom pick, scorers, ranking. */
function planPlacement(request: Req, views: readonly View[], excluded: readonly string[]): Plan {
  const selector = selectorOptions[request.selector].expressions;
  const ranked: NodePlan[] = [];
  const rejected: Rejection[] = [];
  for (const { node, free } of views) {
    if (excluded.includes(node.id)) {
      rejected.push({ nodeId: node.id, filter: 'excluded', reason: 'excluded by the request' });
      continue;
    }
    const why = ineligibility(node);
    if (why) {
      rejected.push({ nodeId: node.id, filter: 'eligible', reason: why });
      continue;
    }
    // `matchingAtoms`: free, healthy, bookable atoms of the class that match the selector.
    const candidates = free.filter(
      (atom) =>
        atom.bookable &&
        atom.healthy &&
        (selector ?? []).every((expression) => matchesExpression(expression, atom)),
    );
    if (candidates.length < request.count) {
      rejected.push({
        nodeId: node.id,
        filter: 'fits',
        reason: `${candidates.length} of ${request.count} gpu free${selector ? ' matching the selector' : ''}`,
      });
      continue;
    }
    const chosen = defaultAtomPick(request.count, candidates, node);
    if (request.topology === 'nvlink-all' && chosen.length > 1 && worstRank(node, chosen) !== 0) {
      rejected.push({
        nodeId: node.id,
        filter: 'topology',
        reason: `no ${request.count} gpu fully connected by NVLink`,
      });
      continue;
    }
    const fitRank =
      chosen.length > 1 ? worstRank(node, chosen) : chosen.length === 1 ? 0 : undefined;
    // `builtInScores`.
    const total = node.devices.filter((device) => device.bookable).length;
    const freeAfter = Math.max(0, free.length - chosen.length);
    const binpack = total > 0 ? 1 - freeAfter / total : 0;
    const scores: Record<ScorerId, number> = {
      binpack,
      topology:
        chosen.length <= 1 ? 1 : fitRank === undefined ? 0.5 : 1 - fitRank / worstKnownRank,
      fragmentation: freeAfter === 0 ? 1 : (freeAfter & (freeAfter - 1)) === 0 ? 0.5 : 0,
      spread: 1 - binpack,
    };
    let score = 0;
    for (const scorer of scorers) score += scorer.weight * scores[scorer.id];
    const plan: NodePlan = {
      nodeId: node.id,
      atoms: chosen.map((atom) => atom.id),
      numa: new Set(chosen.map(numaOf)).size,
      scores,
      score,
    };
    if (fitRank !== undefined && chosen.length > 1) plan.worstLink = gpuLinkOrder[fitRank];
    ranked.push(plan);
  }
  ranked.sort(
    (a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
  );
  return { ranked, rejected };
}

/** `choosePlan`: a random pick among the best `topN`, so concurrent placers spread. */
function choosePlan(ranked: readonly NodePlan[], roll: number) {
  const window = Math.min(Math.max(1, Math.floor(topN)), ranked.length);
  if (window === 0) return undefined;
  const index = Math.min(window - 1, Math.max(0, Math.floor(roll * window)));
  return { plan: ranked[index]!, index, window };
}

/** `summarizeRejections`: the one line an `Unschedulable` condition carries. */
function summarizeRejections(rejected: readonly Rejection[]): string {
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
  return `no node fits (${rejected.length} ${rejected.length === 1 ? 'node' : 'nodes'}): ${parts.join('; ')}`;
}

interface Planned {
  /** `shortlist`: planned from the SQL shortlist; `selector`: not shortlistable; `fallback`: it could not decide. */
  mode: 'shortlist' | 'selector' | 'fallback';
  shortlisted: string[];
  /** The plan the placer uses. */
  plan: Plan;
  /** The same request over every node, for the reasons shown per node. */
  full: Plan;
}

/**
 * One planning pass of `inlinePlacer`: from the SQL shortlist when the request is shortlistable (no selector, no
 * plugin scorers, no gang) and the shortlist ranks something, otherwise from every `NodeView`. The shortlist keeps
 * schedulable nodes (`schedulableSql`) with enough free, healthy, bookable atoms; in a pool this small it holds
 * every such node, so its ranking equals the full one.
 */
function planInline(request: Req, bookings: Bookings, excluded: readonly string[]): Planned {
  const views = viewsOf(bookings);
  const full = planPlacement(request, views, excluded);
  if (request.selector !== 'none') return { mode: 'selector', shortlisted: [], plan: full, full };
  const shortlisted = views
    .filter(
      (view) =>
        !excluded.includes(view.node.id) &&
        ineligibility(view.node) === undefined &&
        view.free.length >= request.count,
    )
    .map((view) => view.node.id);
  if (shortlisted.length > 0) {
    const plan = planPlacement(
      request,
      views.filter((view) => shortlisted.includes(view.node.id)),
      excluded,
    );
    if (plan.ranked.length > 0) return { mode: 'shortlist', shortlisted, plan, full };
  }
  return { mode: 'fallback', shortlisted, plan: full, full };
}

function describePlan(planned: Planned): string {
  const ranked = `${planned.plan.ranked.length} ranked`;
  if (planned.mode === 'shortlist')
    return `plan: the SQL shortlist keeps ${planned.shortlisted.length} of ${nodes.length} nodes → ${ranked}`;
  if (planned.mode === 'selector')
    return `plan: a selector is set, so every NodeView is loaded → ${ranked}`;
  return `plan: the shortlist cannot decide, so the whole pool is planned → ${ranked}`;
}

/** mulberry32, as the simulator seeds placement: the same clicks replay the same picks. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seed = 20260924;

/** Scores as the pipeline computes them, trimmed for display: 0.875, 1.625, 2.25. */
const fmt = (value: number) => String(Math.round(value * 1000) / 1000);

// --- The simulated database ------------------------------------------------------------------------

type ReservationState = 'placed' | 'pending' | 'released' | 'cancelled';

interface Reservation {
  id: string;
  order: number;
  state: ReservationState;
  request: Req;
  nodeId?: string;
  atoms?: string[];
  allocationId?: string;
  /** The `Unschedulable` condition's message while pending. */
  reason?: string;
}

interface Sim {
  bookings: Bookings;
  reservations: readonly Reservation[];
  next: number;
}

/** Another tenant's reservations, already booked when the demo starts. */
const initialBookings: Record<string, Booking> = {};
for (const index of [0, 1, 2, 3, 4, 5])
  initialBookings[`node_a-gpu${index}`] = { allocationId: 'alloc_other_1', mine: false };
for (const index of [0, 1])
  initialBookings[`node_c-gpu${index}`] = { allocationId: 'alloc_other_2', mine: false };

const initialSim: Sim = { bookings: initialBookings, reservations: [], next: 1 };
const initialRequest: Req = { count: 2, topology: 'any', selector: 'none' };
/** A demo limit, not a product one: enough reservations to fill the pool, few enough to list. */
const liveLimit = 6;

function book(bookings: Bookings, atoms: readonly string[], allocationId: string): Bookings {
  const next: Record<string, Booking> = { ...bookings };
  for (const atom of atoms) next[atom] = { allocationId, mine: true };
  return next;
}

function unbook(bookings: Bookings, atoms: readonly string[]): Bookings {
  const next: Record<string, Booking> = { ...bookings };
  for (const atom of atoms) delete next[atom];
  return next;
}

const isLive = (reservation: Reservation) =>
  reservation.state === 'placed' || reservation.state === 'pending';

/** Keeps every live reservation and the two most recent finished ones. */
function prune(list: readonly Reservation[]): Reservation[] {
  const finished = list
    .filter((reservation) => !isLive(reservation))
    .sort((a, b) => b.order - a.order)
    .slice(0, 2);
  return list.filter((reservation) => isLive(reservation) || finished.includes(reservation));
}

// --- What one action leaves on screen --------------------------------------------------------------

type Actor = 'A' | 'B' | 'A+B';
type Tone = 'ok' | 'refused' | 'note';
type Ink = 'ink' | 'hatch' | 'plain';

interface TraceLine {
  actor?: Actor;
  tone?: Tone;
  text: string;
  /** Seconds after the action at which the line (and what it did) shows. */
  at: number;
}

interface Highlight {
  kind: 'fill' | 'clear' | 'conflict';
  at: number;
}

interface Mark {
  label: string;
  tone: 'ink' | 'hatch';
  at: number;
}

interface Verdict {
  tone: Ink;
  icon: 'placed' | 'pending' | 'refused' | 'ready';
  title: string;
  detail: string;
}

interface Outcome {
  id: number;
  call: string;
  chip: { label: string; tone: Ink };
  trace: TraceLine[];
  highlights: Record<string, Highlight[]>;
  /** Set for reservations.create: the request and its first attempt's plan, shown in the pipeline and rows. */
  planned?: Planned;
  request?: Req;
  pick?: { nodeId: string; roll: number; both: boolean };
  marks?: Record<string, Mark[]>;
  flash?: { nodeId: string; at: number };
  verdict?: Verdict;
  settle: number;
}

function tracer(step = 0.16) {
  const lines: TraceLine[] = [];
  let at = 0;
  return {
    lines,
    add(text: string, options: { actor?: Actor; tone?: Tone } = {}) {
      lines.push({ ...options, text, at });
      at += step;
      return at - step;
    },
  };
}

function highlight(
  into: Record<string, Highlight[]>,
  atoms: readonly string[],
  kind: Highlight['kind'],
  at: number,
) {
  for (const atom of atoms) (into[atom] ??= []).push({ kind, at });
}

function addMark(into: Record<string, Mark[]>, nodeId: string, mark: Mark) {
  (into[nodeId] ??= []).push(mark);
}

// --- The component ---------------------------------------------------------------------------------

type Stage = 'selector' | 'shortlist' | 'filters' | 'pick' | 'scorers' | 'choose';
type GateState = 'pass' | 'fail' | 'skip';

/** How far apart the pipeline's stages light up, in seconds. */
const GATE_STEP = 0.14;

export function PlacementDemo() {
  const [request, setRequest] = useState<Req>(initialRequest);
  const [sim, setSim] = useState<Sim>(initialSim);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Every change replays the pipeline, even when its result stays the same.
  const [run, setRun] = useState(0);
  const [focus, setFocus] = useState<Stage | null>(null);
  const rng = useRef(mulberry32(seed));
  const outcomes = useRef(0);
  const flowRef = useRef<HTMLOListElement>(null);
  const shown = useInView(flowRef, { once: true, amount: 0.5 });
  const reduced = useReducedMotionSafe();
  const hintId = useId();
  const d = (seconds: number) => (reduced ? 0 : seconds);

  const preview = useMemo(
    () => planInline(request, sim.bookings, []),
    [request, sim.bookings],
  );
  const result = outcome?.planned ? outcome : undefined;
  const planned = result?.planned ?? preview;
  const ranked = planned.full.ranked;
  const live = sim.reservations.filter(isLive).length;

  function choose<K extends keyof Req>(key: K, value: Req[K]) {
    setRequest((current) => ({ ...current, [key]: value }));
    // The last call's trace stays; the pipeline goes back to planning the new request.
    setOutcome((current) =>
      current?.planned
        ? {
            ...current,
            planned: undefined,
            request: undefined,
            pick: undefined,
            marks: undefined,
            flash: undefined,
            verdict: undefined,
          }
        : current,
    );
    setRun((count) => count + 1);
  }

  function apply(next: Sim, partial: Omit<Outcome, 'id'>) {
    outcomes.current += 1;
    setSim({ ...next, reservations: prune(next.reservations) });
    setOutcome({ ...partial, id: outcomes.current });
    setRun((count) => count + 1);
    setFocus(null);
  }

  function reset() {
    rng.current = mulberry32(seed);
    setSim(initialSim);
    setOutcome(null);
    setRequest(initialRequest);
    setRun((count) => count + 1);
  }

  /** `reservations.create` once, through the inline placer. */
  function reserve() {
    if (live >= liveLimit) return;
    const number = sim.next;
    const id = `rsv_${number}`;
    const alloc = `alloc_${number}`;
    const first = planInline(request, sim.bookings, []);
    const roll = rng.current();
    const choice = choosePlan(first.plan.ranked, roll);
    const t = tracer();
    const highlights: Record<string, Highlight[]> = {};
    const marks: Record<string, Mark[]> = {};
    t.add(
      `reservations.create ${id}: tx 1 writes the draft, better-iam allows compute:reservations:create`,
    );
    t.add(`tx 2: chargeQuota gpu +${request.count}`);
    t.add(describePlan(first));
    if (!choice) {
      const reason = summarizeRejections(first.plan.rejected);
      t.add('choosePlan: nothing ranked, nothing to commit');
      const at = t.add(`draft → pending · Unschedulable (NoFit): ${reason}`, { tone: 'refused' });
      t.add('capacity.reservations retries it every 30 s, up to maxPending (24 h by default)', {
        tone: 'note',
      });
      apply(
        {
          ...sim,
          next: number + 1,
          reservations: [
            ...sim.reservations,
            { id, order: number, state: 'pending', request, reason },
          ],
        },
        {
          call: 'reservations.create',
          chip: { label: 'pending', tone: 'hatch' },
          trace: t.lines,
          highlights,
          planned: first,
          request,
          verdict: {
            tone: 'hatch',
            icon: 'pending',
            title: 'Pending',
            detail: 'Unschedulable · retried every 30 s',
          },
          settle: at,
        },
      );
      return;
    }
    const { plan, index, window } = choice;
    const n = plan.atoms.length;
    t.add(
      `choosePlan: random() ${roll.toFixed(2)} → ${plan.nodeId}, #${index + 1} of the top ${window}`,
    );
    t.add(`SELECT … FROM pools WHERE id = '${poolId}' FOR UPDATE`);
    t.add(
      `SAVEPOINT capacity_place_1 · ${plan.nodeId} FOR SHARE OF n · ${n} ${n === 1 ? 'atom' : 'atoms'} FOR SHARE`,
    );
    const at = t.add(
      `INSERT INTO device_bookings … ON CONFLICT DO NOTHING RETURNING device_id → ${n} of ${n} rows`,
      { tone: 'ok' },
    );
    t.add(`RELEASE SAVEPOINT · ${alloc} on ${plan.nodeId} · draft → placed`, { tone: 'ok' });
    highlight(highlights, plan.atoms, 'fill', at);
    addMark(marks, plan.nodeId, { label: id, tone: 'ink', at });
    apply(
      {
        bookings: book(sim.bookings, plan.atoms, alloc),
        next: number + 1,
        reservations: [
          ...sim.reservations,
          {
            id,
            order: number,
            state: 'placed',
            request,
            nodeId: plan.nodeId,
            atoms: plan.atoms,
            allocationId: alloc,
          },
        ],
      },
      {
        call: 'reservations.create',
        chip: { label: 'placed', tone: 'ink' },
        trace: t.lines,
        highlights,
        planned: first,
        request,
        pick: { nodeId: plan.nodeId, roll, both: false },
        marks,
        verdict: {
          tone: 'ink',
          icon: 'placed',
          title: 'Placed',
          detail: `${id} · ${n} GPU${n === 1 ? '' : 's'} on ${plan.nodeId}`,
        },
        settle: at,
      },
    );
  }

  /**
   * Two `reservations.create` calls at the same instant. Both plan on plain reads of one snapshot and (the case
   * shown) draw the same node; the pool lock orders their commits, and the second insert meets the first's rows.
   */
  function race() {
    if (live + 2 > liveLimit) return;
    const number = sim.next;
    const [idA, idB] = [`rsv_${number}`, `rsv_${number + 1}`];
    const [allocA, allocB] = [`alloc_${number}`, `alloc_${number + 1}`];
    const first = planInline(request, sim.bookings, []);
    const roll = rng.current();
    const choice = choosePlan(first.plan.ranked, roll);
    const t = tracer(0.17);
    const highlights: Record<string, Highlight[]> = {};
    const marks: Record<string, Mark[]> = {};
    t.add(`reservations.create ${idA} and ${idB} at once: both drafts allowed, quota charged`, {
      actor: 'A+B',
    });
    t.add(`${describePlan(first)}, from the same snapshot`, { actor: 'A+B' });
    if (!choice) {
      const reason = summarizeRejections(first.plan.rejected);
      const at = t.add(`nothing ranked: both go pending · Unschedulable (NoFit): ${reason}`, {
        actor: 'A+B',
        tone: 'refused',
      });
      apply(
        {
          ...sim,
          next: number + 2,
          reservations: [
            ...sim.reservations,
            { id: idA, order: number, state: 'pending', request, reason },
            { id: idB, order: number + 1, state: 'pending', request, reason },
          ],
        },
        {
          call: 'reservations.create ×2',
          chip: { label: 'both pending', tone: 'hatch' },
          trace: t.lines,
          highlights,
          planned: first,
          request,
          verdict: {
            tone: 'hatch',
            icon: 'pending',
            title: 'Both pending',
            detail: 'Unschedulable · nothing fits',
          },
          settle: at,
        },
      );
      return;
    }
    const nodeId = choice.plan.nodeId;
    const atoms = choice.plan.atoms;
    const n = atoms.length;
    t.add(`choosePlan: both drew ${nodeId} (random() ${roll.toFixed(2)})`, { actor: 'A+B' });
    t.add(`SELECT … FROM pools … FOR UPDATE: A takes the pool lock, B waits for it`, {
      actor: 'A',
    });
    const atA = t.add(
      `SAVEPOINT capacity_place_1 · INSERT INTO device_bookings … → ${n} of ${n} rows · COMMIT`,
      { actor: 'A', tone: 'ok' },
    );
    highlight(highlights, atoms, 'fill', atA);
    addMark(marks, nodeId, { label: 'A', tone: 'ink', at: atA });
    let bookings = book(sim.bookings, atoms, allocA);
    const reservations: Reservation[] = [
      ...sim.reservations,
      {
        id: idA,
        order: number,
        state: 'placed',
        request,
        nodeId,
        atoms,
        allocationId: allocA,
      },
    ];
    t.add(`gets the pool lock · SAVEPOINT capacity_place_1 · ${nodeId} FOR SHARE OF n`, {
      actor: 'B',
    });
    const atB = t.add(
      `INSERT … ON CONFLICT DO NOTHING → 0 of ${n} rows: EXCLUDE (device_id WITH =, during WITH &&) refused them`,
      { actor: 'B', tone: 'refused' },
    );
    highlight(highlights, atoms, 'conflict', atB);
    addMark(marks, nodeId, { label: 'B', tone: 'hatch', at: atB });
    t.add(`ROLLBACK TO SAVEPOINT capacity_place_1: an atom on ${nodeId} was booked concurrently`, {
      actor: 'B',
    });
    // Attempt 2 of `maxAttempts`, without the node it lost.
    const second = planInline(request, bookings, [nodeId]);
    const roll2 = rng.current();
    const retry = choosePlan(second.plan.ranked, roll2);
    let verdict: Verdict;
    let chip: Outcome['chip'];
    let settle: number;
    if (retry) {
      const m = retry.plan.atoms.length;
      t.add(
        `replans without ${nodeId} (attempt 2 of ${maxAttempts}) → ${second.plan.ranked.length} ranked · random() ${roll2.toFixed(2)} → ${retry.plan.nodeId}`,
        { actor: 'B' },
      );
      settle = t.add(
        `SAVEPOINT capacity_place_2 · INSERT … → ${m} of ${m} rows · draft → placed`,
        { actor: 'B', tone: 'ok' },
      );
      highlight(highlights, retry.plan.atoms, 'fill', settle);
      addMark(marks, retry.plan.nodeId, { label: 'B', tone: 'ink', at: settle });
      bookings = book(bookings, retry.plan.atoms, allocB);
      reservations.push({
        id: idB,
        order: number + 1,
        state: 'placed',
        request,
        nodeId: retry.plan.nodeId,
        atoms: retry.plan.atoms,
        allocationId: allocB,
      });
      verdict = {
        tone: 'ink',
        icon: 'placed',
        title: 'A and B placed',
        detail: `B moved to ${retry.plan.nodeId} after one conflict`,
      };
      chip = { label: 'both placed', tone: 'ink' };
    } else {
      // `placeSingle` leaves the `excluded` rejections out of the reason once it has conflicts.
      const why = summarizeRejections(
        second.full.rejected.filter((rejection) => rejection.filter !== 'excluded'),
      );
      const reason = `${why}; after conflicts: an atom on ${nodeId} was booked concurrently`;
      t.add(`replans without ${nodeId} (attempt 2 of ${maxAttempts}) → nothing ranked`, {
        actor: 'B',
      });
      settle = t.add(`draft → pending · Unschedulable (NoFit): ${reason}`, {
        actor: 'B',
        tone: 'refused',
      });
      reservations.push({ id: idB, order: number + 1, state: 'pending', request, reason });
      verdict = {
        tone: 'hatch',
        icon: 'pending',
        title: 'A placed, B pending',
        detail: 'B: Unschedulable after a conflict',
      };
      chip = { label: 'A placed · B pending', tone: 'hatch' };
    }
    t.add(
      "A plain INSERT would have raised SQLSTATE 23P01 (exclusion_violation). The guarded one returns fewer rows instead, so B's transaction lives on to replan.",
      { tone: 'note' },
    );
    apply(
      { bookings, next: number + 2, reservations },
      {
        call: 'reservations.create ×2',
        chip,
        trace: t.lines,
        highlights,
        planned: first,
        request,
        pick: { nodeId, roll, both: true },
        marks,
        flash: { nodeId, at: atB },
        verdict,
        settle,
      },
    );
  }

  /** A writer that ignores the placer and its locks: only the EXCLUDE constraint stands in its way. */
  function rawInsert() {
    const mine = [...sim.reservations]
      .sort((a, b) => b.order - a.order)
      .find((reservation) => reservation.state === 'placed');
    const target = mine?.atoms?.[0] ?? 'node_a-gpu0';
    const t = tracer();
    const highlights: Record<string, Highlight[]> = {};
    t.add(`a lock-ignoring writer skips the placer and books ${target}, which is taken`, {
      tone: 'note',
    });
    t.add(
      `INSERT INTO device_bookings (device_id, allocation_id, during) VALUES ('${target}', 'alloc_intruder', tstzrange(compute_now(), compute_now() + interval '1 hour'))`,
    );
    const at = t.add(
      'ERROR 23P01 exclusion_violation: conflicting key value violates exclusion constraint',
      { tone: 'refused' },
    );
    t.add(
      'EXCLUDE USING gist (device_id WITH =, during WITH &&) allows one live booking per atom per instant, whatever the scheduler or API does',
      { tone: 'note' },
    );
    highlight(highlights, [target], 'conflict', at);
    apply(sim, {
      call: 'INSERT INTO device_bookings',
      chip: { label: 'SQLSTATE 23P01', tone: 'hatch' },
      trace: t.lines,
      highlights,
      settle: at,
    });
  }

  /** `reservations.release`, then `wakePendingReservations` retries the pool's pending ones, oldest first. */
  function release(id: string) {
    const target = sim.reservations.find((reservation) => reservation.id === id);
    if (!target || !isLive(target)) return;
    const t = tracer();
    const highlights: Record<string, Highlight[]> = {};
    let bookings = sim.bookings;
    let reservations = sim.reservations.map((reservation) => ({ ...reservation }));
    const released = reservations.find((reservation) => reservation.id === id)!;
    const n = target.request.count;
    let settle: number;
    if (target.state === 'placed') {
      t.add(`reservations.release ${id}: placed → releasing → released`);
      settle = t.add(
        `releaseAllocation ${target.allocationId}: future bookings deleted, the current one truncated at compute_now()`,
        { tone: 'ok' },
      );
      t.add(`refundQuota gpu −${n} · pool rollup allocated −${n}`);
      highlight(highlights, target.atoms ?? [], 'clear', settle);
      bookings = unbook(bookings, target.atoms ?? []);
      released.state = 'released';
    } else {
      settle = t.add(`reservations.release ${id}: pending → cancelled, nothing was booked`, {
        tone: 'ok',
      });
      t.add(`refundQuota gpu −${n}`);
      released.state = 'cancelled';
    }
    const waiting = reservations
      .filter((reservation) => reservation.state === 'pending')
      .sort((a, b) => a.order - b.order);
    if (waiting.length > 0) {
      t.add(
        `wakePendingReservations: capacity.reservations retries ${waiting.length} pending now, oldest first`,
      );
      for (const pending of waiting) {
        const retry = planInline(pending.request, bookings, []);
        const roll = rng.current();
        const choice = choosePlan(retry.plan.ranked, roll);
        if (choice) {
          const alloc = `alloc_${pending.order}`;
          settle = t.add(
            `${pending.id}: random() ${roll.toFixed(2)} → ${choice.plan.nodeId} · pending → placed`,
            { tone: 'ok' },
          );
          highlight(highlights, choice.plan.atoms, 'fill', settle);
          bookings = book(bookings, choice.plan.atoms, alloc);
          reservations = reservations.map((reservation) =>
            reservation.id === pending.id
              ? {
                  ...reservation,
                  state: 'placed',
                  nodeId: choice.plan.nodeId,
                  atoms: choice.plan.atoms,
                  allocationId: alloc,
                  reason: undefined,
                }
              : reservation,
          );
        } else {
          t.add(`${pending.id}: still pending · ${summarizeRejections(retry.plan.rejected)}`, {
            tone: 'note',
          });
        }
      }
    }
    apply(
      { ...sim, bookings, reservations },
      {
        call: 'reservations.release',
        chip: {
          label: released.state === 'released' ? 'released' : 'cancelled',
          tone: 'plain',
        },
        trace: t.lines,
        highlights,
        settle,
      },
    );
  }

  // --- The pipeline strip ---

  const pickedPlan = result?.pick
    ? ranked.find((plan) => plan.nodeId === result.pick!.nodeId)
    : undefined;
  const top = pickedPlan ?? ranked[0];
  const selector = selectorOptions[request.selector];
  const shownSelector = selectorOptions[(result?.request ?? request).selector];
  const gates: { stage: Stage; title: string; state: GateState; outcome: string }[] = [
    {
      stage: 'selector',
      title: 'Selector',
      state: 'pass',
      outcome: shownSelector.expressions
        ? shownSelector.expressions
            .map((expression) => `${expression.key} ${expression.op} ${expression.values.join(', ')}`)
            .join(', ')
        : 'none: every atom',
    },
    {
      stage: 'shortlist',
      title: 'Shortlist',
      state: planned.mode === 'shortlist' ? 'pass' : 'skip',
      outcome:
        planned.mode === 'shortlist'
          ? `${planned.shortlisted.length} of ${nodes.length} nodes`
          : planned.mode === 'selector'
            ? 'skipped: selector'
            : 'undecided: whole pool',
    },
    {
      stage: 'filters',
      title: 'Filters',
      state: ranked.length > 0 ? 'pass' : 'fail',
      outcome: `${ranked.length} fit · ${nodes.length - ranked.length} out`,
    },
    {
      stage: 'pick',
      title: 'Atom pick',
      state: top ? 'pass' : 'skip',
      outcome: top
        ? `${top.nodeId}: ${top.worstLink ?? '1 GPU'} · ${top.numa} NUMA`
        : 'not reached',
    },
    {
      stage: 'scorers',
      title: 'Scorers',
      state: top ? 'pass' : 'skip',
      outcome: top ? `${top.nodeId}: ${fmt(top.score)}` : 'not reached',
    },
    {
      stage: 'choose',
      title: 'Pick',
      state: ranked.length > 0 ? 'pass' : 'skip',
      outcome: result?.pick
        ? result.pick.both
          ? `both → ${result.pick.nodeId}`
          : `${result.pick.roll.toFixed(2)} → ${result.pick.nodeId}`
        : ranked.length > 0
          ? `random of top ${Math.min(topN, ranked.length)}`
          : 'not reached',
    },
  ];
  const verdict: Verdict = result?.verdict ??
    (ranked.length > 0
      ? {
          tone: 'plain',
          icon: 'ready',
          title: 'Ready to place',
          detail: `${ranked.length} ranked · best ${fmt(ranked[0]!.score)}`,
        }
      : {
          tone: 'hatch',
          icon: 'pending',
          title: 'Would go pending',
          detail: 'Unschedulable · NoFit',
        });
  const verdictAt = result ? result.settle : gates.length * GATE_STEP;

  // Candidate atoms show while planning, not after a commit.
  const candidates = new Set(result ? [] : ranked.flatMap((plan) => plan.atoms));
  const windowIds = new Set(ranked.slice(0, topN).map((plan) => plan.nodeId));
  const atLimit = live >= liveLimit;
  const list = [...sim.reservations].sort((a, b) => b.order - a.order);
  const changed = outcome !== null || sim !== initialSim;

  const hover = (stage: Stage) => ({
    onPointerEnter: () => setFocus(stage),
    onPointerLeave: () => setFocus(null),
    onFocus: () => setFocus(stage),
    onBlur: () => setFocus(null),
  });

  return (
    <DiagramFrame
      live
      label={
        <>
          <span className="font-mono text-text-primary">reservations.create</span> →{' '}
          <span className="font-mono text-text-primary">{poolId}</span> · inline placer
        </>
      }
      actions={
        <AnimatePresence initial={false}>
          {changed ? (
            <motion.span
              key="reset"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 6 }}
              transition={{ duration: 0.2 }}
            >
              <ReplayButton onClick={reset} label="Reset" />
            </motion.span>
          ) : null}
        </AnimatePresence>
      }
      footer={
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span>
            A port of <span className="font-mono">planPlacement</span> and the inline placer from
            @better-compute/capacity, run in your browser. The database is simulated.
          </span>
          <Link
            href="/docs/reference/api/reservations"
            className="group/link inline-flex items-center gap-1 rounded-sm text-caption-1-medium text-text-primary underline-offset-4 hover:underline"
          >
            Reservations API
            <RiArrowRightLine
              className="size-3.5 transition-transform duration-200 group-hover/link:translate-x-0.5"
              aria-hidden
            />
          </Link>
        </span>
      }
    >
      <div className="@container">
        <div className="grid gap-6 @3xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
          {/* The request */}
          <div className="flex min-w-0 flex-col gap-3">
            <p className="eyebrow">Request</p>
            <Segmented
              label="GPUs"
              value={request.count}
              options={[1, 2, 4, 8].map((value) => ({ value, label: String(value) }))}
              onChange={(value) => choose('count', value)}
            />
            <Segmented
              label="Topology"
              value={request.topology}
              mono
              options={[
                { value: 'any' as const, label: 'any' },
                { value: 'nvlink-all' as const, label: 'nvlink-all' },
              ]}
              onChange={(value) => choose('topology', value)}
            />
            <Segmented
              label="Selector"
              value={request.selector}
              lit={focus === 'selector'}
              options={(['none', 'sxm5', 'vram'] as const).map((value) => ({
                value,
                label: selectorOptions[value].label,
              }))}
              onChange={(value) => choose('selector', value)}
            />
            <div className="rounded-lg border border-dashed border-border-button-default px-3 py-2.5">
              <p className="mb-1.5 text-caption-2-regular text-text-secondary">
                The same request from the CLI
              </p>
              <code className="block font-mono text-caption-2-regular leading-5 [overflow-wrap:anywhere] text-text-primary">
                <span className="text-text-tertiary select-none">$ </span>
                better-compute reserve --pool {poolId} --gpus {request.count} --for 8h
                {request.topology === 'nvlink-all' ? ' --nvlink' : ''}
                {selector.shorthand ? (
                  <span
                    className={cx(
                      'rounded-sm transition-colors duration-200',
                      focus === 'selector' && 'bg-background-secondary-default',
                    )}
                  >
                    {` --selector "${selector.shorthand}"`}
                  </span>
                ) : null}
              </code>
              <p className="mt-1.5 font-mono text-caption-2-regular leading-4 [overflow-wrap:anywhere] text-text-secondary">
                {selector.expressions
                  ? `parseSelector → ${selector.expressions.map(formatExpression).join(', ')}`
                  : 'POST /api/compute/reservations/create'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                leadingIcon={RiAddLine}
                onClick={reserve}
                disabled={atLimit}
                aria-describedby={hintId}
              >
                Reserve
              </Button>
              <Button
                size="small"
                variant="secondary"
                leadingIcon={RiFlashlightLine}
                onClick={race}
                disabled={live + 2 > liveLimit}
                aria-describedby={hintId}
              >
                Race two requests
              </Button>
              <Button
                size="small"
                variant="ghost"
                leadingIcon={RiDatabase2Line}
                onClick={rawInsert}
                aria-describedby={hintId}
              >
                Raw INSERT
              </Button>
            </div>
            <p id={hintId} className="text-caption-2-regular leading-4 text-text-tertiary">
              {atLimit || live + 2 > liveLimit
                ? 'Demo limit reached: release a reservation to make room.'
                : 'Race sends two calls at the same instant: both plan from one snapshot and draw the same node. Raw INSERT skips the placer and books a GPU that is taken.'}
            </p>
          </div>

          {/* The pool */}
          <div className="@container flex min-w-0 flex-col gap-2">
            <p className="eyebrow">
              Pool · {poolId} · {nodes.length * 8} GPUs
            </p>
            <div
              aria-hidden
              className="hidden grid-cols-[6.5rem_9.5rem_repeat(4,minmax(0,1fr))_3.5rem] gap-x-2 border border-transparent px-3 text-caption-2-regular leading-4 text-text-tertiary @xl:grid"
            >
              <span>node</span>
              <span>GPU atoms, NUMA 0 | 1</span>
              {scorers.map((scorer) => (
                <span key={scorer.id} className="flex flex-col">
                  <span className="text-text-secondary">{scorer.label}</span>
                  <span className="font-mono">×{scorer.weight}</span>
                </span>
              ))}
              <span className="text-right text-text-secondary">score</span>
            </div>
            <ul aria-label={`Nodes in ${poolId}`} className="flex flex-col gap-2 pt-1">
              {nodes.map((node) => {
                const rank = ranked.findIndex((plan) => plan.nodeId === node.id);
                const plan = rank >= 0 ? ranked[rank] : undefined;
                const rejection = planned.full.rejected.find((entry) => entry.nodeId === node.id);
                const dropped = planned.mode === 'shortlist' && !planned.shortlisted.includes(node.id);
                const dim =
                  (focus === 'shortlist' && dropped) ||
                  (focus === 'filters' && plan !== undefined) ||
                  ((focus === 'pick' || focus === 'scorers') && plan === undefined) ||
                  (focus === 'choose' && !windowIds.has(node.id));
                return (
                  <NodeRow
                    key={node.id}
                    node={node}
                    rank={rank}
                    plan={plan}
                    filter={dropped ? 'shortlist' : rejection?.filter}
                    reason={rejection?.reason}
                    bookings={sim.bookings}
                    candidates={candidates}
                    highlights={outcome?.highlights}
                    outcomeId={outcome?.id ?? 0}
                    marks={result?.marks?.[node.id]}
                    flash={result?.flash?.nodeId === node.id ? result.flash.at : undefined}
                    dim={dim}
                    litReason={focus === 'filters' || (focus === 'shortlist' && dropped)}
                    litScores={focus === 'scorers' || focus === 'choose'}
                    litAtoms={focus === 'pick'}
                    d={d}
                    reduced={reduced}
                  />
                );
              })}
            </ul>
            <Legend />
          </div>
        </div>

        {/* The pipeline */}
        <div className="mt-6 border-t border-separator-border pt-5">
          <ol
            ref={flowRef}
            aria-label="Placement pipeline"
            className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @4xl:grid-cols-[repeat(6,minmax(0,1fr))_minmax(0,1.5fr)] @4xl:gap-0"
          >
            {gates.map((gate, index) => {
              const delay = d(index * GATE_STEP);
              const emphasized = focus === gate.stage;
              return (
                <li key={gate.stage} className="flex min-w-0 items-center">
                  <motion.div
                    key={run}
                    tabIndex={0}
                    role="group"
                    aria-label={`${gate.title}: ${gate.outcome}`}
                    {...hover(gate.stage)}
                    className={cx(
                      'relative flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border px-2.5 py-2 transition-[translate,box-shadow,border-color] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised',
                      gate.state === 'pass' && 'border-text-primary bg-background-primary-default',
                      gate.state === 'fail' &&
                        'hatch border-text-primary bg-background-primary-default',
                      gate.state === 'skip' && 'border-dashed border-border-button-hover',
                      emphasized && '-translate-y-0.5 shadow-sm',
                    )}
                    initial={{ opacity: 0.2, y: 6 }}
                    animate={
                      shown ? { opacity: gate.state === 'skip' ? 0.55 : 1, y: 0 } : undefined
                    }
                    transition={{ delay, duration: reduced ? 0 : 0.35, ease }}
                  >
                    <span className="flex items-center gap-1.5 text-caption-1-medium text-text-primary">
                      <GateIcon state={gate.state} shown={shown} delay={delay} />
                      <span className="truncate">{gate.title}</span>
                    </span>
                    <span
                      className="truncate font-mono text-caption-2-regular leading-4 text-text-secondary"
                      title={gate.outcome}
                    >
                      {gate.outcome}
                    </span>
                  </motion.div>
                  <span
                    aria-hidden
                    className="relative mx-1 hidden h-px w-3 shrink-0 bg-border-button-default @4xl:block"
                  >
                    <motion.span
                      key={run}
                      className={cx(
                        'absolute inset-0 origin-left',
                        gate.state === 'pass' ? 'bg-text-primary' : 'bg-border-button-hover',
                      )}
                      initial={{ scaleX: 0 }}
                      animate={shown ? { scaleX: 1 } : undefined}
                      transition={{ delay: delay + d(0.15), duration: reduced ? 0 : 0.25, ease }}
                    />
                  </span>
                </li>
              );
            })}
            <li className="col-span-2 min-w-0 @lg:col-span-3 @4xl:col-span-1">
              <VerdictCard
                verdict={verdict}
                keyId={`${outcome?.id ?? 0}-${run}`}
                at={run === 0 ? 0 : d(verdictAt)}
                shown={shown}
              />
            </li>
          </ol>
        </div>

        {/* What ran, and what you hold */}
        <div className="mt-6 grid gap-6 @3xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.55fr)]">
          <div className="flex min-w-0 flex-col rounded-xl border border-border-button-default bg-background-primary-default p-3.5 shadow-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <p className="eyebrow">Transaction trace</p>
              {outcome ? (
                <span
                  aria-live="polite"
                  className={cx(
                    'ms-auto inline-flex max-w-full items-center gap-1.5 truncate rounded-md border px-1.5 py-0.5 font-mono text-caption-2-regular',
                    outcome.chip.tone === 'ink' &&
                      'border-text-primary bg-text-primary text-background-full',
                    outcome.chip.tone === 'hatch' &&
                      'hatch border-text-primary bg-background-primary-default text-text-primary',
                    outcome.chip.tone === 'plain' &&
                      'border-border-button-hover text-text-primary',
                  )}
                >
                  {outcome.call} → {outcome.chip.label}
                </span>
              ) : null}
            </div>
            {outcome ? (
              <ol key={outcome.id} className="mt-3 flex flex-col gap-1.5">
                {outcome.trace.map((line, index) => (
                  <motion.li
                    key={index}
                    className="flex min-w-0 items-start gap-2"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: d(line.at), duration: reduced ? 0 : 0.25, ease }}
                  >
                    <ActorBadge actor={line.actor} />
                    <span
                      className={cx(
                        'min-w-0 font-mono text-caption-2-regular leading-4 [overflow-wrap:anywhere]',
                        line.tone === 'ok' && 'text-text-primary',
                        line.tone === 'refused' &&
                          'hatch -my-0.5 rounded-md border border-text-primary px-1.5 py-0.5 text-text-primary',
                        line.tone === 'note' && 'text-text-tertiary',
                        line.tone === undefined && 'text-text-secondary',
                      )}
                    >
                      {line.text}
                    </span>
                  </motion.li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-body-2-regular leading-5 text-text-secondary">
                Nothing has run yet. <span className="text-text-primary">Reserve</span> sends one{' '}
                <span className="font-mono text-caption-1-regular">reservations.create</span>{' '}
                through the inline placer; <span className="text-text-primary">Race</span> sends
                two for the same GPUs at once.
              </p>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <p className="eyebrow">Your reservations</p>
            {list.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                <AnimatePresence initial={false}>
                  {list.map((reservation) => (
                    <motion.li
                      key={reservation.id}
                      layout={!reduced}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: reduced ? 0 : 0.25, ease }}
                      className={cx(
                        'flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5',
                        isLive(reservation)
                          ? 'border-border-button-default bg-background-primary-default shadow-xs'
                          : 'border-dashed border-border-button-default',
                      )}
                    >
                      <StateChip state={reservation.state} />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-mono text-caption-1-medium text-text-primary">
                          {reservation.id}
                        </span>
                        <span
                          className="truncate text-caption-2-regular text-text-secondary"
                          title={reservation.reason}
                        >
                          {reservation.state === 'pending'
                            ? `${reservation.request.count} GPU${reservation.request.count === 1 ? '' : 's'} · Unschedulable`
                            : reservation.nodeId
                              ? `${reservation.atoms?.length ?? 0} GPU${reservation.atoms?.length === 1 ? '' : 's'} · ${reservation.nodeId}`
                              : `${reservation.request.count} GPU${reservation.request.count === 1 ? '' : 's'}`}
                        </span>
                      </span>
                      {isLive(reservation) ? (
                        <Button
                          size="xs"
                          variant="secondary"
                          className="ms-auto shrink-0"
                          onClick={() => release(reservation.id)}
                          aria-label={`Release ${reservation.id}`}
                        >
                          Release
                        </Button>
                      ) : null}
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-border-button-default px-3 py-2.5 text-caption-1-regular text-text-secondary">
                None yet. Placed GPUs turn solid in the pool.
              </p>
            )}
          </div>
        </div>
      </div>
    </DiagramFrame>
  );
}

// --- Parts -----------------------------------------------------------------------------------------

/** A radio group drawn as a segmented control; arrow keys move the selection. */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  mono = false,
  lit = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  mono?: boolean;
  lit?: boolean;
}) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const index = options.findIndex((option) => option.value === value);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    buttons.current[next]?.focus();
  }

  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3">
      <span id={id} className="text-caption-1-regular text-text-secondary">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={id}
        onKeyDown={onKeyDown}
        className={cx(
          'flex w-fit max-w-full overflow-x-auto rounded-lg bg-segmented-control-background p-0.5 transition-shadow duration-200',
          lit && 'ring-1 ring-text-primary',
        )}
      >
        {options.map((option, position) => {
          const active = option.value === value;
          return (
            <button
              key={String(option.value)}
              ref={(element) => {
                buttons.current[position] = element;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={cx(
                segmentClass(active),
                'h-7 cursor-pointer px-2.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                mono && 'font-mono text-caption-1-medium',
              )}
            >
              {active ? (
                <motion.span
                  layoutId={`${id}-thumb`}
                  className="absolute inset-0 -z-10 rounded-md bg-segmented-control-selected-background shadow-xs"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              ) : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NodeRow({
  node,
  rank,
  plan,
  filter,
  reason,
  bookings,
  candidates,
  highlights,
  outcomeId,
  marks,
  flash,
  dim,
  litReason,
  litScores,
  litAtoms,
  d,
  reduced,
}: {
  node: SimNode;
  rank: number;
  plan?: NodePlan;
  filter?: string;
  reason?: string;
  bookings: Bookings;
  candidates: ReadonlySet<string>;
  highlights?: Record<string, Highlight[]>;
  outcomeId: number;
  marks?: Mark[];
  flash?: number;
  dim: boolean;
  litReason: boolean;
  litScores: boolean;
  litAtoms: boolean;
  d: (seconds: number) => number;
  reduced: boolean;
}) {
  const eligible = ineligibility(node) === undefined;
  return (
    <li
      className={cx(
        'relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 transition-[border-color,opacity,box-shadow] duration-300 @xl:grid-cols-[6.5rem_9.5rem_repeat(4,minmax(0,1fr))_3.5rem] @xl:gap-x-2',
        marks?.length
          ? 'border-text-primary bg-background-primary-default shadow-sm'
          : plan
            ? 'border-border-button-default bg-background-primary-default shadow-xs'
            : 'border-dashed border-border-button-hover',
        dim && 'opacity-50',
      )}
    >
      {flash !== undefined ? (
        <motion.span
          key={`flash-${outcomeId}`}
          aria-hidden
          className="hatch pointer-events-none absolute -inset-px rounded-lg border border-text-primary"
          initial={{ opacity: 0 }}
          animate={{ opacity: reduced ? 0 : [0, 1, 1, 0] }}
          transition={{ delay: d(flash), duration: reduced ? 0 : 1.5, times: [0, 0.1, 0.7, 1] }}
        />
      ) : null}
      {marks?.length ? (
        <span className="absolute -top-2 right-2 flex gap-1">
          {marks.map((mark, index) => (
            <motion.span
              key={`${outcomeId}-${index}`}
              className={cx(
                'rounded-full border px-1.5 font-mono text-[0.625rem] leading-4',
                mark.tone === 'ink'
                  ? 'border-text-primary bg-text-primary text-background-full'
                  : 'hatch border-text-primary bg-background-primary-default text-text-primary line-through',
              )}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: d(mark.at), duration: reduced ? 0 : 0.25, ease }}
            >
              {mark.label}
            </motion.span>
          ))}
        </span>
      ) : null}

      <div className="relative col-start-1 row-start-1 min-w-0">
        <p className="truncate font-mono text-caption-1-medium text-text-primary">{node.id}</p>
        <p className="truncate text-caption-2-regular text-text-secondary">
          {node.form} · {node.fabric}
        </p>
      </div>

      <div className="relative col-span-2 col-start-1 row-start-2 @xl:col-span-1 @xl:col-start-2 @xl:row-start-1">
        <AtomStrip
          node={node}
          eligible={eligible}
          bookings={bookings}
          candidates={candidates}
          highlights={highlights}
          outcomeId={outcomeId}
          emphasize={litAtoms}
          d={d}
          reduced={reduced}
        />
      </div>

      {plan ? (
        <>
          <dl
            className={cx(
              'relative col-span-2 col-start-1 row-start-3 -mx-1 flex flex-wrap gap-x-3 gap-y-0.5 rounded px-1 font-mono text-caption-2-regular leading-4 transition-colors duration-200 @xl:col-span-4 @xl:col-start-3 @xl:row-start-1 @xl:grid @xl:grid-cols-4 @xl:gap-x-2',
              litScores && 'bg-background-secondary-default',
            )}
          >
            {scorers.map((scorer) => (
              <div key={scorer.id} className="flex items-baseline gap-1">
                <dt className="text-text-tertiary @xl:sr-only">{scorer.label}</dt>
                <dd className="text-text-primary tabular-nums">{fmt(plan.scores[scorer.id])}</dd>
              </div>
            ))}
          </dl>
          <p
            className={cx(
              'relative col-start-2 row-start-1 -mx-1 rounded px-1 text-right font-mono leading-4 transition-colors duration-200 @xl:col-start-7',
              litScores && 'bg-background-secondary-default',
            )}
          >
            <span className="text-caption-2-regular text-text-tertiary">#{rank + 1} </span>
            <span className="text-caption-1-medium text-text-primary tabular-nums">
              {fmt(plan.score)}
            </span>
          </p>
        </>
      ) : (
        <p
          className={cx(
            'relative col-span-2 col-start-1 row-start-3 -mx-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1 font-mono text-caption-2-regular leading-4 transition-colors duration-200 @xl:col-span-5 @xl:col-start-3 @xl:row-start-1',
            litReason && 'bg-background-secondary-default',
          )}
        >
          <span className="rounded border border-dashed border-border-button-active px-1 text-text-primary">
            {filter ?? 'eligible'}
          </span>
          <span className="min-w-0 text-text-secondary [overflow-wrap:anywhere]">{reason}</span>
        </p>
      )}
    </li>
  );
}

/** Dense hatching that reads at 16px: another tenant's booking. Linear, from theme tokens. */
const takenHatch =
  'bg-[image:repeating-linear-gradient(-45deg,var(--color-text-secondary)_0_1px,transparent_1px_4px)]';
/** Ink hatching for a refused insert. */
const refusedHatch =
  'bg-[image:repeating-linear-gradient(-45deg,var(--color-text-primary)_0_1.5px,transparent_1.5px_4px)]';

function AtomStrip({
  node,
  eligible,
  bookings,
  candidates,
  highlights,
  outcomeId,
  emphasize,
  d,
  reduced,
}: {
  node: SimNode;
  eligible: boolean;
  bookings: Bookings;
  candidates: ReadonlySet<string>;
  highlights?: Record<string, Highlight[]>;
  outcomeId: number;
  emphasize: boolean;
  d: (seconds: number) => number;
  reduced: boolean;
}) {
  const counts = { yours: 0, taken: 0, free: 0, unhealthy: 0, next: 0 };
  for (const atom of node.devices) {
    const booking = bookings[atom.id];
    if (!atom.healthy) counts.unhealthy++;
    else if (booking?.mine) counts.yours++;
    else if (booking) counts.taken++;
    else counts.free++;
    if (candidates.has(atom.id)) counts.next++;
  }
  const label = [
    `${node.id} GPUs:`,
    counts.yours ? `${counts.yours} yours,` : '',
    counts.taken ? `${counts.taken} booked by another tenant,` : '',
    `${counts.free} free`,
    counts.unhealthy ? `, ${counts.unhealthy} unhealthy` : '',
    counts.next ? `; the plan would book ${counts.next}` : '',
    eligible ? '' : '; the node is not schedulable',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      role="img"
      aria-label={label}
      className={cx('flex w-fit items-center gap-1.5', !eligible && 'opacity-40')}
    >
      {[node.devices.slice(0, 4), node.devices.slice(4)].map((group, index) => (
        <span key={index} className="flex gap-[3px]">
          {group.map((atom) => (
            <AtomCell
              key={atom.id}
              atom={atom}
              booking={bookings[atom.id]}
              candidate={candidates.has(atom.id)}
              highlights={highlights?.[atom.id]}
              outcomeId={outcomeId}
              emphasize={emphasize}
              d={d}
              reduced={reduced}
            />
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * One GPU atom. Outline: free; ring with a dot: the current plan would book it; solid ink: your booking; dense
 * hatch: another tenant's; dashed with a cross: unhealthy. A refused insert flashes ink hatching and shakes.
 */
function AtomCell({
  atom,
  booking,
  candidate,
  highlights,
  outcomeId,
  emphasize,
  d,
  reduced,
}: {
  atom: Atom;
  booking?: Booking;
  candidate: boolean;
  highlights?: Highlight[];
  outcomeId: number;
  emphasize: boolean;
  d: (seconds: number) => number;
  reduced: boolean;
}) {
  const fill = highlights?.find((entry) => entry.kind === 'fill');
  const clear = highlights?.find((entry) => entry.kind === 'clear');
  const conflict = highlights?.find((entry) => entry.kind === 'conflict');
  const square = 'absolute inset-0 rounded-[4px] border';
  return (
    <motion.span
      key={conflict ? `shake-${outcomeId}` : 'still'}
      className={cx(
        'relative block size-4 shrink-0 transition-opacity duration-200',
        emphasize && !candidate && 'opacity-40',
      )}
      animate={conflict && !reduced ? { x: [0, -2, 2, -2, 1, 0] } : undefined}
      transition={{ delay: conflict ? d(conflict.at) : 0, duration: 0.4 }}
    >
      <span
        className={cx(
          square,
          atom.healthy
            ? 'border-border-button-hover bg-background-primary-default'
            : 'border-dashed border-text-tertiary',
        )}
      />
      {!atom.healthy ? (
        <RiCloseLine className="absolute inset-0 m-auto size-3 text-text-tertiary" aria-hidden />
      ) : null}
      {booking && !fill ? (
        <span
          className={cx(
            square,
            booking.mine
              ? 'border-text-primary bg-text-primary'
              : cx('border-text-secondary bg-background-primary-default', takenHatch),
          )}
        />
      ) : null}
      {clear ? (
        <motion.span
          key={`clear-${outcomeId}`}
          className={cx(square, 'border-text-primary bg-text-primary')}
          initial={{ opacity: 1, scale: 1 }}
          animate={{ opacity: 0, scale: 0.5 }}
          transition={{ delay: d(clear.at), duration: reduced ? 0 : 0.35, ease }}
        />
      ) : null}
      {fill ? (
        <motion.span
          key={`fill-${outcomeId}`}
          className={cx(square, 'border-text-primary bg-text-primary')}
          initial={{ opacity: 0, scale: 0.3 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={
            reduced
              ? { duration: 0 }
              : { delay: d(fill.at), type: 'spring', stiffness: 520, damping: 26 }
          }
        />
      ) : null}
      {candidate && !booking ? (
        <span className="absolute -inset-[3px] flex items-center justify-center rounded-[6px] border border-text-primary">
          <span className="size-1 rounded-full bg-text-primary" />
        </span>
      ) : null}
      {conflict ? (
        <motion.span
          key={`conflict-${outcomeId}`}
          className={cx(
            'absolute -inset-[3px] rounded-[6px] border border-text-primary bg-background-primary-default',
            refusedHatch,
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: reduced ? 0 : [0, 1, 1, 0] }}
          transition={{ delay: d(conflict.at), duration: reduced ? 0 : 1.5, times: [0, 0.1, 0.7, 1] }}
        />
      ) : null}
    </motion.span>
  );
}

function Legend() {
  const square = 'relative size-3 shrink-0 rounded-[3px] border';
  const items: { label: string; swatch: ReactNode }[] = [
    {
      label: 'free',
      swatch: <span className={cx(square, 'border-border-button-hover bg-background-primary-default')} />,
    },
    {
      label: 'plan would book',
      swatch: (
        <span className={cx(square, 'flex items-center justify-center border-text-primary')}>
          <span className="size-1 rounded-full bg-text-primary" />
        </span>
      ),
    },
    { label: 'yours', swatch: <span className={cx(square, 'border-text-primary bg-text-primary')} /> },
    {
      label: 'another tenant',
      swatch: <span className={cx(square, 'border-text-secondary', takenHatch)} />,
    },
    {
      label: 'unhealthy',
      swatch: <span className={cx(square, 'border-dashed border-text-tertiary')} />,
    },
  ];
  return (
    <ul aria-label="Legend" className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1">
      {items.map((item) => (
        <li
          key={item.label}
          className="flex items-center gap-1.5 text-caption-2-regular text-text-secondary"
        >
          {item.swatch}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function GateIcon({ state, shown, delay }: { state: GateState; shown: boolean; delay: number }) {
  if (state === 'skip')
    return (
      <span className="size-4 shrink-0 rounded-full border border-dashed border-text-tertiary" />
    );
  return (
    <motion.span
      className={cx(
        'flex size-4 shrink-0 items-center justify-center rounded-full',
        state === 'pass'
          ? 'bg-text-primary text-background-full'
          : 'border border-text-primary bg-background-primary-default text-text-primary',
      )}
      initial={{ scale: 0 }}
      animate={shown ? { scale: 1 } : undefined}
      transition={{ delay: delay + 0.12, type: 'spring', stiffness: 520, damping: 22 }}
    >
      {state === 'pass' ? (
        <RiCheckLine className="size-3" aria-hidden />
      ) : (
        <RiCloseLine className="size-3" aria-hidden />
      )}
    </motion.span>
  );
}

/** The placer's answer: ink when it placed, hatched when the request goes pending, an outline while planning. */
function VerdictCard({
  verdict,
  keyId,
  at,
  shown,
}: {
  verdict: Verdict;
  keyId: string;
  at: number;
  shown: boolean;
}) {
  const ink = verdict.tone === 'ink';
  const Icon =
    verdict.icon === 'placed'
      ? RiCheckLine
      : verdict.icon === 'pending'
        ? RiTimeLine
        : verdict.icon === 'refused'
          ? RiCloseLine
          : RiShuffleLine;
  return (
    <motion.div
      aria-live="polite"
      className={cx(
        'relative flex h-full min-h-14 items-center overflow-hidden rounded-lg border px-3 py-2',
        verdict.tone === 'plain' ? 'border-border-button-hover' : 'border-text-primary',
      )}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={shown ? { opacity: 1, scale: 1 } : undefined}
      transition={{ delay: at, duration: 0.35, ease }}
    >
      <span
        aria-hidden
        className={cx(
          'absolute inset-0 bg-background-primary-default',
          verdict.tone === 'hatch' && 'hatch',
        )}
      />
      <motion.span
        aria-hidden
        className="absolute inset-0 bg-text-primary"
        initial={false}
        animate={{ opacity: ink ? 1 : 0 }}
        transition={{ delay: at, duration: 0.35, ease }}
      />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={`${keyId}-${verdict.title}-${verdict.detail}`}
          className={cx(
            'relative flex min-w-0 items-center gap-2.5',
            ink ? 'text-background-full' : 'text-text-primary',
          )}
          initial={{ opacity: 0, y: 10, filter: 'blur(3px)' }}
          animate={{
            opacity: 1,
            y: 0,
            filter: 'blur(0px)',
            transition: { delay: at, duration: 0.35, ease },
          }}
          exit={{
            opacity: 0,
            y: -10,
            filter: 'blur(3px)',
            transition: { delay: at, duration: 0.3, ease },
          }}
        >
          <Icon className="size-5 shrink-0" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-body-semibold">{verdict.title}</span>
            <span
              className={cx(
                'truncate font-mono text-caption-2-regular',
                ink ? 'opacity-70' : 'text-text-secondary',
              )}
              title={verdict.detail}
            >
              {verdict.detail}
            </span>
          </span>
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

function ActorBadge({ actor }: { actor?: Actor }) {
  if (!actor) return <span aria-hidden className="w-7 shrink-0" />;
  return (
    <span
      className={cx(
        'inline-flex h-4 w-7 shrink-0 items-center justify-center rounded border font-mono text-[0.625rem] leading-none',
        actor === 'A' && 'border-text-primary bg-text-primary text-background-full',
        actor === 'B' && 'border-text-primary text-text-primary',
        actor === 'A+B' && 'border-dashed border-text-primary text-text-primary',
      )}
    >
      <span className="sr-only">request </span>
      {actor === 'A+B' ? 'A·B' : actor}
    </span>
  );
}

function StateChip({ state }: { state: ReservationState }) {
  return (
    <span
      className={cx(
        'shrink-0 rounded-full border px-1.5 font-mono text-[0.625rem] leading-4',
        state === 'placed' && 'border-text-primary bg-text-primary text-background-full',
        state === 'pending' && 'hatch border-text-primary text-text-primary',
        (state === 'released' || state === 'cancelled') &&
          'border-dashed border-border-button-hover text-text-tertiary',
      )}
    >
      {state}
    </span>
  );
}
