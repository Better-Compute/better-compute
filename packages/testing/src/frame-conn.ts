import {
  decodeAgentFrame,
  decodeServerFrame,
  encodeAgentFrame,
  encodeServerFrame,
  type AgentFrame,
  type ServerFrame,
} from '@better-compute/protocol';
import { createRng, type Rng } from './rng.js';
import type { Scheduler, Timer } from './scheduler.js';

/** Receives frames; a returned promise is awaited before the next frame of the stream arrives. */
export type FrameHandler<T> = (frame: T) => void | Promise<void>;

/** Who closed a connection end: itself, its peer (FIN/RST arrived), or an injected fault. */
export type CloseInitiator = 'local' | 'remote' | 'fault';

export interface CloseInfo {
  reason: string;
  by: CloseInitiator;
  /** A refusal's server-provided retry delay (gRPC `grpc-retry-pushback-ms`): redial after exactly this. */
  retryAfterMs?: number;
}

/**
 * One end of a bidirectional, ordered frame stream: the transport-agnostic shape of an agent/v1
 * `Session` stream (`FrameConn<AgentFrame, ServerFrame>` on the daemon side,
 * `FrameConn<ServerFrame, AgentFrame>` on the gateway side). Implementations: the in-memory pair
 * below; the gateway's HTTP/2 transport adapts to the same shape.
 */
export interface FrameConn<Out, In> {
  readonly id: string;
  readonly closed: boolean;
  /** Why and by whom this end was closed. */
  readonly closeInfo: CloseInfo | undefined;
  /**
   * Queues a frame. Returns false when this end is closed. A true return promises nothing about
   * delivery (a partitioned or half-open link accepts frames and never delivers them).
   */
  send(frame: Out): boolean;
  /** Sets the frame handler. Frames that arrived before it are buffered and delivered in order. */
  onFrame(handler: FrameHandler<In>): void;
  /** Adds a handler called once when this end closes, for any reason. */
  onClose(handler: (info: CloseInfo) => void | Promise<void>): void;
  /** Graceful close: frames already sent are still delivered, then the peer sees the close. */
  close(reason?: string, info?: { retryAfterMs?: number }): void;
  /** Reset: frames in flight are discarded and the peer sees the close after one latency. */
  abort(reason?: string): void;
  /**
   * A transport-level liveness probe (HTTP/2 PING). `onResult(true)` when the peer end answered
   * within `timeoutMs`, `false` otherwise. Pings travel in order with the frames and are subject to
   * stalls, partitions and half-open links, not to drops or duplicates.
   */
  ping(timeoutMs: number, onResult: (alive: boolean) => void): void;
}

/** Faults of one direction of a link. Probabilities are per frame, drawn from the link's RNG. */
export interface LinkFaults {
  /** One-way latency in milliseconds (default 1). */
  latencyMs?: number;
  /** Extra uniform latency in [0, jitterMs]; frames stay in order (head-of-line blocking). */
  jitterMs?: number;
  /** Probability a frame is dropped. */
  drop?: number;
  /**
   * `silent` (default): the frame vanishes and the stream continues, which a real gRPC stream never
   * does (use it to test receivers). `reset`: the drop breaks the stream, as a lost HTTP/2 stream
   * would: both ends are closed.
   */
  dropMode?: 'silent' | 'reset';
  /** Probability a frame is delivered twice. */
  duplicate?: number;
  /** Probability a frame is held back by up to `reorderWindowMs`, so later frames overtake it. */
  reorder?: number;
  /** Maximum hold-back of a reordered frame (default 50 ms). */
  reorderWindowMs?: number;
}

/** A direction of a pair: `a->b` or `b->a`. For agent links, `a` is the daemon (`UP` = `a->b`). */
export type LinkDirection = 'a->b' | 'b->a';
/** Daemon → gateway on an agent link. */
export const UP: LinkDirection = 'a->b';
/** Gateway → daemon on an agent link. */
export const DOWN: LinkDirection = 'b->a';

