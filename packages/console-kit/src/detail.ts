import {
  instanceStateTable,
  provisionStateTable,
  reservationStateTable,
  type ComputeResourceKind,
  type StateTable,
} from '@better-compute/core';
import { actionsFor, type ActionDescriptor, type Permissions } from './actions.js';
import type { ComputeEventMessage } from './events.js';
import { createStore, type Store } from './store.js';
import type { ComputeRequester, Item } from './resources.js';

// Detail pages (a reservation, a node, an instance, a pool): the item, and every §9.2 action on it
// pre-gated twice. `applicable`: the item's state allows it (core's state tables: `release` needs a
// state with a `release` exit; `cordon` needs an uncordoned node). `allowed`: IAM would allow the
// caller (asked through `Permissions`). The server still decides every call.

export type DetailKind = 'reservation' | 'node' | 'instance' | 'pool';

export interface DetailAction extends ActionDescriptor {
  /** The item's current state allows it. */
  applicable: boolean;
  /** IAM's answer; undefined until known (render disabled). */
  allowed?: boolean;
}

export interface DetailState {
  item?: Item;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'gone';
  error?: unknown;
  actions: DetailAction[];
}

export interface DetailOutcome {
  status: 'done' | 'confirmation-required';
  result?: unknown;
  confirmationId?: string;
}

export interface Detail extends Store<DetailState> {
  refresh(): Promise<void>;
  /** Refreshes when the event is about this item. */
  applyEvent(event: ComputeEventMessage): Promise<void>;
  /**
   * Calls one action (`path` from `actions`) with the item's id and `input`, then refreshes. A
   * delegated session held back for a person answers `confirmation-required`.
   */
  run(path: string, input?: Record<string, unknown>): Promise<DetailOutcome>;
}

const lookup: Record<DetailKind, { get: string; field: string }> = {
  reservation: { get: 'reservations/get', field: 'reservationId' },
  node: { get: 'nodes/get', field: 'nodeId' },
  instance: { get: 'instances/get', field: 'instanceId' },
  pool: { get: 'pools/get', field: 'poolId' },
};

const tables: Partial<Record<DetailKind, { table: StateTable<string, string>; field: string }>> = {
  reservation: {
    table: reservationStateTable as unknown as StateTable<string, string>,
    field: 'state',
  },
  instance: { table: instanceStateTable as unknown as StateTable<string, string>, field: 'state' },
  node: {
    table: provisionStateTable as unknown as StateTable<string, string>,
    field: 'provisionState',
  },
};

/** Whether `action` applies to `item` now, from its state machine and flags. */
export function applicable(kind: DetailKind, action: ActionDescriptor, item: Item): boolean {
  if (kind === 'node') {
    if (action.path === 'nodes/cordon') return item.cordoned !== true;
    if (action.path === 'nodes/uncordon') return item.cordoned === true;
  }
  const machine = tables[kind];
  if (!machine) return true;
  const state = item[machine.field];
  if (typeof state !== 'string') return true;
  // Nothing changes an item in a terminal state (released, deleted, …).
  if (machine.table.terminal.includes(state)) return false;
  if (!machine.table.verbs.includes(action.method)) return true;
  const moves = machine.table.transitions[state] as Record<string, unknown> | undefined;
  return Boolean(moves && Object.hasOwn(moves, action.method));
}

export function createDetail(
  api: ComputeRequester,
  options: {
    tenantId: string;
    kind: DetailKind;
    id: string;
    permissions?: Permissions;
    /** Offer only methods of these phases / modules (what the deployment runs). */
    phases?: readonly string[];
    modules?: readonly string[];
  },
): Detail {
  const { kind, id, tenantId } = options;
  const { get, field } = lookup[kind];
  const descriptors = actionsFor(kind as ComputeResourceKind, id, {
    ...(options.phases ? { phases: options.phases } : {}),
    ...(options.modules ? { modules: options.modules } : {}),
  });
  const store = createStore<DetailState>({ status: 'idle', actions: [] });
  let generation = 0;

  const gate = (item: Item | undefined): DetailAction[] =>
    descriptors.map((descriptor) => {
      const allowed = options.permissions?.peek(descriptor);
      return {
        ...descriptor,
        applicable: item ? applicable(kind, descriptor, item) : false,
        ...(allowed !== undefined ? { allowed } : {}),
      };
    });

  const askPermissions = async (mine: number) => {
    const permissions = options.permissions;
    if (!permissions) return;
    const answers = await Promise.all(
      descriptors.map((descriptor) => permissions.can(descriptor).catch(() => undefined)),
    );
    if (mine !== generation) return;
    store.set((state) => ({
      ...state,
      actions: state.actions.map((action, index) =>
        answers[index] === undefined ? action : { ...action, allowed: answers[index] },
      ),
    }));
  };

  const refresh = async () => {
    const mine = ++generation;
    store.set((state) => ({ ...state, status: 'loading' }));
    try {
      const item = await api.$request<Item>(get, { tenantId, [field]: id });
      if (mine !== generation) return;
      store.set({ item, status: 'ready', actions: gate(item) });
      await askPermissions(mine);
    } catch (error) {
      if (mine !== generation) return;
      const code = (error as { code?: unknown } | null)?.code;
      store.set((state) => ({
        ...state,
        status: code === 'NOT_FOUND' ? 'gone' : 'error',
        error,
        actions: code === 'NOT_FOUND' ? gate(undefined) : state.actions,
      }));
    }
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    refresh,
    async applyEvent(event) {
      if (event.tenantId && event.tenantId !== tenantId) return;
      if (event.subject === `${kind}/${id}`) await refresh();
    },
    async run(path, input = {}) {
      if (!descriptors.some((descriptor) => descriptor.path === path))
        throw new Error(`${path} is not an action on ${kind}`);
      try {
        const result = await api.$request(path, { tenantId, [field]: id, ...input });
        await refresh();
        return { status: 'done', result };
      } catch (error) {
        const failure = error as { code?: unknown; details?: { confirmationId?: unknown } };
        if (failure?.code === 'CONFIRMATION_REQUIRED')
          return {
            status: 'confirmation-required',
            ...(typeof failure.details?.confirmationId === 'string'
              ? { confirmationId: failure.details.confirmationId }
              : {}),
          };
        throw error;
      }
    },
  };
}
