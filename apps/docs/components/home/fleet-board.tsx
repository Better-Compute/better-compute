'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { cx } from '@/utils/cx';

/**
 * The hero's fleet board: a simulated pool of ten 8-GPU nodes where reservations book and release GPUs, drawn like
 * the front panel of a rack. It is an illustration, labelled SIMULATED, not live data. It follows the placer's
 * default scoring in miniature (packages/capacity/src/pipeline.ts): binpack (the fullest node that fits wins), 4-GPU
 * requests as a whole NVLink set (`topology: 'nvlink-all'`, GPUs 0-3 or 4-7), small requests into partly used sets
 * first so whole sets stay whole (the fragmentation score), no placement on a cordoned node, and a request that fits
 * no node stays pending instead of being split. A GPU is only ever held by one reservation; the OVERLAPS counter
 * re-checks that on every tick.
 *
 * Deterministic: a seeded PRNG builds the same first frame on the server and the client, and ticks start after
 * mount. Pointing at the board holds it; reduced motion shows the first frame only.
 */

const NODES = 10;
const GPUS = 8;
const SET = 4;
const CORDONED = 6;
const TICK_MS = 1100;
const FRESH_MS = 900;
const LOG_LINES = 7;

type Cell = string | null;

interface Reservation {
  id: string;
  node: number;
  gpus: number[];
}

interface LogLine {
  seq: number;
  kind: 'active' | 'released' | 'refused';
  text: string;
}

interface Fleet {
  cells: Cell[][];
  reservations: Reservation[];
  fresh: Record<string, number>;
  log: LogLine[];
  placed: number;
  refused: number;
  seq: number;
  rand: number;
}

/** mulberry32: small, fast and the same on every JavaScript engine. */
function next(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) | 0;
  const seed = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, seed];
}

const nodeName = (node: number) => `node-${String(node + 1).padStart(2, '0')}`;

function reservationId(seq: number) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let n = (seq * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += alphabet[n % 32];
    n = Math.floor(n / 32);
  }
  return `rsv_${out}`;
}

/** The GPUs a request of `count` gets on `node`, or undefined. Mirrors the placer's topology preference. */
function fit(cells: Cell[][], node: number, count: number): number[] | undefined {
  if (node === CORDONED) return undefined;
  const row = cells[node]!;
  const free = (gpu: number) => row[gpu] === null;
  if (count === GPUS) return row.every((cell) => cell === null) ? [...row.keys()] : undefined;
  const sets = [0, SET].map((start) => [...Array(SET).keys()].map((i) => start + i));
  if (count === SET) return sets.find((set) => set.every(free));
  // Small requests: a partly used set first (keeps whole sets whole), then an empty one.
  const byUse = [...sets].sort(
    (a, b) => a.filter(free).length - b.filter(free).length || a[0]! - b[0]!,
  );
  for (const set of byUse) {
    const open = set.filter(free);
    if (open.length >= count) return open.slice(0, count);
  }
  return undefined;
}

function place(fleet: Fleet, count: number, now: number): Fleet {
  let rand = fleet.rand;
  let r: number;
  [r, rand] = next(rand);
  const start = Math.floor(r * NODES);
  // Binpack, like the placer's default score: the fullest node that fits wins; ties rotate so the board moves.
  const candidates = [...Array(NODES).keys()]
    .map((i) => (start + i) % NODES)
    .map((node) => ({ node, gpus: fit(fleet.cells, node, count) }))
    .filter((c): c is { node: number; gpus: number[] } => c.gpus !== undefined)
    .map((c) => ({ ...c, used: fleet.cells[c.node]!.filter(Boolean).length }))
    .sort((a, b) => b.used - a.used);
  for (const { node, gpus } of candidates.slice(0, 1)) {
    const seq = fleet.seq + 1;
    const id = reservationId(seq);
    const cells = fleet.cells.map((row, index) =>
      index === node ? row.map((cell, gpu) => (gpus.includes(gpu) ? id : cell)) : row,
    );
    const topology = count >= SET ? ' nvlink' : '';
    return {
      ...fleet,
      rand,
      seq,
      cells,
      reservations: [...fleet.reservations, { id, node, gpus }],
      fresh: { ...fleet.fresh, [id]: now },
      placed: fleet.placed + 1,
      log: [
        {
          seq,
          kind: 'active' as const,
          text: `${id} ${nodeName(node)} ${count}×H100${topology}`,
        },
        ...fleet.log,
      ].slice(0, LOG_LINES),
    };
  }
  const seq = fleet.seq + 1;
  return {
    ...fleet,
    rand,
    seq,
    refused: fleet.refused + 1,
    log: [
      {
        seq,
        kind: 'refused' as const,
        text: `${count}×H100 ${count === GPUS ? 'no idle node' : count === SET ? 'no whole NVLink set' : 'no room'}`,
      },
      ...fleet.log,
    ].slice(0, LOG_LINES),
  };
}

