import { ComputeError } from './errors.js';

/**
 * A state machine as data. `transitions[state][verb]` is the next state, or the list of states the
 * caller chooses from (for example `recover`, whose target depends on where the failure happened).
 * Storage applies transitions as guarded updates (`WHERE state = $from AND version = $v`) after
 * checking legality here, so every legal move is visible in one table.
 */
export interface StateTable<S extends string, V extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly verbs: readonly V[];
  /** States records are created in. */
  readonly initial: readonly S[];
  /** States with no exits. */
  readonly terminal: readonly S[];
  readonly transitions: { readonly [K in S]: { readonly [W in V]?: S | readonly S[] } };
}

export type StateOf<T> = T extends StateTable<infer S, string> ? S : never;
export type VerbOf<T> = T extends StateTable<string, infer V> ? V : never;

function invalid(table: StateTable<string, string>, from: string, verb: string, to?: string) {
  const target = to === undefined ? '' : ` to ${to}`;
  return new ComputeError(
    'INVALID_STATE',
    `${table.name}: cannot ${verb} from ${from}${target}`,
    undefined,
    { table: table.name, from, verb, ...(to === undefined ? {} : { to }) },
  );
}

/** Validates a table's shape once, at module load: every name is declared and terminal states have no exits. */
export function defineStateTable<const S extends string, const V extends string>(
  table: StateTable<S, V>,
): StateTable<S, V> {
  const states = new Set<string>(table.states);
  const verbs = new Set<string>(table.verbs);
  const fail = (message: string) => {
    throw new ComputeError('INVALID_CONFIG', `${table.name}: ${message}`);
  };
  if (states.size !== table.states.length) fail('duplicate state');
  if (verbs.size !== table.verbs.length) fail('duplicate verb');
  for (const state of [...table.initial, ...table.terminal])
    if (!states.has(state)) fail(`unknown state ${state}`);
  for (const state of Object.keys(table.transitions))
    if (!states.has(state)) fail(`transitions for unknown state ${state}`);
  for (const state of table.states) {
    if (!Object.hasOwn(table.transitions, state)) fail(`no transitions entry for ${state}`);
    const moves = table.transitions[state];
    for (const [verb, target] of Object.entries(moves)) {
      if (!verbs.has(verb)) fail(`unknown verb ${verb} on ${state}`);
      const next = (Array.isArray(target) ? target : [target]) as string[];
      if (!next.length) fail(`${state} --${verb}--> has no target`);
      for (const to of next) if (!states.has(to)) fail(`unknown target ${to}`);
    }
    if (table.terminal.includes(state) && Object.keys(moves).length)
      fail(`terminal state ${state} has exits`);
  }
  return Object.freeze(table);
}

/** The states `verb` may lead to from `from`; empty when the move is illegal. */
export function targets<S extends string, V extends string>(
  table: StateTable<S, V>,
  from: S,
  verb: V,
): readonly S[] {
  if (!Object.hasOwn(table.transitions, from)) return [];
  const exits = table.transitions[from];
  if (!Object.hasOwn(exits, verb)) return [];
  const target = exits[verb] as S | readonly S[];
  return typeof target === 'string' ? [target] : target;
}

/** Whether `transition(table, from, verb, to)` would succeed. */
export function canTransition<S extends string, V extends string>(
  table: StateTable<S, V>,
  from: S,
  verb: V,
  to?: S,
): boolean {
  const next = targets(table, from, verb);
  if (!next.length) return false;
  if (to !== undefined) return next.includes(to);
  return next.length === 1;
}

/**
 * Applies `verb` to `from` and returns the next state. When the verb has several possible targets
 * the caller names one with `to`. Illegal moves throw `INVALID_STATE`.
 */
export function transition<S extends string, V extends string>(
  table: StateTable<S, V>,
  from: S,
  verb: V,
  to?: S,
): S {
  const next = targets(table, from, verb);
  if (to !== undefined) {
    if (!next.includes(to)) throw invalid(table, from, verb, to);
    return to;
  }
  if (next.length !== 1) throw invalid(table, from, verb);
  return next[0]!;
}

