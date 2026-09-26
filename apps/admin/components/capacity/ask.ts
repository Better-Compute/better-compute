import { earliestFit } from '@better-compute/console-kit';
import { DAY, HOUR, type CapacitySnapshot, type CapacityTimeline } from '@/lib/data/capacity';
import { pools as topoPools } from '@/lib/data/topology';

// "Search for capacity": a tiny grammar for the palette. `16 h200 3d`, `2x8 b200 12h spot`, `8 gpus a100 for 2 days`.
// parseAsk reads it; rankAsk answers it from the timelines (earliest window per pool, cheapest first on ties).

export interface Ask {
  /** Total GPUs. */
  gpus: number;
  /** Explicit shape (`2x8`): nodes × GPUs per node. */
  shape?: { nodes: number; perNode: number };
  /** Lower-case short model names the ask names (`h100`, `b200`…); empty = any. */
  models: string[];
  durationMs: number;
  spot: boolean;
}

const MODELS = [...new Set(topoPools.filter((pool) => pool.kind === 'gpu').map((pool) => pool.short.toLowerCase().replace(/\s+/g, '')))];

export function parseAsk(query: string): Ask | undefined {
  const text = ` ${query.toLowerCase()} `;
  const shape = /\b(\d{1,2})\s*[x×]\s*(\d{1,2})\b/.exec(text);
  const count = shape ? undefined : /\b(\d{1,4})\s*(?:x\s*)?(?:gpus?\b)?/.exec(text.replace(/\b\d+\s*(?:h|hr|hrs|hours?|d|days?|w|wk|weeks?)\b/g, ' '));
  const duration = /\b(\d{1,3}(?:\.\d+)?)\s*(h|hr|hrs|hours?|d|days?|w|wk|weeks?)\b/.exec(text);
  const models = MODELS.filter((model) => new RegExp(`\\b${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text.replace(/\s+mig\b/, 'mig')));
  const gpus = shape ? Number(shape[1]) * Number(shape[2]) : count ? Number(count[1]) : 0;
  // Needs a size and one more hint (a model or a duration), so ordinary searches ("h100", "rsv_12") don't trigger.
  if (!(gpus > 0) || gpus > 4096 || (!models.length && !duration)) return undefined;
  const unit = duration?.[2] ?? 'd';
  const amount = duration ? Number(duration[1]) : 1;
  const durationMs = amount * (unit.startsWith('w') ? 7 * DAY : unit.startsWith('d') ? DAY : HOUR);
  if (!(durationMs >= HOUR) || durationMs > 90 * DAY) return undefined;
  return {
    gpus,
    ...(shape ? { shape: { nodes: Number(shape[1]), perNode: Number(shape[2]) } } : {}),
    models,
    durationMs,
    spot: /\bspot\b/.test(text),
  };
}

export interface AskAnswer {
  poolId: string;
  name: string;
  short: string;
  siteId: string;
  /** Earliest start (ms) or undefined when not within the timelines. */
  start?: number;
  perNode: number;
  nodes: number;
  cost: number;
}

/**
 * Per matching GPU pool: the shape (explicit, or whole nodes when the ask is larger than one node), the earliest
 * pool-wide window from `timelineOf`, and the list-price cost. Soonest first, then cheapest.
 */
export function rankAsk(ask: Ask, snapshot: CapacitySnapshot, timelineOf: (poolId: string) => CapacityTimeline | undefined): AskAnswer[] {
  const out: AskAnswer[] = [];
  for (const pool of topoPools) {
    if (pool.kind !== 'gpu') continue;
    if (!snapshot.pools.some((entry) => entry.id === pool.id)) continue;
    const short = pool.short.toLowerCase().replace(/\s+/g, '');
    if (ask.models.length && !ask.models.includes(short)) continue;
    const perNodeMax = snapshot.nodes.find((node) => node.poolId === pool.id)?.gpus ?? pool.gpusPerNode;
    const shape = ask.shape ?? (ask.gpus <= perNodeMax ? { nodes: 1, perNode: ask.gpus } : { nodes: Math.ceil(ask.gpus / perNodeMax), perNode: perNodeMax });
    if (shape.perNode > perNodeMax || shape.nodes > 8) continue;
    const timeline = timelineOf(pool.id);
    const total = shape.nodes * shape.perNode;
    const start = timeline ? earliestFit(timeline, total, ask.durationMs, { notBefore: Math.floor(snapshot.now / HOUR) * HOUR }) : undefined;
    out.push({
      poolId: pool.id,
      name: pool.name,
      short: pool.short,
      siteId: pool.siteId,
      ...(start !== undefined ? { start: Math.max(start, snapshot.now) } : {}),
      perNode: shape.perNode,
      nodes: shape.nodes,
      cost: total * (ask.durationMs / HOUR) * pool.price * (ask.spot ? 0.4 : 1),
    });
  }
  return out.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.cost - b.cost);
}