function release(fleet: Fleet): Fleet {
  let rand = fleet.rand;
  let r: number;
  [r, rand] = next(rand);
  const victim = fleet.reservations[Math.floor(r * fleet.reservations.length)];
  if (!victim) return { ...fleet, rand };
  const seq = fleet.seq + 1;
  return {
    ...fleet,
    rand,
    seq,
    cells: fleet.cells.map((row) => row.map((cell) => (cell === victim.id ? null : cell))),
    reservations: fleet.reservations.filter((item) => item.id !== victim.id),
    log: [
      { seq, kind: 'released' as const, text: `${victim.id} ${nodeName(victim.node)}` },
      ...fleet.log,
    ].slice(0, LOG_LINES),
  };
}

/** Request sizes, weighted toward small jobs so partly used nodes show up beside full ones. */
const sizes = [1, 1, 1, 2, 2, 3, 4, 8];

function step(fleet: Fleet, now: number): Fleet {
  const capacity = (NODES - 1) * GPUS;
  const booked = fleet.cells.flat().filter(Boolean).length;
  let r: number;
  let rand = fleet.rand;
  [r, rand] = next(rand);
  const load = booked / capacity;
  const book = load < 0.35 || (load < 0.8 && r < 0.58);
  [r, rand] = next(rand);
  const size = sizes[Math.floor(r * sizes.length)]!;
  const fresh = Object.fromEntries(
    Object.entries(fleet.fresh).filter(([, at]) => now - at < FRESH_MS),
  );
  const base = { ...fleet, rand, fresh };
  return book ? place(base, size, now) : release(base);
}

function initialFleet(): Fleet {
  let fleet: Fleet = {
    cells: Array.from({ length: NODES }, () => Array<Cell>(GPUS).fill(null)),
    reservations: [],
    fresh: {},
    log: [],
    placed: 0,
    refused: 0,
    seq: 0,
    rand: 0x5eed,
  };
  for (let i = 0; i < 22; i++) fleet = step(fleet, -FRESH_MS);
  return { ...fleet, fresh: {} };
}

/** A GPU held by two reservations would show here; the booking rules above make it impossible, as Postgres does. */
function overlaps(fleet: Fleet): number {
  const holders = new Map<string, number>();
  for (const reservation of fleet.reservations)
    for (const gpu of reservation.gpus) {
      const key = `${reservation.node}:${gpu}`;
      holders.set(key, (holders.get(key) ?? 0) + 1);
    }
  return [...holders.values()].filter((count) => count > 1).length;
}

