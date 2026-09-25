'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { cx } from '@/utils/cx';

/**
 * The hero's fleet board: a simulated site with two pools, drawn like the front panel of a rack. Seven 8-GPU nodes
 * take GPU reservations; three CPU hosts run sandbox VMs (VPS instances with GPU-less flavors), whose vCPUs are
 * shown two to a cell. It is an illustration, labelled SIMULATED, not live data.
 *
 * It follows the real rules in miniature:
 * - GPUs (packages/capacity/src/pipeline.ts): binpack (the fullest node that fits wins), 4-GPU requests as a whole
 *   NVLink set (`topology: 'nvlink-all'`, GPUs 0-3 or 4-7), small requests into partly used sets first so whole
 *   sets stay whole, no placement on a cordoned node.
 * - vCPUs (packages/vps flavors, capacity scalars): an instance claims its flavor's vCPUs on one host, packed onto
 *   the fullest host that fits.
 * - A request that fits nowhere stays pending instead of being split. A GPU or vCPU is only ever held by one
 *   booking; the OVERLAPS counter re-checks that on every tick.
 *
 * Deterministic: a seeded PRNG builds the same first frame on the server and the client, and ticks start after
 * mount. Pointing at the board holds it; reduced motion shows the first frame only.
 */

type Kind = 'gpu' | 'cpu';

interface Machine {
  name: string;
  kind: Kind;
  cells: number;
  cordoned?: boolean;
}

const machines: Machine[] = [
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `gpu-${String(i + 1).padStart(2, '0')}`,
    kind: 'gpu' as const,
    cells: 8,
    ...(i === 4 ? { cordoned: true } : {}),
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    name: `cpu-${String(i + 1).padStart(2, '0')}`,
    kind: 'cpu' as const,
    // 32 vCPUs, two per cell.
    cells: 16,
  })),
];

const SET = 4;
const VCPU_PER_CELL = 2;
const TICK_MS = 1100;
const FRESH_MS = 900;
const LOG_LINES = 7;

type Cell = string | null;

interface Booking {
  id: string;
  machine: number;
  cells: number[];
}

interface LogLine {
  seq: number;
  kind: 'active' | 'released' | 'pending';
  text: string;
}

interface Fleet {
  cells: Cell[][];
  bookings: Booking[];
  fresh: Record<string, number>;
  log: LogLine[];
  placed: number;
  pending: number;
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

function bookingId(kind: Kind, seq: number) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let n = (seq * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += alphabet[n % 32];
    n = Math.floor(n / 32);
  }
  return `${kind === 'gpu' ? 'rsv' : 'inst'}_${out}`;
}

/** The cells a request of `count` gets on `machine`, or undefined. */
function fit(cells: Cell[][], machine: number, count: number): number[] | undefined {
  const spec = machines[machine]!;
  if (spec.cordoned) return undefined;
  const row = cells[machine]!;
  const free = (cell: number) => row[cell] === null;
  if (spec.kind === 'cpu') {
    const open = [...row.keys()].filter(free);
    return open.length >= count ? open.slice(0, count) : undefined;
  }
  if (count === spec.cells) return row.every((cell) => cell === null) ? [...row.keys()] : undefined;
  const sets = [0, SET].map((start) => [...Array(SET).keys()].map((i) => start + i));
  if (count === SET) return sets.find((set) => set.every(free));
  // Small GPU requests: a partly used set first (keeps whole sets whole), then an empty one.
  const byUse = [...sets].sort(
    (a, b) => a.filter(free).length - b.filter(free).length || a[0]! - b[0]!,
  );
  for (const set of byUse) {
    const open = set.filter(free);
    if (open.length >= count) return open.slice(0, count);
  }
  return undefined;
}

const describe = (kind: Kind, count: number) =>
  kind === 'gpu' ? `${count}×H100${count >= SET ? ' nvlink' : ''}` : `${count * VCPU_PER_CELL} vCPU`;

