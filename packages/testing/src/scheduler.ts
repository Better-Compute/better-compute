import { ComputeError, manualClock, type Clock, type ManualClock } from '@better-compute/core';

/** Work the scheduler runs. A returned promise is awaited before the next task starts. */
export type Task = () => void | Promise<void>;

/** A scheduled task. */
export interface Timer {
  /** When it runs, in scheduler milliseconds. */
  readonly at: number;
  /** Stops it from running; idempotent. */
  cancel(): void;
}

/**
 * Time and timers for the testing kit's fakes (FakeDaemon, FrameConn, the gateway stub). The sim
 * implementation never touches real timers; the realtime one wraps `setTimeout` for the real-time
 * harness (PLAN.md §15).
 */
export interface Scheduler extends Clock {
  /** Runs `task` after `delayMs` (clamped to >= 0). Tasks due at the same time run in order. */
  after(delayMs: number, task: Task): Timer;
}

/**
 * A deterministic scheduler over a manual clock. Tasks run strictly in (time, insertion) order and
 * one at a time: a task that returns a promise is awaited before the next one starts, so an async
 * participant (a DB-backed gateway core) stays deterministic as long as it uses this scheduler for
 * its own timers.
 */
export interface SimScheduler extends Scheduler {
  /** The manual clock the scheduler moves; hand it to components that need a `Clock`. */
  readonly clock: ManualClock;
  /** Runs `task` at `time` (or now, when `time` is in the past). */
  at(time: number, task: Task): Timer;
  /** Runs every task due within the next `ms`, moving the clock to each task's time, then to now+ms. */
  advance(ms: number): Promise<number>;
  /** `advance` up to an absolute time. */
  advanceTo(time: number): Promise<number>;
  /** Runs the tasks due now, including the ones they schedule for now. */
  flush(): Promise<void>;
  /** Moves to the next task's time and runs every task due then; false when none is pending. */
  step(): Promise<boolean>;
  /** The time of the next pending task. */
  nextAt(): number | undefined;
  /** Pending (not cancelled) tasks. */
  readonly pending: number;
  /** Tasks run so far. */
  readonly executed: number;
  /**
   * Called (and awaited) whenever the clock moves, before the tasks of the new time run. The fleet
   * sim uses it to move `compute_sim_clock` with the scheduler (`fixture.clock.set`).
   */
  onTime(hook: ((ms: number) => void | Promise<void>) | undefined): void;
}

interface Entry {
  at: number;
  seq: number;
  task: Task;
  cancelled: boolean;
  done: boolean;
}

const before = (x: Entry, y: Entry): boolean => x.at < y.at || (x.at === y.at && x.seq < y.seq);

/** A binary min-heap on (at, seq). */
class Heap {
  private readonly items: Entry[] = [];
  get size(): number {
    return this.items.length;
  }
  peek(): Entry | undefined {
    return this.items[0];
  }
  push(entry: Entry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }
  pop(): Entry | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && before(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && before(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

export interface SimSchedulerOptions {
  /** Start time in milliseconds since the epoch (default 2026-01-01T00:00:00Z). */
  start?: number;
  /**
   * Upper bound of tasks one `advance` may run, to turn an accidental zero-delay loop into an error
   * instead of a hang (default 10 million).
   */
  maxTasksPerAdvance?: number;
}

/** A deterministic scheduler (see `SimScheduler`). */
export function createSimScheduler(options: SimSchedulerOptions = {}): SimScheduler {
  const clock = manualClock(options.start ?? Date.UTC(2026, 0, 1));
  const limit = options.maxTasksPerAdvance ?? 10_000_000;
  const heap = new Heap();
  let seq = 0;
  let pending = 0;
  let executed = 0;
  let hook: ((ms: number) => void | Promise<void>) | undefined;
  let running = false;

  const schedule = (time: number, task: Task): Timer => {
    const entry: Entry = {
      at: Math.max(time, clock.now()),
      seq: seq++,
      task,
      cancelled: false,
      done: false,
    };
    heap.push(entry);
    pending++;
    return {
      at: entry.at,
      cancel() {
        if (entry.cancelled || entry.done) return;
        entry.cancelled = true;
        pending--;
      },
    };
  };

  const moveTo = async (time: number): Promise<void> => {
    if (time <= clock.now()) return;
    clock.set(time);
    if (hook) {
      const result = hook(time);
      if (isThenable(result)) await result;
    }
  };

  const run = async (target: number): Promise<number> => {
    if (running)
      throw new ComputeError(
        'INVALID_STATE',
        'SimScheduler.advance() is not reentrant; a task awaited it',
      );
    running = true;
    let count = 0;
    try {
      for (;;) {
        const top = heap.peek();
        if (!top || top.at > target) break;
        heap.pop();
        if (top.cancelled) continue;
        top.done = true;
        pending--;
        await moveTo(top.at);
        if (++count > limit)
          throw new ComputeError(
            'INVALID_STATE',
            `SimScheduler ran more than ${limit} tasks in one advance; a task probably reschedules itself with no delay`,
          );
        executed++;
        const result = top.task();
        if (isThenable(result)) await result;
      }
      await moveTo(target);
      return clock.now();
    } finally {
      running = false;
    }
  };

  return {
    clock,
    now: () => clock.now(),
    after: (delayMs, task) =>
      schedule(clock.now() + (Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0), task),
    at: (time, task) => schedule(time, task),
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0)
        throw new ComputeError(
          'INVALID_INPUT',
          'advance() takes a non-negative number of milliseconds',
        );
      return run(clock.now() + ms);
    },
    advanceTo: (time) => run(Math.max(time, clock.now())),
    async flush() {
      await run(clock.now());
    },
    async step() {
      let top = heap.peek();
      while (top?.cancelled) {
        heap.pop();
        top = heap.peek();
      }
      if (!top) return false;
      await run(top.at);
      return true;
    },
    nextAt() {
      let top = heap.peek();
      while (top?.cancelled) {
        heap.pop();
        top = heap.peek();
      }
      return top?.at;
    },
    get pending() {
      return pending;
    },
    get executed() {
      return executed;
    },
    onTime(next) {
      hook = next;
    },
  };
}

export interface RealtimeSchedulerOptions {
  /** Called with errors thrown (or rejected) by tasks; default `console.error`. */
  onError?: (error: unknown) => void;
}

/**
 * The wall clock and `setTimeout`, for the real-time harness. Not deterministic: tasks may
 * interleave, and nothing awaits them.
 */
export function createRealtimeScheduler(options: RealtimeSchedulerOptions = {}): Scheduler {
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  return {
    now: () => Date.now(),
    after(delayMs, task) {
      const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
      const handle = setTimeout(() => {
        try {
          const result = task();
          if (isThenable(result)) Promise.resolve(result).catch(onError);
        } catch (error) {
          onError(error);
        }
      }, delay);
      return { at: Date.now() + delay, cancel: () => clearTimeout(handle) };
    },
  };
}