/** What an interceptor decides for one frame. */
export type FrameVerdict = 'deliver' | 'drop' | 'duplicate' | 'reset' | { delayMs: number };

/** Per-direction counters. */
export interface LinkStats {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  reordered: number;
  bytes: number;
}

/** What the link reports to an observer (the fleet sim's event log). */
export type LinkEvent =
  | { type: 'deliver'; dir: LinkDirection; frame: unknown }
  | { type: 'drop'; dir: LinkDirection; frame: unknown; cause: 'fault' | 'closed' }
  | { type: 'duplicate' | 'reorder'; dir: LinkDirection; frame: unknown }
  | { type: 'close'; side: 'a' | 'b'; info: CloseInfo }
  | {
      type: 'fault';
      fault: 'partition' | 'heal' | 'stall' | 'half-open' | 'reset';
      detail?: string;
    };

/** Fault controls of one link. */
export interface LinkControl {
  readonly id: string;
  /** Replaces the faults of one direction or both (unset fields take the defaults). */
  configure(dir: LinkDirection | 'both', faults: LinkFaults): void;
  /** Holds every frame of `dir` (and pings) for `ms`; they arrive in order afterwards. */
  stall(dir: LinkDirection | 'both', ms: number): void;
  /**
   * Nothing crosses in either direction until `heal()` (or for `ms`). Like a TCP connection over a
   * partitioned network, frames are not lost: they arrive after the heal unless an end closed
   * meanwhile. Pings time out, so ends detect it through their own liveness timers.
   */
  partition(ms?: number): void;
  heal(): void;
  readonly partitioned: boolean;
  /**
   * The `dead` end goes away (it sees a close) while the other end never learns: its frames vanish
   * and it gets no close. Permanent; only the live end's own timeout ends it.
   */
  halfOpen(dead: 'a' | 'b'): void;
  /** Breaks the stream: both ends see a close and every frame in flight is lost. */
  reset(reason?: string): void;
  /** Drops the next `count` frames of `dir` (deterministic targeting). */
  dropNext(dir: LinkDirection, count?: number): void;
  /** Duplicates the next `count` frames of `dir`. */
  duplicateNext(dir: LinkDirection, count?: number): void;
  /** Decides per frame; `undefined` (or 'deliver') falls through to the random faults. */
  intercept(
    dir: LinkDirection,
    fn: ((frame: unknown) => FrameVerdict | undefined) | undefined,
  ): void;
  stats(dir: LinkDirection): Readonly<LinkStats>;
  /** Frames and controls queued (in flight) in `dir`. */
  inFlight(dir: LinkDirection): number;
}

