import type { DoEmulator } from './index.js';
import { fixture, type DoState, type Json } from './state.js';

// Actions: what DO hands back for the asynchronous part of a Droplet call. `GET /v2/actions/{id}`
// and `GET /v2/droplets/{id}/actions` read them from `state.actions`. An action starts
// `in-progress`; the service that started it settles it (a create completes after some reads of
// its Droplet). `failAction` makes one end `errored`, which DO reports without any message.

/** The shape of an `action` body, from the fixture. */
const template = fixture('actions').action as Json;

interface ActionMatch {
  type: string;
  /** The Droplet; absent matches any. */
  resourceId?: number;
}

/** Armed failures per emulator state: the next matching action to start ends `errored`. */
const armed = new WeakMap<DoState, ActionMatch[]>();

/** DO's timestamps carry whole seconds. */
export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function matches(action: Json, match: ActionMatch): boolean {
  return (
    action.type === match.type &&
    (match.resourceId === undefined || action.resource_id === match.resourceId)
  );
}

/** Starts an action on a Droplet: `in-progress`, or `errored` straight away when one was armed. */
export function startAction(state: DoState, type: string, droplet: Json): Json {
  const action: Json = {
    ...structuredClone(template),
    id: state.nextId(),
    status: 'in-progress',
    type,
    started_at: isoSeconds(state.now()),
    completed_at: null,
    resource_id: droplet.id,
    resource_type: 'droplet',
    region: structuredClone(droplet.region),
    region_slug: droplet.region?.slug ?? null,
  };
  const pending = armed.get(state) ?? [];
  const failure = pending.findIndex((match) => matches(action, match));
  if (failure >= 0) {
    pending.splice(failure, 1);
    action.status = 'errored';
    action.completed_at = isoSeconds(state.now());
  }
  state.actions.set(action.id, action);
  return action;
}

/** Ends an in-progress action. */
export function settleAction(state: DoState, action: Json, status: 'completed' | 'errored'): void {
  if (action.status !== 'in-progress') return;
  action.status = status;
  action.completed_at = isoSeconds(state.now());
}

/**
 * Makes an action end `errored`: an in-progress one that matches now, else the next one started
 * that matches (a create that DO accepts with a 202 and then fails).
 */
export function failAction(state: DoState, match: ActionMatch): void {
  const running = [...state.actions.values()].find(
    (action) => action.status === 'in-progress' && matches(action, match),
  );
  if (running) {
    settleAction(state, running, 'errored');
    return;
  }
  const pending = armed.get(state) ?? [];
  pending.push(match);
  armed.set(state, pending);
}

export function registerActions(emulator: DoEmulator): void {
  emulator.route('GET', /^\/actions\/(\d+)$/, (context) => {
    const action = context.state.actions.get(Number(context.match[1]));
    if (!action) return emulator.error('not-found');
    return { status: 200, body: { action } };
  });

  emulator.route('GET', /^\/droplets\/(\d+)\/actions$/, (context) => {
    const id = Number(context.match[1]);
    if (!context.state.droplets.has(id)) return emulator.error('not-found');
    const actions = [...context.state.actions.values()].filter(
      (action) => action.resource_type === 'droplet' && action.resource_id === id,
    );
    return emulator.paged(context, 'actions', actions);
  });
}
