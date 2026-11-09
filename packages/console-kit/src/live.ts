import type { Permissions } from './actions.js';
import {
  watchEvents,
  type ComputeEventMessage,
  type Watcher,
  type WatchOptions,
  type WatchStatus,
} from './events.js';
import {
  createConsoleResources,
  type ComputeRequester,
  type ConsoleResources,
} from './resources.js';
import { createStore, type Store } from './store.js';

// One call for a live console: follow `/watch`, load every store, route each event to the stores
// (and to any open detail pages), and drop cached permission answers when access may have changed
// (events about bindings, delegations or the caller's own identity).
//
// Nothing that happens between the load and the stream may be lost. The stream is opened first and
// the stores are loaded once it is open; events that arrive while a load is in flight are held and
// applied when it finishes, so a list answer never overwrites a newer event. A stream that opens
// with no cursor to resume from starts at "now": when that happens after a load began (the first
// attempt failed or took too long, or the stream dropped before any event), the stores are loaded
// once more.

export interface LiveConsole extends ConsoleResources {
  /** The event stream's state, for a "live" / "reconnecting" badge. */
  readonly connection: Store<{ status: WatchStatus; lastEventId?: string }>;
  /** Also sends every event to `handler` (detail pages, toasts); returns an unsubscribe. */
  onEvent(handler: (event: ComputeEventMessage) => void): () => void;
  stop(): Promise<void>;
}

/** Event types after which cached permission answers may be wrong. */
const accessChanging = /^(iam\.|binding\.|delegation\.|agent\.|project\.members)/;

export async function startLiveConsole(
  api: ComputeRequester,
  options: {
    tenantId: string;
    /** `…/api/compute/watch`. */
    watchUrl: string;
    headers?: WatchOptions['headers'];
    fetch?: typeof globalThis.fetch;
    permissions?: Permissions;
    /** Event types to follow (default all). */
    types?: readonly string[];
    pageSize?: number;
    /**
     * How long the first load waits for the event stream to open (default 3 s). After that it loads
     * anyway, and loads once more when the stream opens.
     */
    openWaitMs?: number;
    /** The stream's reconnect timer (injectable for tests). */
    sleep?: WatchOptions['sleep'];
  },
): Promise<LiveConsole> {
  const resources = createConsoleResources(api, {
    tenantId: options.tenantId,
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
  });
  const connection = createStore<{ status: WatchStatus; lastEventId?: string }>({
    status: 'connecting',
  });
  const handlers = new Set<(event: ComputeEventMessage) => void>();
  const deliver = (event: ComputeEventMessage) => {
    if (accessChanging.test(event.type)) options.permissions?.clear();
    void resources.applyEvent(event);
    for (const handler of handlers) handler(event);
    connection.set((state) => ({ ...state, lastEventId: event.id }));
  };
  /** Loads of every store in flight; the first one counts from the start. Events are held meanwhile. */
  let loading = 1;
  let loadBegan = false;
  const held: ComputeEventMessage[] = [];
  const loaded = () => {
    if (--loading === 0) for (const event of held.splice(0)) deliver(event);
  };
  /** The stream opened, or its first attempt failed: the first load need not wait any longer. */
  let attempted!: () => void;
  const firstAttempt = new Promise<void>((resolve) => (attempted = resolve));
  const watcher: Watcher = watchEvents({
    url: options.watchUrl,
    ...(options.types ? { types: options.types } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    onEvent(event) {
      if (loading > 0) held.push(event);
      else deliver(event);
    },
    onStatus(status) {
      connection.set((state) => ({ ...state, status }));
      if (status === 'connecting') return;
      // Open with no cursor to resume from, after a load began: what happened since was not streamed.
      if (status === 'open' && loadBegan && watcher.lastEventId === undefined) {
        loading++;
        void resources
          .refreshAll()
          .catch(() => undefined)
          .finally(loaded);
      }
      attempted();
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    firstAttempt,
    new Promise<void>((resolve) => (timer = setTimeout(resolve, options.openWaitMs ?? 3000))),
  ]);
  clearTimeout(timer);
  loadBegan = true;
  try {
    await resources.refreshAll();
  } catch (error) {
    watcher.stop();
    await watcher.done;
    throw error;
  } finally {
    loaded();
  }
  return {
    ...resources,
    connection,
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async stop() {
      watcher.stop();
      await watcher.done;
    },
  };
}
