import {
  ComputeError,
  type AdmissionContext,
  type AdmissionPlan,
  type Caller,
  type Clock,
  type Credential,
  type Decision,
  type IamPort,
  type MethodAdmission,
  type MethodContext,
  type MethodResource,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { runsOutsideTransaction } from './list.js';
import type { RegisteredMethod } from './registry.js';

// Composite methods (PLAN.md §3.4, `fleet.apply`). A mutation declared `transaction: 'manual'` runs
// with no transaction open and composes other methods in two phases:
// 1. `ctx.check(path, input)`, with no transaction open (IAM is never awaited inside one): the
//    target's tenant pre-check for the same caller, its validation and its one decision, exactly as
//    the envelope would make them. Replay-only admissions (no `denied` hook) run `prepare` in a short
//    transaction of their own first; admissions with a `denied` hook, list-recipe reads and other
//    composites are `UNSUPPORTED`. An allowed call leaves a grant keyed by path + canonical JSON of
//    the raw input; grants are a multiset (one `invoke` per `check`) and live only for this call.
// 2. `ctx.invoke(tx, path, input)`, inside the composite's transaction: consumes one grant (else
//    `ACCESS_DENIED`), validates, re-runs `prepare` in the transaction for admission methods (a replay
//    returns the stored result), runs the handler with the recorded decision as `ctx.admission`, and
//    appends the sub-call's `audit_events` row, all under a savepoint, so a failed sub-call leaves
//    nothing behind. `invoke` never calls IAM.

/** The envelope steps a composite call reuses, exactly as `Operations.call` runs them. */
export interface CompositeEnvelope {
  /** The resource a method decides on, checked against its §9.2 row (`INVALID_CONFIG`). */
  resourceOf(entry: RegisteredMethod, resource: unknown): MethodResource;
  /** The tenant the (validated) input names, if any. */
  tenantOf(input: unknown): string | undefined;
  /** The tenant a decision is made in: the root tenant for fleet-wide resources. */
  decisionTenant(resource: MethodResource | undefined, inputTenant?: string): string | undefined;
  /** The decision on a resource, with the IAM type prefix. */
  decisionOf(tenantId: string, action: string, resource: MethodResource): Decision;
  /** §3.4 step 3: `ACCESS_DENIED` for a caller outside the tenants (root callers pass). */
  preCheck(caller: Caller, ...tenants: (string | undefined)[]): void;
  /** The admission context an allowed mutation records. */
  admissionOf(
    caller: Caller,
    decision: Decision,
    requestId: string,
    decidedAt: number,
  ): AdmissionContext;
  /** A read decision, through the read-decision cache. */
  authorize(caller: Caller, credential: Credential, decision: Decision): Promise<boolean>;
  /** Whether IAM refused the decision (as opposed to failing to make one). */
  refused(error: unknown): boolean;
  /** §3.4 step 7 for a refused admission: `CONFIRMATION_REQUIRED` or the refusal itself. */
  refusal(
    entry: RegisteredMethod,
    admission: MethodAdmission<unknown, unknown>,
    input: unknown,
    caller: Caller,
    credential: Credential,
    decision: Decision,
    error: unknown,
    requestId: string,
  ): Promise<unknown>;
  /** The executor handlers see inside `tx`. */
  within(tx: SqlTx): SqlExecutor;
  /** Records an allowed mutation (`audit_events`) in `tx`. */
  recordAudit(tx: SqlTx, admission: AdmissionContext): Promise<void>;
}

export interface CompositeOptions {
  /** The store with after-commit hooks: `invoke`'s savepoint opens through it. */
  database: SqlExecutor;
  iam: IamPort;
  clock: Clock;
  /** Whether the calling code runs inside a transaction of `database` (the executor tracks it). */
  inTransaction(): boolean;
  /** The registry's method lookup; without one every `check` is `UNSUPPORTED`. */
  method?(path: string): RegisteredMethod | undefined;
  envelope: CompositeEnvelope;
}

/** One run of a composite method, as `Operations.call` starts it. */
export interface CompositeRun {
  /** The composite method itself. */
  entry: RegisteredMethod;
  /** The composite's caller: every sub-call is checked and invoked as this identity. */
  caller: Caller;
  credential: Credential;
  requestId: string;
  /**
   * A sub-call's context: the composite's base with `sql`, and for callers' methods the caller,
   * the credential and `admission`; public methods get the credential only.
   */
  contextFor(
    sql: SqlExecutor,
    admission: AdmissionContext | undefined,
    kind: 'caller' | 'public',
  ): MethodContext;
}

/** The `check`/`invoke` pair of one composite method call. */
export interface CompositeCall {
  check(path: string, input: unknown): Promise<void>;
  invoke(tx: SqlTx, path: string, input: unknown): Promise<unknown>;
  /** Ends the call: every grant is forgotten; a later `check` is `INVALID_STATE`, an `invoke` `ACCESS_DENIED`. */
  end(): void;
}

export interface Composites {
  begin(run: CompositeRun): CompositeCall;
}

/** One call `check` allowed. */
interface Grant {
  entry: RegisteredMethod;
  /** The tenant the call was pre-checked in (the input's, or root for fleet resources). */
  tenantId?: string;
  /** The decision `check` made; absent for public methods and for admission replays. */
  decision?: Decision;
  decidedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const accessDenied = () => new ComputeError('ACCESS_DENIED', 'Access denied');

const notJson = (why: string) =>
  new ComputeError('INVALID_INPUT', `A composite call's input must be JSON (${why})`);

/**
 * Canonical JSON: object keys sorted recursively, `undefined` members dropped (in arrays they read
 * as `null`, as `JSON.stringify` writes them), `toJSON` honoured. Two inputs with the same meaning
 * as JSON give the same string whatever their key order.
 */
export function canonicalJson(value: unknown): string {
  const path = new Set<object>();
  const walk = (current: unknown): string | undefined => {
    if (
      typeof current === 'object' &&
      current !== null &&
      typeof (current as { toJSON?: unknown }).toJSON === 'function'
    )
      current = (current as { toJSON(): unknown }).toJSON();
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol')
      return undefined;
    if (typeof current === 'bigint') throw notJson('a bigint');
    if (current === null || typeof current !== 'object') return JSON.stringify(current);
    if (path.has(current)) throw notJson('it is circular');
    path.add(current);
    try {
      if (Array.isArray(current))
        return `[${current.map((item) => walk(item) ?? 'null').join(',')}]`;
      const record = current as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = walk(record[key]);
        if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
      }
      return `{${members.join(',')}}`;
    } finally {
      path.delete(current);
    }
  };
  return walk(value) ?? 'null';
}

/** What `admission.prepare` returned, or `INVALID_CONFIG` when it is not a plan. */
export function checkPlan(path: string, plan: unknown): AdmissionPlan<unknown> {
  if (!isRecord(plan) || (plan.status !== 'replay' && plan.status !== 'decide'))
    throw new ComputeError('INVALID_CONFIG', `${path}: admission.prepare returned no plan`);
  return plan as AdmissionPlan<unknown>;
}

const notComposite = () =>
  Promise.reject(
    new ComputeError(
      'INVALID_STATE',
      "check() and invoke() are available only to methods declared transaction: 'manual'",
    ),
  );

/** `check`/`invoke` of every method context that is not a composite's own: they refuse. */
export const outsideComposite: Required<Pick<MethodContext, 'check' | 'invoke'>> = Object.freeze({
  check: notComposite,
  invoke: notComposite,
});

const sameDecision = (a: Decision, b: Decision) =>
  a.tenantId === b.tenantId &&
  a.action === b.action &&
  a.resource.type === b.resource.type &&
  a.resource.id === b.resource.id;

export function createComposites(options: CompositeOptions): Composites {
  const { database, iam, clock, envelope } = options;

  /** Why `check` cannot compose `entry`, if it cannot. */
  function unsupported(entry: RegisteredMethod): string | undefined {
    const { definition } = entry;
    if (definition.transaction === 'manual')
      return `${entry.path} is itself a composite method and cannot run inside another`;
    if (definition.kind === 'mutation' && definition.admission?.denied)
      return `${entry.path} keeps a record of refusals (admission.denied) and must be called on its own`;
    if (definition.kind === 'read' && (runsOutsideTransaction(definition) || entry.row?.list))
      return `${entry.path} follows the list recipe (per-item decisions), which cannot run inside a transaction`;
    return undefined;
  }

  return {
    begin(run) {
      const { caller, credential, requestId } = run;
      const grants = new Map<string, Grant[]>();
      let ended = false;
      const keyOf = (path: string, input: unknown) => `${path} ${canonicalJson(input)}`;
      const grant = (key: string, value: Grant) => {
        if (ended) return;
        const queue = grants.get(key);
        if (queue) queue.push(value);
        else grants.set(key, [value]);
      };

      async function check(path: string, raw: unknown): Promise<void> {
        if (ended)
          throw new ComputeError('INVALID_STATE', 'check() runs only during its method call');
        // Phase 1 decides; IAM is never awaited inside a compute transaction.
        if (options.inTransaction())
          throw new ComputeError(
            'INVALID_STATE',
            'check() cannot run inside a transaction: check every call first, then invoke them in one transaction',
          );
        if (typeof path !== 'string')
          throw new ComputeError('INVALID_INPUT', 'check() takes a method path');
        const key = keyOf(path, raw);
        if (!options.method)
          throw new ComputeError(
            'UNSUPPORTED',
            'This host resolves no methods for composite calls',
          );
        const entry = options.method(path);
        if (!entry) throw new ComputeError('NOT_FOUND', `No method ${path}`);
        const reason = unsupported(entry);
        if (reason) throw new ComputeError('UNSUPPORTED', reason);

        const { definition } = entry;
        const input = definition.validate(raw ?? {});
        if (definition.kind === 'public') {
          grant(key, { entry, decidedAt: clock.now() });
          return;
        }

        const mutation = definition.kind === 'mutation';
        const admission = mutation ? definition.admission : undefined;
        const declared = definition.resource(input);
        const resource =
          admission && declared === undefined ? undefined : envelope.resourceOf(entry, declared);
        const inputTenant = envelope.tenantOf(input);
        const tenantId = envelope.decisionTenant(resource, inputTenant);
        if (tenantId === undefined)
          throw new ComputeError('INVALID_CONFIG', `${path} names no tenant to decide in`);
        envelope.preCheck(caller, tenantId, inputTenant);

        if (admission) {
          // A replay-only admission: its own short transaction, then one decision (or a replay).
          const plan = checkPlan(
            path,
            await database.transaction((tx) =>
              admission.prepare(
                run.contextFor(envelope.within(tx), undefined, 'caller'),
                input,
                tx,
              ),
            ),
          );
          if (plan.status === 'replay') {
            grant(key, { entry, tenantId, decidedAt: clock.now() });
            return;
          }
          const decided = envelope.resourceOf(entry, plan.resource);
          const tenant = envelope.decisionTenant(decided, tenantId)!;
          envelope.preCheck(caller, tenant);
          const decision = envelope.decisionOf(tenant, entry.action!, decided);
          try {
            await iam.refreshResource?.(decision.tenantId, decision.resource);
            await iam.require(credential, decision);
          } catch (error) {
            if (!envelope.refused(error)) throw error;
            throw await envelope.refusal(
              entry,
              admission as MethodAdmission<unknown, unknown>,
              input,
              caller,
              credential,
              decision,
              error,
              requestId,
            );
          }
          grant(key, { entry, tenantId, decision, decidedAt: clock.now() });
          return;
        }

        const decision = envelope.decisionOf(tenantId, entry.action!, resource!);
        if (mutation) await iam.require(credential, decision);
        else if (!(await envelope.authorize(caller, credential, decision))) throw accessDenied();
        grant(key, { entry, tenantId, decision, decidedAt: clock.now() });
      }

      async function invoke(tx: SqlTx, path: string, raw: unknown): Promise<unknown> {
        if (!ended && !options.inTransaction())
          throw new ComputeError(
            'INVALID_STATE',
            'invoke() runs inside the transaction it is given (ctx.sql.transaction)',
          );
        if (typeof tx !== 'object' || tx === null || typeof tx.query !== 'function')
          throw new ComputeError('INVALID_INPUT', 'invoke() takes the open transaction');
        const key = typeof path === 'string' ? keyOf(path, raw) : undefined;
        const queue = key === undefined ? undefined : grants.get(key);
        const granted = queue?.shift();
        if (!granted) throw accessDenied();
        if (!queue!.length) grants.delete(key!);

        const { entry } = granted;
        const { definition } = entry;
        const input = definition.validate(raw ?? {});
        // A savepoint of the composite's transaction: a failed sub-call leaves nothing behind.
        return database.transaction(async (savepoint) => {
          const sql = envelope.within(savepoint);
          if (definition.kind === 'public')
            return definition.handler(run.contextFor(sql, undefined, 'public'), input);
          if (definition.kind !== 'mutation')
            return definition.handler(run.contextFor(sql, undefined, 'caller'), input);

          const admission = definition.admission;
          if (admission) {
            const plan = checkPlan(
              path,
              await admission.prepare(run.contextFor(sql, undefined, 'caller'), input, savepoint),
            );
            if (plan.status === 'replay') return plan.result;
            // The decision `check` made must cover what prepare decides on now.
            const decided = envelope.resourceOf(entry, plan.resource);
            const tenant = envelope.decisionTenant(decided, granted.tenantId)!;
            const expected = envelope.decisionOf(tenant, entry.action!, decided);
            if (!granted.decision || !sameDecision(granted.decision, expected))
              throw accessDenied();
          }
          const admitted = envelope.admissionOf(
            caller,
            granted.decision!,
            requestId,
            granted.decidedAt,
          );
          const value = await definition.handler(run.contextFor(sql, admitted, 'caller'), input);
          await envelope.recordAudit(savepoint, admitted);
          return value;
        });
      }

      return {
        check,
        invoke,
        end() {
          ended = true;
          grants.clear();
        },
      };
    },
  };
}
