// Live updates from `GET /watch` (PLAN.md §9.3, `@better-compute/events` `handleWatch`): Server-Sent
// Events read over `fetch` rather than `EventSource`, so the request can carry an Authorization
// header. Each event's `id:` is its outbox cursor; a reconnect sends it as `Last-Event-ID` and
// resumes exactly after it. The stream reconnects with the server's `retry:` delay (capped
// exponential backoff after failures) until stopped.

/** A compute event as the stream carries it (CloudEvents-style). */
export interface ComputeEventMessage {
  id: string;
  type: string;
  tenantId: string;
  subject: string;
  time?: number | string;
  sequence?: number | string;
  data?: Record<string, unknown>;
}

export type WatchStatus = 'connecting' | 'open' | 'retrying' | 'stopped';

export interface WatchOptions {
  /** The watch endpoint, e.g. `https://compute.example.com/api/compute/watch`. */
  url: string;
  /** Event type patterns (`reservation.*`, `node.connected`); all when absent. */
  types?: readonly string[];
  /** Resume after this cursor. */
  lastEventId?: string;
  /** Headers per connection (a fresh bearer token each time). */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof globalThis.fetch;
  onEvent(event: ComputeEventMessage): void;
  onStatus?(status: WatchStatus, detail?: { error?: unknown; retryInMs?: number }): void;
  /** Backoff after failures: starts at the server's retry (default 2 s), doubles, capped here. */
  maxBackoffMs?: number;
  /** Timers (injectable for tests). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

export interface Watcher {
  /** The cursor of the last event delivered. */
  readonly lastEventId: string | undefined;
  stop(): void;
  /** Resolves once stopped. */
  readonly done: Promise<void>;
}

/** Parses one SSE block (`field: value` lines). Exported for tests. */
export function parseSseBlock(block: string): {
  id?: string;
  event?: string;
  data?: string;
  retry?: number;
} {
  const out: { id?: string; event?: string; data?: string; retry?: number } = {};
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'id') out.id = value;
    else if (field === 'event') out.event = value;
    else if (field === 'retry' && /^\d+$/.test(value)) out.retry = Number(value);
  }
  if (data.length) out.data = data.join('\n');
  return out;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export function watchEvents(options: WatchOptions): Watcher {
  const controller = new AbortController();
  const fetcher = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  let lastEventId = options.lastEventId;
  let retryMs = 2000;
  let failures = 0;
  const status = (value: WatchStatus, detail?: { error?: unknown; retryInMs?: number }) =>
    options.onStatus?.(value, detail);

  const connect = async (): Promise<void> => {
    const url = new URL(options.url);
    if (options.types?.length) url.searchParams.set('types', options.types.join(','));
    const headers = new Headers((await options.headers?.()) ?? {});
    headers.set('accept', 'text/event-stream');
    if (lastEventId) headers.set('last-event-id', lastEventId);
    const response = await fetcher(url, { headers, signal: controller.signal });
    if (!response.ok || !response.body)
      throw Object.assign(new Error(`watch answered ${response.status}`), {
        status: response.status,
      });
    status('open');
    failures = 0;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
        const parsed = parseSseBlock(block);
        if (parsed.retry !== undefined) retryMs = parsed.retry;
        if (parsed.event === 'error' || parsed.data === undefined) continue;
        let event: ComputeEventMessage;
        try {
          event = JSON.parse(parsed.data) as ComputeEventMessage;
        } catch {
          continue;
        }
        if (parsed.id) lastEventId = parsed.id;
        options.onEvent(event);
      }
    }
  };

  const done = (async () => {
    while (!controller.signal.aborted) {
      status(failures ? 'retrying' : 'connecting');
      try {
        await connect();
      } catch (error) {
        if (controller.signal.aborted) break;
        // A refused credential will not fix itself by retrying fast.
        failures += 1;
        const wait = Math.min(retryMs * 2 ** (failures - 1), options.maxBackoffMs ?? 60_000);
        status('retrying', { error, retryInMs: wait });
        await sleep(wait, controller.signal);
        continue;
      }
      // The server closed the stream on purpose (its max duration): reconnect after `retry`.
      if (!controller.signal.aborted) await sleep(retryMs, controller.signal);
    }
    status('stopped');
  })();

  return {
    get lastEventId() {
      return lastEventId;
    },
    stop: () => controller.abort(),
    done,
  };
}

/** Whether `type` matches a pattern like `reservation.*` or `*`. */
export function matchesType(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  return pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}
