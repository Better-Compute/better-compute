import { createHash, type Hash } from 'node:crypto';
import type { Clock } from '@better-compute/core';

/** A value the event log can render deterministically. */
export type LogValue = string | number | boolean | bigint | null | undefined | readonly LogValue[];

/** One entry of the simulator's event log. */
export interface LogEntry {
  /** Scheduler time in milliseconds. */
  t: number;
  /** Position in the log, from 0. */
  seq: number;
  /** Who logged it, e.g. `node_…`, `gateway`, `link:node_…`, `sim`. */
  source: string;
  event: string;
  data?: Readonly<Record<string, LogValue>>;
}

export interface EventLogOptions {
  /** Keep entries in memory (default true). The digest is always maintained. */
  keep?: boolean;
  /** Drop entries this returns false for (neither kept nor hashed). */
  filter?: (source: string, event: string) => boolean;
}

const render = (value: LogValue): string => {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (Array.isArray(value)) return `[${value.map(render).join(',')}]`;
  return JSON.stringify(value);
};

/** One line per entry: `<t> <source> <event> k=v …` with keys in insertion order. */
export function formatLogEntry(entry: LogEntry): string {
  let line = `${entry.t} ${entry.source} ${entry.event}`;
  if (entry.data)
    for (const [key, value] of Object.entries(entry.data))
      line += ` ${key}=${render(value as LogValue)}`;
  return line;
}

/**
 * The simulator's event log: every notable action (frames, faults, crashes, command transitions)
 * in the order it happened. Two runs with the same seed produce the same log, so `digest()` is the
 * reproducibility check.
 */
export class EventLog {
  readonly entries: LogEntry[] = [];
  private readonly hash: Hash = createHash('sha256');
  private count = 0;
  private readonly keep: boolean;
  private readonly filter: ((source: string, event: string) => boolean) | undefined;

  constructor(
    private readonly clock: Clock,
    options: EventLogOptions = {},
  ) {
    this.keep = options.keep ?? true;
    this.filter = options.filter;
  }

  /** Appends an entry. */
  add(source: string, event: string, data?: Record<string, LogValue>): void {
    if (this.filter && !this.filter(source, event)) return;
    const entry: LogEntry = { t: this.clock.now(), seq: this.count++, source, event };
    if (data) entry.data = data;
    this.hash.update(`${formatLogEntry(entry)}\n`);
    if (this.keep) this.entries.push(entry);
  }

  /** Entries logged so far (including ones not kept). */
  get size(): number {
    return this.count;
  }

  /** The kept entries as text lines. */
  lines(): string[] {
    return this.entries.map(formatLogEntry);
  }

  /** Lowercase hex SHA-256 over every line logged so far. */
  digest(): string {
    return this.hash.copy().digest('hex');
  }

  /** Kept entries matching `event` (and `source`, when given). */
  find(event: string, source?: string): LogEntry[] {
    return this.entries.filter(
      (e) => e.event === event && (source === undefined || e.source === source),
    );
  }
}