/** Encodes and decodes one direction's frames; frames cross the link as bytes. */
export interface FrameCodec<T> {
  encode(frame: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

export interface FramePairOptions<A, B> {
  scheduler: Scheduler;
  /** Draws the random faults (default: seeded from the id). */
  rng?: Rng;
  id?: string;
  /** Codecs for a→b and b→a frames (default: structuredClone, so no object is shared). */
  codecs?: { aToB?: FrameCodec<A>; bToA?: FrameCodec<B> };
  /** Faults for both directions (merged under `aToB` / `bToA`). */
  faults?: LinkFaults;
  aToB?: LinkFaults;
  bToA?: LinkFaults;
  observe?: (event: LinkEvent) => void;
}

/** Both ends of a link and its fault controls. */
export interface FramePair<A, B> {
  /** Sends A, receives B. */
  a: FrameConn<A, B>;
  /** Sends B, receives A. */
  b: FrameConn<B, A>;
  control: LinkControl;
}

type Item =
  | { type: 'data'; wire: unknown; dueAt: number }
  | { type: 'fin' | 'rst'; reason: string; retryAfterMs?: number; dueAt: number }
  | { type: 'ping' | 'pong'; probe: number; dueAt: number };

/** How one direction puts frames on the wire: bytes through a codec, or a structured clone. */
interface Wire {
  encode(frame: unknown): unknown;
  decode(wire: unknown): unknown;
  size(wire: unknown): number;
}

interface Direction {
  name: LinkDirection;
  faults: Required<LinkFaults>;
  queue: Item[];
  stalledUntil: number;
  blackholed: boolean;
  pumpTimer: Timer | undefined;
  pumping: boolean;
  dropNext: number;
  duplicateNext: number;
  interceptor: ((frame: unknown) => FrameVerdict | undefined) | undefined;
  stats: LinkStats;
  wire: Wire;
}

const wireOf = (codec: FrameCodec<unknown> | undefined): Wire =>
  codec
    ? {
        encode: (frame) => codec.encode(frame),
        decode: (wire) => codec.decode(wire as Uint8Array),
        size: (wire) => (wire as Uint8Array).byteLength,
      }
    : {
        encode: (frame) => structuredClone(frame),
        decode: (wire) => structuredClone(wire),
        size: () => 0,
      };

const defaults: Required<LinkFaults> = {
  latencyMs: 1,
  jitterMs: 0,
  drop: 0,
  dropMode: 'silent',
  duplicate: 0,
  reorder: 0,
  reorderWindowMs: 50,
};

const withDefaults = (faults: LinkFaults | undefined): Required<LinkFaults> => ({
  ...defaults,
  ...Object.fromEntries(Object.entries(faults ?? {}).filter(([, v]) => v !== undefined)),
});

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

class End {
  closed = false;
  closeInfo: CloseInfo | undefined;
  handler: FrameHandler<unknown> | undefined;
  readonly buffer: unknown[] = [];
  draining = false;
  readonly closeHandlers: ((info: CloseInfo) => void | Promise<void>)[] = [];
  readonly probes = new Map<number, { timer: Timer; onResult: (alive: boolean) => void }>();
  constructor(
    readonly side: 'a' | 'b',
    readonly out: Direction,
    readonly inbound: Direction,
  ) {}
}

/** An in-memory link: two `FrameConn` ends over a simulated, fault-injectable network. */
class Link {
  readonly ends: { a: End; b: End };
  readonly dirs: Record<LinkDirection, Direction>;
  dead = false;
  private probeSeq = 0;
  private healTimer: Timer | undefined;

  constructor(
    readonly id: string,
    readonly scheduler: Scheduler,
    private readonly rng: Rng,
    codecs: { aToB: FrameCodec<unknown> | undefined; bToA: FrameCodec<unknown> | undefined },
    faults: { aToB: LinkFaults | undefined; bToA: LinkFaults | undefined },
    private readonly observe: ((event: LinkEvent) => void) | undefined,
  ) {
    const direction = (
      name: LinkDirection,
      codec: FrameCodec<unknown> | undefined,
      f?: LinkFaults,
    ): Direction => ({
      name,
      faults: withDefaults(f),
      queue: [],
      stalledUntil: 0,
      blackholed: false,
      pumpTimer: undefined,
      pumping: false,
      dropNext: 0,
      duplicateNext: 0,
      interceptor: undefined,
      stats: { sent: 0, delivered: 0, dropped: 0, duplicated: 0, reordered: 0, bytes: 0 },
      wire: wireOf(codec),
    });
    this.dirs = {
      'a->b': direction('a->b', codecs.aToB, faults.aToB),
      'b->a': direction('b->a', codecs.bToA, faults.bToA),
    };
    this.ends = {
      a: new End('a', this.dirs['a->b'], this.dirs['b->a']),
      b: new End('b', this.dirs['b->a'], this.dirs['a->b']),
    };
  }

  private now(): number {
    return this.scheduler.now();
  }

  /** Whole milliseconds, so every scheduler time stays an integer (Timestamps need whole nanos). */
  private latency(dir: Direction): number {
    const { latencyMs, jitterMs } = dir.faults;
    return (
      Math.max(0, Math.round(latencyMs)) +
      (jitterMs > 0 ? this.rng.int(Math.round(jitterMs) + 1) : 0)
    );
  }

  private endFor(dir: Direction): End {
    return dir.name === 'a->b' ? this.ends.b : this.ends.a;
  }

  // ---- sending --------------------------------------------------------------------------------

  send(end: End, frame: unknown): boolean {
    if (end.closed) return false;
    const dir = end.out;
    const wire = dir.wire.encode(frame);
    dir.stats.sent++;
    dir.stats.bytes += dir.wire.size(wire);
    if (this.dead) {
      // A half-open peer: the frame vanishes and the sender cannot tell.
      dir.stats.dropped++;
      return true;
    }

    let verdict: FrameVerdict | undefined = dir.interceptor?.(frame);
    if (verdict === undefined || verdict === 'deliver') {
      if (dir.dropNext > 0) {
        dir.dropNext--;
        verdict = 'drop';
      } else if (dir.duplicateNext > 0) {
        dir.duplicateNext--;
        verdict = 'duplicate';
      } else if (this.rng.chance(dir.faults.drop)) {
        verdict = dir.faults.dropMode === 'reset' ? 'reset' : 'drop';
      } else if (this.rng.chance(dir.faults.duplicate)) {
        verdict = 'duplicate';
      } else if (this.rng.chance(dir.faults.reorder)) {
        verdict = {
          delayMs: 1 + this.rng.int(Math.max(1, Math.round(dir.faults.reorderWindowMs))),
        };
      }
    }

    if (verdict === 'drop') {
      dir.stats.dropped++;
      this.observe?.({ type: 'drop', dir: dir.name, frame, cause: 'fault' });
      return true;
    }
    if (verdict === 'reset') {
      dir.stats.dropped++;
      this.observe?.({ type: 'drop', dir: dir.name, frame, cause: 'fault' });
      this.reset('stream reset (dropped frame)');
      return true;
    }
    if (typeof verdict === 'object') {
      dir.stats.reordered++;
      this.observe?.({ type: 'reorder', dir: dir.name, frame });
      const hold = Math.max(0, Math.round(verdict.delayMs));
      this.scheduler.after(hold, () => {
        if (!this.dead)
          this.enqueue(dir, { type: 'data', wire, dueAt: this.now() + this.latency(dir) });
      });
      return true;
    }
    const dueAt = this.now() + this.latency(dir);
    this.enqueue(dir, { type: 'data', wire, dueAt });
    if (verdict === 'duplicate') {
      dir.stats.duplicated++;
      this.observe?.({ type: 'duplicate', dir: dir.name, frame });
      this.enqueue(dir, { type: 'data', wire, dueAt });
    }
    return true;
  }

  private enqueue(dir: Direction, item: Item): void {
    dir.queue.push(item);
    this.schedulePump(dir);
  }

  private schedulePump(dir: Direction): void {
    if (dir.pumping || dir.pumpTimer || dir.blackholed || this.dead) return;
    const head = dir.queue[0];
    if (!head) return;
    const at = Math.max(head.dueAt, dir.stalledUntil);
    dir.pumpTimer = this.scheduler.after(at - this.now(), () => {
      dir.pumpTimer = undefined;
      return this.pump(dir);
    });
  }

  private pump(dir: Direction): void | Promise<void> {
    dir.pumping = true;
    let async: Promise<void> | undefined;
    try {
      for (;;) {
        if (dir.blackholed || this.dead) break;
        const head = dir.queue[0];
        if (!head) break;
        const now = this.now();
        if (head.dueAt > now || dir.stalledUntil > now) break;
        dir.queue.shift();
        const result = this.deliver(dir, head);
        if (isThenable(result)) {
          async = (async () => {
            try {
              await result;
              // Continue the stream in order after the async handler.
              for (;;) {
                if (dir.blackholed || this.dead) break;
                const next = dir.queue[0];
                if (!next) break;
                const at = this.now();
                if (next.dueAt > at || dir.stalledUntil > at) break;
                dir.queue.shift();
                const more = this.deliver(dir, next);
                if (isThenable(more)) await more;
              }
            } finally {
              dir.pumping = false;
              this.schedulePump(dir);
            }
          })();
          return async;
        }
      }
    } finally {
      if (!async) {
        dir.pumping = false;
        this.schedulePump(dir);
      }
    }
  }

  // ---- receiving ------------------------------------------------------------------------------

  private deliver(dir: Direction, item: Item): void | Promise<void> {
    const end = this.endFor(dir);
    switch (item.type) {
      case 'data': {
        const frame = dir.wire.decode(item.wire);
        if (end.closed) {
          dir.stats.dropped++;
          this.observe?.({ type: 'drop', dir: dir.name, frame, cause: 'closed' });
          return;
        }
        dir.stats.delivered++;
        this.observe?.({ type: 'deliver', dir: dir.name, frame });
        if (!end.handler || end.buffer.length > 0 || end.draining) {
          end.buffer.push(frame);
          if (end.handler && !end.draining) this.scheduleDrain(end);
          return;
        }
        return end.handler(frame);
      }
      case 'fin':
      case 'rst':
        if (!end.closed)
          this.markClosed(end, {
            reason: item.reason,
            by: 'remote',
            ...(item.retryAfterMs === undefined ? {} : { retryAfterMs: item.retryAfterMs }),
          });
        return;
      case 'ping':
        if (!end.closed)
          this.enqueue(end.out, {
            type: 'pong',
            probe: item.probe,
            dueAt: this.now() + this.latency(end.out),
          });
        return;
      case 'pong': {
        const probe = end.probes.get(item.probe);
        if (probe && !end.closed) {
          end.probes.delete(item.probe);
          probe.timer.cancel();
          probe.onResult(true);
        }
        return;
      }
    }
  }

  private scheduleDrain(end: End): void {
    end.draining = true;
    this.scheduler.after(0, async () => {
      try {
        while (end.buffer.length > 0 && !end.closed && end.handler) {
          const frame = end.buffer.shift();
          const result = end.handler(frame);
          if (isThenable(result)) await result;
        }
      } finally {
        end.draining = false;
        if (end.closed) end.buffer.length = 0;
      }
    });
  }

  setHandler(end: End, handler: FrameHandler<unknown>): void {
    end.handler = handler;
    if (end.buffer.length > 0 && !end.draining) this.scheduleDrain(end);
  }

  // ---- closing --------------------------------------------------------------------------------

  markClosed(end: End, info: CloseInfo): void {
    if (end.closed) return;
    end.closed = true;
    end.closeInfo = info;
    end.buffer.length = 0;
    for (const [id, probe] of end.probes) {
      end.probes.delete(id);
      probe.timer.cancel();
      this.scheduler.after(0, () => probe.onResult(false));
    }
    this.observe?.({ type: 'close', side: end.side, info });
    const handlers = [...end.closeHandlers];
    if (handlers.length > 0)
      this.scheduler.after(0, async () => {
        for (const handler of handlers) {
          const result = handler(info);
          if (isThenable(result)) await result;
        }
      });
  }

  close(end: End, reason: string, retryAfterMs?: number): void {
    if (end.closed) return;
    this.markClosed(end, { reason, by: 'local' });
    if (this.dead) return;
    const dir = end.out;
    const last = dir.queue[dir.queue.length - 1];
    this.enqueue(dir, {
      type: 'fin',
      reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      dueAt: Math.max(this.now() + this.latency(dir), last?.dueAt ?? 0),
    });
  }

  abort(end: End, reason: string): void {
    if (end.closed) return;
    this.markClosed(end, { reason, by: 'local' });
    if (this.dead) return;
    const dir = end.out;
    for (const item of dir.queue.splice(0)) if (item.type === 'data') dir.stats.dropped++;
    this.enqueue(dir, { type: 'rst', reason, dueAt: this.now() + this.latency(dir) });
  }

  ping(end: End, timeoutMs: number, onResult: (alive: boolean) => void): void {
    if (end.closed) {
      this.scheduler.after(0, () => onResult(false));
      return;
    }
    const probe = ++this.probeSeq;
    const timer = this.scheduler.after(timeoutMs, () => {
      if (!end.probes.delete(probe)) return;
      onResult(false);
    });
    end.probes.set(probe, { timer, onResult });
    if (this.dead) return;
    const dir = end.out;
    this.enqueue(dir, { type: 'ping', probe, dueAt: this.now() + this.latency(dir) });
  }

  // ---- faults ---------------------------------------------------------------------------------

  partition(ms?: number): void {
    if (this.dead) return;
    this.healTimer?.cancel();
    this.healTimer = undefined;
    for (const dir of Object.values(this.dirs)) {
      dir.blackholed = true;
      dir.pumpTimer?.cancel();
      dir.pumpTimer = undefined;
    }
    this.observe?.({
      type: 'fault',
      fault: 'partition',
      detail: ms === undefined ? 'until heal' : `${ms}ms`,
    });
    if (ms !== undefined) this.healTimer = this.scheduler.after(ms, () => this.heal());
  }

  heal(): void {
    this.healTimer?.cancel();
    this.healTimer = undefined;
    if (this.dead) return;
    const wasPartitioned = this.partitioned;
    for (const dir of Object.values(this.dirs)) {
      dir.blackholed = false;
      // Held data is retransmitted once the path is back.
      const resume = this.now() + this.latency(dir);
      for (const item of dir.queue) if (item.dueAt < resume) item.dueAt = resume;
      this.schedulePump(dir);
    }
    if (wasPartitioned) this.observe?.({ type: 'fault', fault: 'heal' });
  }

  get partitioned(): boolean {
    return this.dirs['a->b'].blackholed || this.dirs['b->a'].blackholed;
  }

  stall(which: LinkDirection | 'both', ms: number): void {
    for (const dir of which === 'both' ? Object.values(this.dirs) : [this.dirs[which]]) {
      dir.stalledUntil = Math.max(dir.stalledUntil, this.now() + ms);
      dir.pumpTimer?.cancel();
      dir.pumpTimer = undefined;
      this.schedulePump(dir);
    }
    this.observe?.({ type: 'fault', fault: 'stall', detail: `${which} ${ms}ms` });
  }

  halfOpen(dead: 'a' | 'b'): void {
    if (this.dead) return;
    this.kill();
    this.observe?.({ type: 'fault', fault: 'half-open', detail: `${dead} dead` });
    this.markClosed(this.ends[dead], { reason: 'half-open', by: 'fault' });
  }

  reset(reason: string): void {
    if (this.dead && this.ends.a.closed && this.ends.b.closed) return;
    this.kill();
    this.observe?.({ type: 'fault', fault: 'reset', detail: reason });
    this.markClosed(this.ends.a, { reason, by: 'fault' });
    this.markClosed(this.ends.b, { reason, by: 'fault' });
  }

  private kill(): void {
    this.dead = true;
    this.healTimer?.cancel();
    for (const dir of Object.values(this.dirs)) {
      dir.pumpTimer?.cancel();
      dir.pumpTimer = undefined;
      for (const item of dir.queue.splice(0)) if (item.type === 'data') dir.stats.dropped++;
    }
  }
}

class Conn implements FrameConn<unknown, unknown> {
  constructor(
    private readonly link: Link,
    private readonly end: End,
  ) {}
  get id(): string {
    return `${this.link.id}/${this.end.side}`;
  }
  get closed(): boolean {
    return this.end.closed;
  }
  get closeInfo(): CloseInfo | undefined {
    return this.end.closeInfo;
  }
  send(frame: unknown): boolean {
    return this.link.send(this.end, frame);
  }
  onFrame(handler: FrameHandler<unknown>): void {
    this.link.setHandler(this.end, handler);
  }
  onClose(handler: (info: CloseInfo) => void | Promise<void>): void {
    const info = this.end.closeInfo;
    if (info) this.link.scheduler.after(0, () => handler(info));
    else this.end.closeHandlers.push(handler);
  }
  close(reason = 'closed', info?: { retryAfterMs?: number }): void {
    this.link.close(this.end, reason, info?.retryAfterMs);
  }
  abort(reason = 'aborted'): void {
    this.link.abort(this.end, reason);
  }
  ping(timeoutMs: number, onResult: (alive: boolean) => void): void {
    this.link.ping(this.end, timeoutMs, onResult);
  }
}

/**
 * Creates an in-memory link. Everything is driven by `scheduler` and the seeded `rng`, so with a
 * `SimScheduler` the same seed always yields the same deliveries, drops and delays.
 */
export function createFramePair<A, B>(options: FramePairOptions<A, B>): FramePair<A, B> {
  const id = options.id ?? 'link';
  const link = new Link(
    id,
    options.scheduler,
    options.rng ?? createRng(`frame-pair/${id}`),
    {
      aToB: options.codecs?.aToB as FrameCodec<unknown> | undefined,
      bToA: options.codecs?.bToA as FrameCodec<unknown> | undefined,
    },
    {
      aToB: { ...options.faults, ...options.aToB },
      bToA: { ...options.faults, ...options.bToA },
    },
    options.observe,
  );
  const control: LinkControl = {
    id,
    configure(dir, faults) {
      for (const name of dir === 'both' ? (['a->b', 'b->a'] as const) : [dir])
        link.dirs[name].faults = withDefaults(faults);
    },
    stall: (dir, ms) => link.stall(dir, ms),
    partition: (ms) => link.partition(ms),
    heal: () => link.heal(),
    get partitioned() {
      return link.partitioned;
    },
    halfOpen: (dead) => link.halfOpen(dead),
    reset: (reason = 'reset') => link.reset(reason),
    dropNext(dir, count = 1) {
      link.dirs[dir].dropNext += count;
    },
    duplicateNext(dir, count = 1) {
      link.dirs[dir].duplicateNext += count;
    },
    intercept(dir, fn) {
      link.dirs[dir].interceptor = fn;
    },
    stats: (dir) => ({ ...link.dirs[dir].stats }),
    inFlight: (dir) => link.dirs[dir].queue.length,
  };
  return {
    a: new Conn(link, link.ends.a) as unknown as FrameConn<A, B>,
    b: new Conn(link, link.ends.b) as unknown as FrameConn<B, A>,
    control,
  };
}

/** The daemon's end of a Session stream. */
export type AgentConn = FrameConn<AgentFrame, ServerFrame>;
/** The gateway's end of a Session stream. */
export type ServerConn = FrameConn<ServerFrame, AgentFrame>;

/** An agent/v1 Session link: frames cross as their protobuf binary encoding. */
export interface AgentLink {
  /** The daemon end (`a`). */
  agent: AgentConn;
  /** The gateway end (`b`). */
  server: ServerConn;
  control: LinkControl;
}

export type AgentLinkOptions = Omit<FramePairOptions<AgentFrame, ServerFrame>, 'codecs'> & {
  /** Faults of daemon → gateway frames. */
  up?: LinkFaults;
  /** Faults of gateway → daemon frames. */
  down?: LinkFaults;
};

/** The protobuf codecs of the two Session directions (bounded by `MAX_FRAME_BYTES`). */
export const agentFrameCodec: FrameCodec<AgentFrame> = {
  encode: encodeAgentFrame,
  decode: decodeAgentFrame,
};
export const serverFrameCodec: FrameCodec<ServerFrame> = {
  encode: encodeServerFrame,
  decode: decodeServerFrame,
};

/** Creates a Session link whose frames cross as `encodeAgentFrame` / `encodeServerFrame` bytes. */
export function createAgentLink(options: AgentLinkOptions): AgentLink {
  const { up, down, ...rest } = options;
  const pair = createFramePair<AgentFrame, ServerFrame>({
    ...rest,
    aToB: { ...rest.aToB, ...up },
    bToA: { ...rest.bToA, ...down },
    codecs: { aToB: agentFrameCodec, bToA: serverFrameCodec },
  });
  return { agent: pair.a, server: pair.b, control: pair.control };
}
