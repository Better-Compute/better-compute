import type { Permissions } from './actions.js';
import {
  watchEvents,
  type ComputeEventMessage,
  type WatchOptions,
  type WatchStatus,
} from './events.js';
import {
  createConsoleResources,
  type ComputeRequester,
  type ConsoleResources,
} from './resources.js';
import { createStore, type Store } from './store.js';

// One call for a live console: load every store, follow `/watch`, route each event to the stores
// (and to any open detail pages), and drop cached permission answers when access may have changed
// (events about bindings, delegations or the caller's own identity).

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
  await resources.refreshAll();
  const watcher = watchEvents({
    url: options.watchUrl,
    ...(options.types ? { types: options.types } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onEvent(event) {
      if (accessChanging.test(event.type)) options.permissions?.clear();
      void resources.applyEvent(event);
      for (const handler of handlers) handler(event);
      connection.set((state) => ({ ...state, lastEventId: event.id }));
    },
    onStatus: (status) => connection.set((state) => ({ ...state, status })),
  });
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