export function FleetBoard({ className }: { className?: string }) {
  const [fleet, dispatch] = useReducer(
    (state: Fleet, now: number) => step(state, now),
    undefined,
    initialFleet,
  );
  const [held, setHeld] = useState(false);
  const heldRef = useRef(held);
  heldRef.current = held;

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A booking glows until the next tick drops it from `fresh` (FRESH_MS < TICK_MS).
    const timer = window.setInterval(() => {
      if (heldRef.current || document.hidden) return;
      dispatch(performance.now());
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const capacity = (NODES - 1) * GPUS;
  const booked = fleet.cells.flat().filter(Boolean).length;

  return (
    <div
      className={cx(
        'relative border border-border-button-default bg-surface-raised font-mono text-[0.6875rem] leading-4 shadow-lg',
        className,
      )}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
    >
      <div className="flex items-center gap-3 border-b border-separator-border px-3 py-2 tracking-[0.06em] text-text-secondary uppercase">
        <span className="live-dot" />
        <span className="text-text-primary">Fleet</span>
        <span className="hidden sm:inline">pool gpu-h100 · site fsn1</span>
        <span
          className={cx(
            'ms-auto border px-1.5 py-px',
            held
              ? 'border-text-secondary text-text-secondary'
              : 'border-signal-fill text-signal',
          )}
        >
          {held ? 'Held' : 'Simulated'}
        </span>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_13.5rem]">
        <ol
          className="scanlines flex flex-col gap-1.5 px-3 py-3"
          aria-label="Simulated nodes and their GPUs"
        >
          {fleet.cells.map((row, node) => {
            const cordoned = node === CORDONED;
            const used = row.filter(Boolean).length;
            return (
              <li key={node} className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-text-secondary">{nodeName(node)}</span>
                <span className="flex gap-2.5">
                  {[0, SET].map((start) => (
                    <span key={start} className="flex gap-1">
                      {row.slice(start, start + SET).map((cell, i) => {
                        const fresh = cell !== null && fleet.fresh[cell] !== undefined;
                        return (
                          <span
                            key={start + i}
                            title={cell ?? (cordoned ? 'cordoned' : 'idle')}
                            className="gpu-cell block size-3.5 sm:size-4"
                            data-state={
                              cordoned ? 'cordoned' : cell ? (fresh ? 'fresh' : 'booked') : 'idle'
                            }
                          />
                        );
                      })}
                    </span>
                  ))}
                </span>
                <span className="ms-auto text-end tabular-nums text-text-tertiary">
                  {cordoned ? (
                    <span className="tracking-[0.06em] uppercase">cordoned</span>
                  ) : (
                    <>
                      <span className={used ? 'text-text-primary' : undefined}>{used}</span>/{GPUS}
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-col border-t border-separator-border lg:border-t-0 lg:border-s">
          <p className="border-b border-separator-border px-3 py-2 tracking-[0.06em] text-text-tertiary uppercase">
            Events
          </p>
          <ol className="flex flex-1 flex-col gap-1.5 overflow-hidden px-3 py-3" aria-live="off">
            {fleet.log.map((line) => (
              <li key={line.seq} className="flex gap-2 truncate">
                <span
                  className={cx(
                    'shrink-0',
                    line.kind === 'active' && 'text-signal',
                    line.kind === 'released' && 'text-text-tertiary',
                    line.kind === 'refused' && 'text-text-secondary',
                  )}
                >
                  {line.kind === 'active' ? '+' : line.kind === 'released' ? '−' : '×'}
                </span>
                <span
                  className={cx(
                    'truncate',
                    line.kind === 'active' ? 'text-text-primary' : 'text-text-secondary',
                  )}
                >
                  {line.kind === 'refused' ? `pending ${line.text}` : line.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <dl className="grid grid-cols-2 border-t border-separator-border sm:grid-cols-4">
        {[
          ['Booked', `${booked}/${capacity}`, true],
          ['Placed', String(fleet.placed), false],
          ['Pending', String(fleet.refused), false],
          ['Overlaps', String(overlaps(fleet)), false],
        ].map(([label, value, lit], index) => (
          <div
            key={label as string}
            className={cx(
              'flex items-baseline justify-between gap-2 px-3 py-2',
              index > 0 && 'sm:border-s sm:border-separator-border',
              index % 2 === 1 && 'border-s border-separator-border',
              index > 1 && 'border-t border-separator-border sm:border-t-0',
            )}
          >
            <dt className="tracking-[0.06em] text-text-tertiary uppercase">{label}</dt>
            <dd className={cx('tabular-nums', lit ? 'text-signal' : 'text-text-primary')}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