function place(fleet: Fleet, kind: Kind, count: number, now: number): Fleet {
  let rand = fleet.rand;
  let r: number;
  [r, rand] = next(rand);
  const start = Math.floor(r * machines.length);
  // Binpack, like the placer's default score: the fullest machine that fits wins; ties rotate so the board moves.
  const best = [...machines.keys()]
    .map((i) => (start + i) % machines.length)
    .filter((machine) => machines[machine]!.kind === kind)
    .map((machine) => ({ machine, cells: fit(fleet.cells, machine, count) }))
    .filter((c): c is { machine: number; cells: number[] } => c.cells !== undefined)
    .map((c) => ({ ...c, used: fleet.cells[c.machine]!.filter(Boolean).length }))
    .sort((a, b) => b.used - a.used)[0];
  const seq = fleet.seq + 1;
  if (!best) {
    const reason = kind === 'gpu' ? (count === SET ? 'no whole NVLink set' : 'no room') : 'no host';
    return {
      ...fleet,
      rand,
      seq,
      pending: fleet.pending + 1,
      log: [
        { seq, kind: 'pending' as const, text: `${describe(kind, count)} ${reason}` },
        ...fleet.log,
      ].slice(0, LOG_LINES),
    };
  }
  const id = bookingId(kind, seq);
  const { machine, cells: taken } = best;
  const suffix = kind === 'cpu' ? ' sandbox' : '';
  return {
    ...fleet,
    rand,
    seq,
    cells: fleet.cells.map((row, index) =>
      index === machine ? row.map((cell, i) => (taken.includes(i) ? id : cell)) : row,
    ),
    bookings: [...fleet.bookings, { id, machine, cells: taken }],
    fresh: { ...fleet.fresh, [id]: now },
    placed: fleet.placed + 1,
    log: [
      {
        seq,
        kind: 'active' as const,
        text: `${id} ${machines[machine]!.name} ${describe(kind, count)}${suffix}`,
      },
      ...fleet.log,
    ].slice(0, LOG_LINES),
  };
}

function release(fleet: Fleet): Fleet {
  let rand = fleet.rand;
  let r: number;
  [r, rand] = next(rand);
  const victim = fleet.bookings[Math.floor(r * fleet.bookings.length)];
  if (!victim) return { ...fleet, rand };
  const seq = fleet.seq + 1;
  return {
    ...fleet,
    rand,
    seq,
    cells: fleet.cells.map((row) => row.map((cell) => (cell === victim.id ? null : cell))),
    bookings: fleet.bookings.filter((item) => item.id !== victim.id),
    log: [
      {
        seq,
        kind: 'released' as const,
        text: `${victim.id} ${machines[victim.machine]!.name}`,
      },
      ...fleet.log,
    ].slice(0, LOG_LINES),
  };
}

/** Request sizes in cells, weighted toward small jobs so partly used machines show up beside full ones. */
const sizes: Record<Kind, number[]> = {
  gpu: [1, 1, 1, 2, 2, 3, 4, 8],
  // 2, 4, 8 or 16 vCPU sandboxes.
  cpu: [1, 1, 2, 2, 2, 4, 4, 8],
};

function step(fleet: Fleet, now: number): Fleet {
  const capacity = machines.reduce((sum, m) => sum + (m.cordoned ? 0 : m.cells), 0);
  const booked = fleet.cells.flat().filter(Boolean).length;
  let r: number;
  let rand = fleet.rand;
  [r, rand] = next(rand);
  const load = booked / capacity;
  const book = load < 0.35 || (load < 0.8 && r < 0.58);
  [r, rand] = next(rand);
  const kind: Kind = r < 0.55 ? 'gpu' : 'cpu';
  [r, rand] = next(rand);
  const size = sizes[kind][Math.floor(r * sizes[kind].length)]!;
  const fresh = Object.fromEntries(
    Object.entries(fleet.fresh).filter(([, at]) => now - at < FRESH_MS),
  );
  const base = { ...fleet, rand, fresh };
  return book ? place(base, kind, size, now) : release(base);
}

function initialFleet(): Fleet {
  let fleet: Fleet = {
    cells: machines.map((m) => Array<Cell>(m.cells).fill(null)),
    bookings: [],
    fresh: {},
    log: [],
    placed: 0,
    pending: 0,
    seq: 0,
    rand: 0x5eed,
  };
  for (let i = 0; i < 26; i++) fleet = step(fleet, -FRESH_MS);
  return { ...fleet, fresh: {} };
}

