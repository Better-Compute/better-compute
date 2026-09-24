import { matchesType, type ComputeEventMessage } from './events.js';
import {
  createListResource,
  createValueResource,
  type ListResource,
  type Page,
  type ValueResource,
} from './list.js';

// The console's resource stores over the compute API (PLAN.md §9.2): nodes, pools, reservations,
// instances and the capacity summary for one tenant, each loaded through its list or get method,
// and kept current from the event stream: an event about `reservation/rsv_…` re-reads that
// reservation (or drops it when it is gone), pool and node events refresh capacity, debounced.

/** What the stores call: a `createComputeClient()` satisfies it. */
export interface ComputeRequester {
  $request<Output = unknown>(
    path: string,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<Output>;
}

/** Every listed item has an id; the rest is the API's view of it. */
export type Item = { id: string } & Record<string, unknown>;

export interface ConsoleResources {
  tenantId: string;
  nodes: ListResource<Item>;
  pools: ListResource<Item>;
  reservations: ListResource<Item>;
  /** v0.3 (the vps module); errors when the deployment does not run it. */
  instances: ListResource<Item>;
  capacity: ValueResource<Record<string, unknown>>;
  /** Routes one event from `watchEvents` to the stores it concerns. */
  applyEvent(event: ComputeEventMessage): Promise<void>;
  /** Loads (or reloads) every store. */
  refreshAll(): Promise<void>;
}

export interface ConsoleResourcesOptions {
  tenantId: string;
  /** Page size for lists that page (default 50). */
  pageSize?: number;
  /** How long to gather events before refreshing a summary (default 250 ms). */
  debounceMs?: number;
  setTimer?(callback: () => void, ms: number): unknown;
}

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;

export function createConsoleResources(
  api: ComputeRequester,
  options: ConsoleResourcesOptions,
): ConsoleResources {
  const { tenantId } = options;
  const size = options.pageSize ?? 50;
  const list = (path: string, extra: Record<string, unknown> = {}) =>
    createListResource<Item>({
      key: (item) => item.id,
      load: (cursor, signal) =>
        api.$request<Page<Item>>(
          path,
          { tenantId, limit: size, ...extra, ...(cursor ? { cursor } : {}) },
          { signal },
        ),
    });
  const nodes = list('nodes/list');
  // pools.list returns every visible pool at once (no paging input).
  const pools = createListResource<Item>({
    key: (item) => item.id,
    load: (_cursor, signal) => api.$request<Page<Item>>('pools/list', { tenantId }, { signal }),
  });
  const reservations = list('reservations/list');
  const instances = list('instances/list');
  const capacity = createValueResource({
    load: (signal) =>
      api.$request<Record<string, unknown>>('capacity/summary', { tenantId }, { signal }),
  });

  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const pending = new Set<() => Promise<void>>();
  let scheduled = false;
  const later = (refresh: () => Promise<void>) => {
    pending.add(refresh);
    if (scheduled) return;
    scheduled = true;
    setTimer(() => {
      scheduled = false;
      const due = [...pending];
      pending.clear();
      for (const run of due) void run();
    }, options.debounceMs ?? 250);
  };

  /** Re-reads one item into a loaded list, or drops it when it no longer exists. */
  const reread = async (store: ListResource<Item>, path: string, field: string, id: string) => {
    if (store.get().status === 'idle') return;
    try {
      store.upsert(await api.$request<Item>(path, { tenantId, [field]: id }));
    } catch (error) {
      if (code(error) === 'NOT_FOUND' || code(error) === 'ACCESS_DENIED') store.remove(id);
    }
  };

  const loaded = (store: { get(): { status: string } }) => store.get().status !== 'idle';

  return {
    tenantId,
    nodes,
    pools,
    reservations,
    instances,
    capacity,
    async applyEvent(event) {
      if (event.tenantId && event.tenantId !== tenantId) return;
      const [kind, id] = event.subject.split('/') as [string, string | undefined];
      if (kind === 'reservation' && id) {
        await reread(reservations, 'reservations/get', 'reservationId', id);
        if (loaded(capacity)) later(capacity.refresh);
      } else if (kind === 'node' && id) {
        await reread(nodes, 'nodes/get', 'nodeId', id);
        if (loaded(capacity) && !matchesType('node.status', event.type)) later(capacity.refresh);
      } else if (kind === 'instance' && id) {
        await reread(instances, 'instances/get', 'instanceId', id);
      } else if (kind === 'pool') {
        if (loaded(pools)) later(pools.refresh);
        if (loaded(capacity)) later(capacity.refresh);
      }
    },
    async refreshAll() {
      await Promise.all([
        nodes.refresh(),
        pools.refresh(),
        reservations.refresh(),
        instances.refresh(),
        capacity.refresh(),
      ]);
    },
  };
}