/** Every legal `(verb, to)` exit of a state. */
export function exits<S extends string, V extends string>(
  table: StateTable<S, V>,
  from: S,
): { verb: V; to: S }[] {
  const result: { verb: V; to: S }[] = [];
  for (const verb of table.verbs)
    for (const to of targets(table, from, verb)) result.push({ verb, to });
  return result;
}

export function isTerminal<S extends string>(table: StateTable<S, string>, state: S): boolean {
  return table.terminal.includes(state);
}

// ---------------------------------------------------------------------------------------------
// Metal provision states (§11.1). Maintenance, cordon, power and connectivity are separate axes.
// ---------------------------------------------------------------------------------------------

export const provisionStates = [
  'adopting',
  'adopted',
  'enrolling',
  'inspecting',
  'commissioning',
  'ready',
  'deploying',
  'deployed',
  'releasing',
  'rescue',
  'failed',
  'retiring',
  'retired',
] as const;
export type ProvisionState = (typeof provisionStates)[number];

/**
 * - `adopt` re-runs acceptance on an adopted node (`nodes.adopt`); `complete` marks the current
 *   workflow (acceptance, BMC verification, inspection, commissioning, deploy, release, retirement)
 *   finished; `fail` is a workflow failure and `abort` an operator stop (`metal.abort`), both
 *   landing in `failed` with `failedFrom` set and maintenance on.
 * - `manage` (ready → enrolling) re-verifies BMC access; `inspect` re-inspects; `provide`
 *   re-commissions; `release` covers both `metal.undeploy` and releasing an adopted node with a BMC.
 * - `recover` returns a failed node to `metalRecoverTargets[failedFrom]`.
 */
export const provisionVerbs = [
  'adopt',
  'complete',
  'manage',
  'inspect',
  'provide',
  'deploy',
  'release',
  'rescue',
  'unrescue',
  'fail',
  'abort',
  'recover',
  'retire',
] as const;
export type ProvisionVerb = (typeof provisionVerbs)[number];

/** States a failure can come from; `failedFrom` is always one of these. */
export const provisionFailableStates = [
  'enrolling',
  'inspecting',
  'commissioning',
  'deploying',
  'releasing',
  'rescue',
  'retiring',
] as const satisfies readonly ProvisionState[];
export type ProvisionFailableState = (typeof provisionFailableStates)[number];

/**
 * Where `recover` takes a node that failed in each state: back to the last stable point, and never
 * straight to `ready`, which is reachable only through commissioning or a release whose wipe
 * succeeded. A failed deploy therefore recovers into `releasing`, which wipes before `ready`.
 */
export const metalRecoverTargets: Readonly<Record<ProvisionFailableState, ProvisionState>> = {
  enrolling: 'enrolling',
  inspecting: 'enrolling',
  commissioning: 'enrolling',
  deploying: 'releasing',
  releasing: 'releasing',
  rescue: 'deployed',
  retiring: 'retiring',
};

export const provisionStateTable = defineStateTable<ProvisionState, ProvisionVerb>({
  name: 'provision',
  states: provisionStates,
  verbs: provisionVerbs,
  initial: ['adopting', 'enrolling'],
  terminal: ['retired'],
  transitions: {
    adopting: { complete: 'adopted', adopt: 'adopting', retire: 'retiring' },
    adopted: { adopt: 'adopting', release: 'releasing', retire: 'retiring' },
    enrolling: { complete: 'inspecting', fail: 'failed', abort: 'failed', retire: 'retiring' },
    inspecting: { complete: 'commissioning', fail: 'failed', abort: 'failed' },
    commissioning: { complete: 'ready', fail: 'failed', abort: 'failed' },
    ready: {
      deploy: 'deploying',
      manage: 'enrolling',
      inspect: 'inspecting',
      provide: 'commissioning',
      retire: 'retiring',
    },
    deploying: { complete: 'deployed', fail: 'failed', abort: 'failed' },
    deployed: { release: 'releasing', rescue: 'rescue' },
    releasing: { complete: 'ready', fail: 'failed', abort: 'failed' },
    rescue: { unrescue: 'deployed', release: 'releasing', fail: 'failed' },
    failed: {
      recover: ['enrolling', 'releasing', 'deployed', 'retiring'],
      retire: 'retiring',
    },
    retiring: { complete: 'retired', fail: 'failed' },
    retired: {},
  },
});