/** A cell held by two bookings would show here; the booking rules above make it impossible, as Postgres does. */
function overlaps(fleet: Fleet): number {
  const holders = new Map<string, number>();
  for (const booking of fleet.bookings)
    for (const cell of booking.cells) {
      const key = `${booking.machine}:${cell}`;
      holders.set(key, (holders.get(key) ?? 0) + 1);
    }
  return [...holders.values()].filter((count) => count > 1).length;
}

function usage(fleet: Fleet, kind: Kind) {
  let used = 0;
  let total = 0;
  machines.forEach((m, i) => {
    if (m.kind !== kind || m.cordoned) return;
    total += m.cells;
    used += fleet.cells[i]!.filter(Boolean).length;
  });
  const unit = kind === 'cpu' ? VCPU_PER_CELL : 1;
  return `${used * unit}/${total * unit}`;
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
        <span className="hidden sm:inline">site fsn1 · gpu-h100 + cpu-sandbox</span>
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

      <div className="grid lg:grid-cols-[minmax(0,1fr)_16rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <ol
          className="scanlines flex flex-col gap-1.5 px-3 py-3"
          aria-label="Simulated GPU nodes and CPU hosts"
        >
          {fleet.cells.map((row, index) => {
            const machine = machines[index]!;
            const used = row.filter(Boolean).length;
            const cpu = machine.kind === 'cpu';
            const groups = cpu ? [0, 8] : [0, SET];
            const width = cpu ? 8 : SET;
            return (
              <li
                key={machine.name}
                className={cx(
                  'flex items-center gap-3',
                  cpu && index === 7 && 'mt-1.5 border-t border-dashed border-separator-border pt-3',
                )}
              >
                <span className="w-14 shrink-0 text-text-secondary">{machine.name}</span>
                {/* Cells stretch like drive bays, so a row fills the panel at any width. */}
                <span className="flex flex-1 gap-2.5">
                  {groups.map((start) => (
                    <span key={start} className={cx('flex flex-1', cpu ? 'gap-0.5' : 'gap-1')}>
                      {row.slice(start, start + width).map((cell, i) => {
                        const fresh = cell !== null && fleet.fresh[cell] !== undefined;
                        return (
                          <span
                            key={start + i}
                            title={cell ?? (machine.cordoned ? 'cordoned' : 'idle')}
                            className="gpu-cell block h-3.5 min-w-[4px] flex-1 sm:h-4"
                            data-state={
                              machine.cordoned
                                ? 'cordoned'
                                : cell
                                  ? fresh
                                    ? 'fresh'
                                    : 'booked'
                                  : 'idle'
                            }
                          />
                        );
                      })}
                    </span>
                  ))}
                </span>
                <span className="ms-auto w-[5.5rem] shrink-0 text-end tabular-nums text-text-tertiary">
                  {machine.cordoned ? (
                    <span className="tracking-[0.06em] uppercase">cordoned</span>
                  ) : (
                    <>
                      <span className={used ? 'text-text-primary' : undefined}>
                        {cpu ? used * VCPU_PER_CELL : used}
                      </span>
                      /{cpu ? machine.cells * VCPU_PER_CELL : machine.cells}
                      {cpu ? ' vCPU' : ''}
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
                    line.kind === 'pending' && 'text-text-secondary',
                  )}
                >
                  {line.kind === 'active' ? '+' : line.kind === 'released' ? '−' : '…'}
                </span>
                <span
                  className={cx(
                    'truncate',
                    line.kind === 'active' ? 'text-text-primary' : 'text-text-secondary',
                  )}
                >
                  {line.kind === 'pending' ? `pending ${line.text}` : line.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <dl className="grid grid-cols-2 border-t border-separator-border sm:grid-cols-4">
        {[
          ['GPUs', usage(fleet, 'gpu'), true],
          ['vCPUs', usage(fleet, 'cpu'), true],
          ['Pending', String(fleet.pending), false],
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