/** The `recover` target for a node that failed in `failedFrom`. */
export function recoverTarget(failedFrom: ProvisionFailableState): ProvisionState {
  return metalRecoverTargets[failedFrom];
}

/** Provision states a node may be scheduled in (§10.2). */
export const schedulableProvisionStates = [
  'adopted',
  'deployed',
] as const satisfies readonly ProvisionState[];

// ---------------------------------------------------------------------------------------------
// Connectivity (§7.5): transitions only; P6 — disconnected is not dead, nothing is released.
// ---------------------------------------------------------------------------------------------

export const connectivityStates = ['connected', 'disconnected', 'unreachable', 'lost'] as const;
export type Connectivity = (typeof connectivityStates)[number];
/**
 * `connect` is a `Hello` (a second session supersedes the first); `disconnect` is a closed session
 * or an expired gateway lease; `timeout` is 40 s + grace without a session; `lose` is the pool's
 * `lostAfter`, never applied automatically to metal.
 */
export const connectivityVerbs = ['connect', 'disconnect', 'timeout', 'lose'] as const;
export type ConnectivityVerb = (typeof connectivityVerbs)[number];

export const connectivityTable = defineStateTable<Connectivity, ConnectivityVerb>({
  name: 'connectivity',
  states: connectivityStates,
  verbs: connectivityVerbs,
  initial: ['disconnected'],
  terminal: [],
  transitions: {
    connected: { connect: 'connected', disconnect: 'disconnected' },
    disconnected: { connect: 'connected', timeout: 'unreachable' },
    unreachable: { connect: 'connected', lose: 'lost' },
    lost: { connect: 'connected' },
  },
});

// ---------------------------------------------------------------------------------------------
// Reservations (§10.5)
// ---------------------------------------------------------------------------------------------

export const reservationStates = [
  'draft',
  'denied',
  'awaiting-confirmation',
  'pending',
  'placed',
  'binding',
  'active',
  'releasing',
  'released',
  'failed',
  'cancelled',
  'expired',
] as const;
export type ReservationState = (typeof reservationStates)[number];

/**
 * - `place`: admitted and placed (from a draft, or a pending retry); `defer`: to `pending` with
 *   `Unschedulable` (conflict ×3, bind timeout, or a placed booking that needs repair).
 * - `deny`: the IAM decision denied; `awaitConfirmation`: a delegated deny that became a
 *   confirmation request (v0.3); `retry`: the same key came back, so the draft is re-decided.
 * - `start`: `starts_at` reached; `bind`: the node reported `AllocationBound`.
 * - `release`: `ends_at`, `reservations.release` or a lapsed lease; `complete`: the release finished.
 * - `extend` and `renew` keep the state (they are admissions that change `during` or the lease).
 * - `fail`: quota exceeded, `maxPending` reached or bind retries exhausted.
 */
export const reservationVerbs = [
  'place',
  'defer',
  'deny',
  'awaitConfirmation',
  'retry',
  'expire',
  'start',
  'bind',
  'extend',
  'renew',
  'release',
  'complete',
  'cancel',
  'fail',
] as const;
export type ReservationVerb = (typeof reservationVerbs)[number];

export const reservationStateTable = defineStateTable<ReservationState, ReservationVerb>({
  name: 'reservation',
  states: reservationStates,
  verbs: reservationVerbs,
  initial: ['draft'],
  terminal: ['denied', 'released', 'failed', 'cancelled', 'expired'],
  transitions: {
    draft: {
      place: 'placed',
      defer: 'pending',
      deny: 'denied',
      awaitConfirmation: 'awaiting-confirmation',
      fail: 'failed',
    },
    denied: {},
    'awaiting-confirmation': { retry: 'draft', expire: 'expired', cancel: 'cancelled' },
    pending: { place: 'placed', fail: 'failed', cancel: 'cancelled' },
    placed: {
      start: 'binding',
      defer: 'pending',
      extend: 'placed',
      renew: 'placed',
      release: 'releasing',
      cancel: 'cancelled',
    },
    binding: {
      bind: 'active',
      defer: 'pending',
      extend: 'binding',
      renew: 'binding',
      release: 'releasing',
      fail: 'failed',
    },
    active: { extend: 'active', renew: 'active', release: 'releasing' },
    releasing: { complete: 'released' },
    released: {},
    failed: {},
    cancelled: {},
    expired: {},
  },
});

/** Reservation states that still count against quota (D9: conservative, all non-terminal). */
export const reservationQuotaStates = [
  'pending',
  'placed',
  'binding',
  'active',
  'releasing',
] as const satisfies readonly ReservationState[];

// ---------------------------------------------------------------------------------------------
// Commands (§7.4)
// ---------------------------------------------------------------------------------------------

export const commandStates = [
  'pending',
  'dispatched',
  'acked',
  'running',
  'succeeded',
  'failed',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type CommandState = (typeof commandStates)[number];

/**
 * - `dispatch`: sent under a session epoch (again on resume); `busy`: no credits, back to `pending`.
 * - `ack`, `start`, `succeed`, `fail` follow daemon reports, which may skip steps (a lost ack
 *   still lets the result land). The sweeper's timeout and the journal-lost rule are `fail`;
 *   self-terminating completion on rejoin is `succeed`.
 * - `reject`: `UNSUPPORTED`, `BAD_SIGNATURE`, `EXPIRED` or `STALE_GENERATION` before acceptance.
 * - `expire`: `pending` past `not_after`; `cancel`: server-side before dispatch, daemon-reported after.
 */
export const commandVerbs = [
  'dispatch',
  'busy',
  'ack',
  'start',
  'succeed',
  'fail',
  'reject',
  'expire',
  'cancel',
] as const;
export type CommandVerb = (typeof commandVerbs)[number];

export const commandStateTable = defineStateTable<CommandState, CommandVerb>({
  name: 'command',
  states: commandStates,
  verbs: commandVerbs,
  initial: ['pending'],
  terminal: ['succeeded', 'failed', 'rejected', 'expired', 'cancelled'],
  transitions: {
    pending: { dispatch: 'dispatched', expire: 'expired', cancel: 'cancelled' },
    dispatched: {
      dispatch: 'dispatched',
      busy: 'pending',
      ack: 'acked',
      start: 'running',
      succeed: 'succeeded',
      fail: 'failed',
      reject: 'rejected',
      cancel: 'cancelled',
    },
    acked: { start: 'running', succeed: 'succeeded', fail: 'failed', cancel: 'cancelled' },
    running: { succeed: 'succeeded', fail: 'failed', cancel: 'cancelled' },
    succeeded: {},
    failed: {},
    rejected: {},
    expired: {},
    cancelled: {},
  },
});

/** Terminal command states, as a set for hot-path checks. */
export const commandTerminalStates: ReadonlySet<CommandState> = new Set(commandStateTable.terminal);
/** Non-terminal states that are in flight on a node (the journal-lost rule applies to these). */
export const commandInFlightStates = [
  'dispatched',
  'acked',
  'running',
] as const satisfies readonly CommandState[];

// ---------------------------------------------------------------------------------------------
// VPS instances (§11.1): `state` converges toward `desiredState`.
// ---------------------------------------------------------------------------------------------

export const instanceStates = [
  'pending',
  'scheduling',
  'provisioning',
  'starting',
  'running',
  'stopped',
  'rebooting',
  'resizing',
  'deleting',
  'deleted',
  'error',
  'lost',
] as const;
export type InstanceState = (typeof instanceStates)[number];
export type InstanceDesiredState = 'running' | 'stopped' | 'deleted';

/**
 * `complete` finishes the current phase (scheduled, provisioned, started, rebooted, resized, deleted);
 * a finished resize names `running` or `stopped`. `lose` follows the host's loss; `recover` is the
 * host reporting the instance again, and `recreate` places it anew per pool policy.
 */
export const instanceVerbs = [
  'schedule',
  'complete',
  'start',
  'stop',
  'reboot',
  'resize',
  'delete',
  'fail',
  'lose',
  'recover',
  'recreate',
] as const;
export type InstanceVerb = (typeof instanceVerbs)[number];

export const instanceStateTable = defineStateTable<InstanceState, InstanceVerb>({
  name: 'instance',
  states: instanceStates,
  verbs: instanceVerbs,
  initial: ['pending'],
  terminal: ['deleted'],
  transitions: {
    pending: { schedule: 'scheduling', fail: 'error', delete: 'deleting' },
    scheduling: { complete: 'provisioning', fail: 'error', delete: 'deleting' },
    provisioning: { complete: 'starting', fail: 'error', delete: 'deleting', lose: 'lost' },
    starting: { complete: 'running', fail: 'error', delete: 'deleting', lose: 'lost' },
    running: {
      stop: 'stopped',
      reboot: 'rebooting',
      resize: 'resizing',
      fail: 'error',
      delete: 'deleting',
      lose: 'lost',
    },
    stopped: {
      start: 'starting',
      resize: 'resizing',
      fail: 'error',
      delete: 'deleting',
      lose: 'lost',
    },
    rebooting: { complete: 'running', fail: 'error', delete: 'deleting', lose: 'lost' },
    resizing: {
      complete: ['running', 'stopped'],
      fail: 'error',
      delete: 'deleting',
      lose: 'lost',
    },
    deleting: { complete: 'deleted', fail: 'error' },
    deleted: {},
    error: { start: 'starting', delete: 'deleting', lose: 'lost' },
    lost: { recover: ['running', 'stopped'], recreate: 'scheduling', delete: 'deleting' },
  },
});

// ---------------------------------------------------------------------------------------------
// Workflows and steps (§11.2)
// ---------------------------------------------------------------------------------------------

export const workflowStates = [
  'pending',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type WorkflowState = (typeof workflowStates)[number];
/** `retry` resumes a failed workflow from a step (`workflows.retry`); `cancel` is `workflows.abort`. */
export const workflowVerbs = [
  'start',
  'pause',
  'resume',
  'complete',
  'fail',
  'retry',
  'cancel',
] as const;
export type WorkflowVerb = (typeof workflowVerbs)[number];

export const workflowStateTable = defineStateTable<WorkflowState, WorkflowVerb>({
  name: 'workflow',
  states: workflowStates,
  verbs: workflowVerbs,
  initial: ['pending'],
  terminal: ['succeeded', 'cancelled'],
  transitions: {
    pending: { start: 'running', cancel: 'cancelled' },
    running: { pause: 'paused', complete: 'succeeded', fail: 'failed', cancel: 'cancelled' },
    paused: { resume: 'running', cancel: 'cancelled' },
    succeeded: {},
    failed: { retry: 'running', cancel: 'cancelled' },
    cancelled: {},
  },
});

export const stepStates = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type StepState = (typeof stepStates)[number];
/**
 * `wait` parks a step on its command or on `await: 'rejoin'`; `complete` and `fail` settle it;
 * `retry` re-queues a failed step with `attempt + 1` while retries remain; `skip` is a false
 * `when` (or `onFailure: continue` on a step that never ran).
 */
export const stepVerbs = ['start', 'wait', 'complete', 'fail', 'retry', 'skip', 'cancel'] as const;
export type StepVerb = (typeof stepVerbs)[number];

export const stepStateTable = defineStateTable<StepState, StepVerb>({
  name: 'step',
  states: stepStates,
  verbs: stepVerbs,
  initial: ['pending'],
  terminal: ['succeeded', 'skipped', 'cancelled'],
  transitions: {
    pending: { start: 'running', skip: 'skipped', cancel: 'cancelled' },
    running: { wait: 'waiting', complete: 'succeeded', fail: 'failed', cancel: 'cancelled' },
    waiting: { complete: 'succeeded', fail: 'failed', cancel: 'cancelled' },
    succeeded: {},
    failed: { retry: 'pending' },
    skipped: {},
    cancelled: {},
  },
});

/** Every table, for exhaustive tests and documentation. */
export const stateTables = {
  provision: provisionStateTable,
  connectivity: connectivityTable,
  reservation: reservationStateTable,
  command: commandStateTable,
  instance: instanceStateTable,
  workflow: workflowStateTable,
  step: stepStateTable,
} as const;
