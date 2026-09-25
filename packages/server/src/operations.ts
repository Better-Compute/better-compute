import {
  ComputeError,
  apiMethod,
  isComputeError,
  newId,
  type AdmissionContext,
  type AdmissionPlan,
  type Caller,
  type CommandQueue,
  type Credential,
  type Decision,
  type MethodAdmission,
  type MethodContext,
  type MethodResource,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { cachesFor, publicCaches, type ComputeCaches } from './caches.js';
import { bindConfirmation, matchesBinding } from './confirmation-bindings.js';
import { checkPlan, createComposites, outsideComposite, type CompositeCall } from './composite.js';
import { createListRecipe, readOnlyExecutor, runsOutsideTransaction } from './list.js';
import { noTenantGate, type TenantGate } from './tenancy/tenancy.js';
import type { ResolvedOptions } from './options.js';
import {
  actionPattern,
  rowResourceKinds,
  type RegisteredMethod,
  type Registry,
} from './registry.js';

/** The command queue a traced request's method sees: its commands carry the request's trace. */
function tracedCommands(commands: CommandQueue, traceparent: string): CommandQueue {
  return {
    enqueue: (tx, command) =>
      commands.enqueue(tx, command.traceparent ? command : { ...command, traceparent }),
    cancel: (tx, commandId) => commands.cancel(tx, commandId),
    ...(commands.createBatch ? { createBatch: commands.createBatch.bind(commands) } : {}),
  };
}

/** Per-call details the transport supplies. */
export interface CallOptions {
  /** The caller's valid `X-Request-Id`, or one the server generated. */
  requestId: string;
  /** The request's valid W3C `traceparent`, passed on to the commands the method enqueues. */
  traceparent?: string;
  signal?: AbortSignal;
}

export interface Operations {
  /**
   * Runs one method through the envelope (PLAN.md §3.4):
   * 1. public methods: validate and run, with the credential only when one was presented;
   * 2. otherwise: refuse a call without a credential (`UNAUTHENTICATED`, no IAM call), validate the
   *    input, authenticate (`IamPort.authenticate`, cached 30 s by sha256 of the credential);
   * 3. the tenant pre-check: a caller outside the input's tenant (and, for fleet-wide resources, the
   *    root tenant) and outside the root tenant gets `ACCESS_DENIED` before any read or write of
   *    compute's database or any IAM decision;
   * 4. methods with `admission` (request-as-resource creates, `extend`/`renew`): transaction 1 runs
   *    `prepare` (idempotency lookup, draft and projection rows). A replay returns the stored result
   *    without a decision; otherwise the one decision is `require` on the resource `prepare`
   *    returned. A refusal of a delegated session asks IAM for a confirmation (§3.4 step 7):
   *    `CONFIRMATION_REQUIRED` with its id when the delegation holds the action back, else the
   *    `ACCESS_DENIED` (fail closed). Either way `denied` runs in its own transaction with that
   *    error, and the error is rethrown;
   * 5. every other method: one decision on `resource(input)`, `require` for mutations (never
   *    cached) and `authorize` for reads (allows cached 10 s per session);
   * 6. the handler in one transaction (read-only for reads); allowed mutations also write an
   *    `audit_events` row with the admission context in that transaction. List methods
   *    (`defineListMethod`) run without a wrapping transaction and read through a read-only
   *    executor, so their per-item IAM checks never wait inside a compute transaction. Other
   *    methods of a §9.2 "+ items" row (a module's `pools.list`) run in a read-only transaction
   *    and the envelope decides the page's items after it (the list recipe, §9.2): owner-scoped
   *    kinds listing the caller's own (`scope` absent or `mine`) keep the SQL owner filter alone;
   * 7. composite mutations (`transaction: 'manual'`, e.g. `fleet.apply`): after their own decision
   *    the handler runs with no transaction open, with `ctx.check` (phase 1: each sub-call decided
   *    for the same caller, outside any transaction) and `ctx.invoke` (phase 2: checked sub-calls
   *    run in the handler's transaction, each with its own audit row); the composite's audit row
   *    is written in a transaction of its own after the handler succeeds.
   */
  call(
    method: RegisteredMethod,
    credential: Credential | undefined,
    input: unknown,
    options: CallOptions,
  ): Promise<unknown>;
  /** Invalidation of the authentication and read-decision caches (`compute.caches`). */
  readonly caches: ComputeCaches;
}

/** The one refusal for "outside your tenant" and "IAM said no", so neither reveals anything. */
const accessDenied = () => new ComputeError('ACCESS_DENIED', 'Access denied');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The credential as compute passes it to IAM: the IAM cookie dropped unless `acceptIamCookie`.
 * `undefined` when nothing that could authenticate remains.
 */
export function presentedCredential(
  credential: Credential | undefined,
  acceptIamCookie: boolean,
): Credential | undefined {
  if (!credential || typeof credential !== 'object') return undefined;
  const token =
    typeof credential.token === 'string' && credential.token ? credential.token : undefined;
  let headers: Headers | undefined;
  if (credential.headers !== undefined) {
    headers = new Headers(credential.headers);
    if (!acceptIamCookie) headers.delete('cookie');
  }
  const present =
    token !== undefined ||
    headers?.has('authorization') === true ||
    headers?.has('cookie') === true;
  if (!present) return undefined;
  const sourceIp =
    typeof credential.sourceIp === 'string' && credential.sourceIp ? credential.sourceIp : undefined;
  return {
    ...(headers ? { headers } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(sourceIp ? { sourceIp } : {}),
  };
}

/** The executor handlers see inside the envelope's transaction: statements run on `tx`. */
function withinTransaction(database: SqlExecutor, tx: SqlTx): SqlExecutor {
  const refuse = (what: string) => () =>
    Promise.reject(new ComputeError('INVALID_STATE', `${what} cannot run inside a method`));
  return {
    dialect: database.dialect,
    kind: database.kind,
    query: (text, params) => tx.query(text, params),
    // Nested transactions become savepoints of the method's transaction (the executors' contract).
    transaction: (fn, options) => database.transaction(fn, options),
    migrate: refuse('migrate()'),
    close: refuse('close()'),
  };
}

/**
 * The executor a composite handler sees (`transaction: 'manual'`): no transaction is open; each
 * statement runs on its own and each `transaction` is a real one (IAM-free, like any other).
 */
function outsideTransaction(database: SqlExecutor): SqlExecutor {
  const refuse = (what: string) => () =>
    Promise.reject(new ComputeError('INVALID_STATE', `${what} cannot run inside a method`));
  return {
    dialect: database.dialect,
    kind: database.kind,
    query: (text, params) => database.query(text, params),
    transaction: (fn, options) => database.transaction(fn, options),
    migrate: refuse('migrate()'),
    close: refuse('close()'),
  };
}

/** Records an allowed mutation with its admission context (`audit_events`, base schema). */
async function recordAudit(tx: SqlTx, admission: AdmissionContext): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, admission)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      newId('aud'),
      admission.tenantId,
      admission.action,
      admission.resource.type,
      admission.resource.id,
      JSON.stringify(admission),
    ],
  );
}

function tenantOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !Object.hasOwn(input, 'tenantId'))
    return undefined;
  const tenantId = (input as { tenantId: unknown }).tenantId;
  return typeof tenantId === 'string' && tenantId ? tenantId : undefined;
}

function admissionOf(
  caller: Caller,
  decision: Decision,
  requestId: string,
  decidedAt: number,
): AdmissionContext {
  const admission: AdmissionContext = {
    tenantId: decision.tenantId,
    identityId: caller.identityId,
    identityKind: caller.identityKind,
    sessionId: caller.sessionId,
    sessionKind: caller.sessionKind,
    requestId,
    action: decision.action,
    resource: { ...decision.resource },
    decidedAt,
  };
  if (caller.agentId !== undefined) admission.agentId = caller.agentId;
  if (caller.delegationId !== undefined) admission.delegationId = caller.delegationId;
  return admission;
}

/**
 * The resource a method decides on, checked against its §9.2 row: the pair `(action, type)`, with
 * `action` the resource's own (an alternative's action) or the method's, must be the row's or one
 * of its alternatives. A method without a row may not override its action.
 */
function checkResource(entry: RegisteredMethod, resource: unknown): MethodResource {
  if (!isRecord(resource) || typeof resource.type !== 'string' || typeof resource.id !== 'string')
    throw new ComputeError('INVALID_CONFIG', `${entry.path} names no resource to decide on`);
  const { type, id } = resource;
  const override = resource.action;
  if (override !== undefined && (typeof override !== 'string' || !actionPattern.test(override)))
    throw new ComputeError('INVALID_CONFIG', `${entry.path} names an invalid action to decide`);
  const action = (override as `compute:${string}` | undefined) ?? entry.action;
  const row = entry.row;
  if (row) {
    if (!(rowResourceKinds(row) as string[]).includes(type))
      throw new ComputeError(
        'INVALID_CONFIG',
        `${entry.path} decides on ${type}, not its §9.2 resource`,
      );
    const listed =
      (row.action === action && row.resource === type) ||
      (row.alternatives ?? []).some((pair) => pair.action === action && pair.resource === type);
    if (!listed)
      throw new ComputeError(
        'INVALID_CONFIG',
        `${entry.path} decides ${action} on ${type}, a pair its §9.2 row does not list`,
      );
  } else if (override !== undefined && override !== entry.action)
    throw new ComputeError(
      'INVALID_CONFIG',
      `${entry.path} has no §9.2 row to decide ${override} by`,
    );
  return override === undefined || override === entry.action
    ? { type, id }
    : { type, id, action: override as `compute:${string}` };
}

/** Whether IAM refused the decision (as opposed to failing to make one). */
const refused = (error: unknown) =>
  isComputeError(error, 'ACCESS_DENIED') ||
  (isRecord(error) && (error as { code?: unknown }).code === 'ACCESS_DENIED');

/** Kinds listed by owner (§9.2 list recipe step 3): `scope: 'mine'` needs no per-item checks. */
const ownerScopedKinds: ReadonlySet<string> = new Set([
  'reservation',
  'instance',
  'sandbox',
  'sandbox-snapshot',
]);

/**
 * The item kind of a §9.2 "+ items" list row: the resource its group's `get` decides on
 * (`pools.list` → `pool`, `providerAccounts.list` → `provider-account`).
 */
function listItemKind(entry: RegisteredMethod): string | undefined {
  if (!entry.row?.list) return undefined;
  return apiMethod(entry.group, 'get')?.resource ?? undefined;
}

/**
 * The envelope. `registry` resolves the targets of composite methods' `ctx.check`; without it
 * (unit harnesses) every `check` is `UNSUPPORTED`.
 */
export function createOperations(
  options: ResolvedOptions,
  context: ModuleContext,
  registry?: Pick<Registry, 'method'>,
  gate?: TenantGate,
): Operations {
  const { database, iam, rootTenantId, typePrefix, acceptIamCookie, clock, log } = options;
  const caches = cachesFor(options, { now: () => clock.now() });
  const lists = createListRecipe({ typePrefix, caches });
  // §12.8: suspended tenants change nothing, deleted ones reach nothing. betterCompute() passes the deployment's
  // gate (loaded at start, or on the first call of a process that never started); unit harnesses without one
  // refuse nothing.
  const tenantGate = gate ?? noTenantGate;

  /**
   * §3.4 step 7 for a refused admission: a delegated session whose delegation holds the action back
   * gets `CONFIRMATION_REQUIRED` with the confirmation's id; everything else, including a failed
   * request, keeps the refusal (fail closed).
   */
  /** What a person asked to confirm reads: the admission's own description, else the decision. */
  const confirmationText = (
    entry: RegisteredMethod,
    admission: MethodAdmission<unknown, unknown>,
    input: unknown,
    decision: Decision,
  ): string => {
    const described = admission.describe?.(input);
    return typeof described === 'string' && described
      ? described
      : `${entry.group}.${entry.method}: ${decision.action} on ${decision.resource.type}/${decision.resource.id}`;
  };
  const boundDecision = (caller: Caller, decision: Decision) => ({
    tenantId: decision.tenantId,
    delegationId: caller.delegationId ?? '',
    action: decision.action,
    resource: decision.resource,
  });

  async function refusalOf(
    entry: RegisteredMethod,
    admission: MethodAdmission<unknown, unknown>,
    input: unknown,
    caller: Caller,
    credential: Credential,
    decision: Decision,
    error: unknown,
    requestId: string,
  ): Promise<unknown> {
    if (caller.sessionKind !== 'delegated') return error;
    try {
      const reason = confirmationText(entry, admission, input, decision);
      const answer = await iam.requestConfirmation(credential, { ...decision, reason });
      if (
        isRecord(answer) &&
        typeof answer.confirmationId === 'string' &&
        answer.confirmationId !== ''
      ) {
        // Review 14 M1: the approval admits this text only (see confirmation-bindings.ts).
        await bindConfirmation(
          database,
          answer.confirmationId,
          boundDecision(caller, decision),
          reason,
          typeof answer.expiresAt === 'number' ? answer.expiresAt : clock.now() + 15 * 60_000,
        );
        return new ComputeError(
          'CONFIRMATION_REQUIRED',
          'The person this agent acts for must confirm the request; retry with the same idempotencyKey once they have',
          undefined,
          {
            confirmationId: answer.confirmationId,
            ...(typeof answer.expiresAt === 'number' ? { expiresAt: answer.expiresAt } : {}),
            action: decision.action,
            resource: { ...decision.resource },
          },
        );
      }
    } catch (failure) {
      log.warn('Requesting a delegated confirmation failed; the request stays denied', {
        requestId,
        route: entry.path,
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
    return error;
  }

  /** Fleet-wide resources resolve only in the root tenant (§9.2 scope types). */
  const decisionTenant = (resource: MethodResource | undefined, inputTenant?: string) =>
    resource?.type === 'fleet' ? rootTenantId : inputTenant;
  /** `resource.action` is an alternative's action, already checked against §9.2 by checkResource. */
  const decisionOf = (tenantId: string, action: string, resource: MethodResource): Decision => ({
    tenantId,
    action: resource.action ?? action,
    resource: { type: `${typePrefix}${resource.type}`, id: resource.id },
  });
  /** §3.4 step 3; root callers go on to IAM, which decides ROOT_OVERRIDE and audits it. */
  const preCheck = (caller: Caller, ...tenants: (string | undefined)[]) => {
    for (const tenant of tenants)
      if (tenant !== undefined && caller.tenantId !== tenant && caller.tenantId !== rootTenantId)
        throw accessDenied();
  };

  async function admit(
    entry: RegisteredMethod,
    admission: MethodAdmission<unknown, unknown>,
    tenantId: string,
    input: unknown,
    caller: Caller,
    credential: Credential,
    requestId: string,
    contextFor: (sql: SqlExecutor, admission?: AdmissionContext) => MethodContext,
  ): Promise<unknown> {
    const { definition, path } = entry;
    // Transaction 1: idempotency lookup, draft and projection rows. Never an IAM call.
    const plan: AdmissionPlan<unknown> = checkPlan(
      path,
      await database.transaction((tx) =>
        admission.prepare(contextFor(withinTransaction(database, tx)), input, tx),
      ),
    );
    // The same request again from its owner: the stored result, and no second decision.
    if (plan.status === 'replay') return plan.result;
    // Transaction 1 committed what `prepare` staged: from here on, any failure other than the IAM
    // refusal (which runs `denied`) undoes it with `abandoned`: IAM unavailable, a check, the handler.
    let denied = false;
    try {
      return await decideAndRun(plan);
    } catch (error) {
      if (!denied && admission.abandoned) {
        try {
          await database.transaction((tx) =>
            admission.abandoned!(contextFor(withinTransaction(database, tx)), input, tx, error),
          );
        } catch (cleanup) {
          log.warn('An admission abandon hook failed', {
            requestId,
            route: path,
            error: cleanup instanceof Error ? cleanup.message : String(cleanup),
          });
        }
      }
      throw error;
    }

    async function decideAndRun(plan: AdmissionPlan<unknown> & { status: 'decide' }) {
      const resource = checkResource(entry, plan.resource);
      const tenant = decisionTenant(resource, tenantId)!;
      preCheck(caller, tenant);
      const decision = decisionOf(tenant, entry.action!, resource);
      try {
        // §12.4: IAM decides on the row transaction 1 committed, never a stale cached copy.
        await iam.refreshResource?.(decision.tenantId, decision.resource);
        await iam.require(credential, decision);
      } catch (error) {
        if (!refused(error)) throw error;
        denied = true;
        const refusal = await refusalOf(
          entry,
          admission,
          input,
          caller,
          credential,
          decision,
          error,
          requestId,
        );
        if (admission.denied) {
          try {
            await database.transaction((tx) =>
              admission.denied!(contextFor(withinTransaction(database, tx)), input, tx, refusal),
            );
          } catch (cleanup) {
            // The refusal is what the caller must see; a failed cleanup leaves a draft for GC.
            log.warn('An admission denial hook failed', {
              requestId,
              route: path,
              error: cleanup instanceof Error ? cleanup.message : String(cleanup),
            });
          }
        }
        throw refusal;
      }
      // Review 14 M1: an approval still open on this decision admits only the request it was given for.
      // A different one is refused (`abandoned` then clears what prepare staged).
      if (
        caller.sessionKind === 'delegated' &&
        !(await matchesBinding(
          database,
          boundDecision(caller, decision),
          confirmationText(entry, admission, input, decision),
        ))
      )
        throw new ComputeError(
          'ACCESS_DENIED',
          'The approval given for this resource was for a different request; ask again for this one',
          undefined,
          { reason: 'approval-mismatch' },
        );
      // Checks that may call IAM (budgets), outside any compute transaction; a refusal leaves the draft
      // as it is (no `denied`), so the same key can succeed later.
      if (admission.check)
        await admission.check(contextFor(outsideTransaction(database)), input, resource);
      const admitted = admissionOf(caller, decision, requestId, clock.now());
      // Transaction 2: the handler with the recorded decision, and its audit row. If it throws, it
      // rolled back with any cleanup of its own; `abandoned` runs in a third (above).
      return database.transaction(async (tx) => {
        const value = await definition.handler(
          contextFor(withinTransaction(database, tx), admitted),
          input,
        );
        await recordAudit(tx, admitted);
        return value;
      });
    }
  }

  /**
   * Async-with-wait (§9.1): a committed mutation whose method has `poll` and whose input asks
   * `wait: { timeoutMs }` is refreshed in read-only transactions until done, the timeout (≤ 30 s,
   * wall clock) or the request's abort. The last output is the answer either way.
   */
  async function waited(
    definition: RegisteredMethod['definition'],
    input: unknown,
    output: unknown,
    contextFor: (sql: SqlExecutor) => MethodContext,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const poll = definition.poll;
    const wait = isRecord(input) && isRecord(input.wait) ? input.wait.timeoutMs : undefined;
    const timeoutMs =
      typeof wait === 'number' && Number.isFinite(wait) ? Math.min(wait, 30_000) : 0;
    if (!poll || timeoutMs <= 0 || poll.done(output)) return output;
    const deadline = Date.now() + timeoutMs;
    let delay = 50;
    let current = output;
    while (!signal?.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
      if (signal?.aborted) break;
      current = await database.transaction(
        (tx) => poll.refresh(contextFor(withinTransaction(database, tx)), input, current),
        { readOnly: true },
      );
      if (poll.done(current)) break;
      delay = Math.min(delay * 2, 1000);
    }
    return current;
  }

  // Composite methods reuse the envelope's own steps for their sub-calls (./composite.ts).
  const composites = createComposites({
    database,
    iam,
    clock,
    inTransaction: () => options.inTransaction(),
    ...(registry ? { method: (path: string) => registry.method(path) } : {}),
    envelope: {
      resourceOf: checkResource,
      tenantOf,
      decisionTenant,
      decisionOf,
      preCheck,
      admissionOf,
      authorize: (caller, credential, decision) =>
        caches.authorize(caller, decision, () => iam.authorize(credential, decision)),
      refused,
      refusal: refusalOf,
      within: (tx) => withinTransaction(database, tx),
      recordAudit,
    },
  });

  return {
    caches: publicCaches(caches),
    async call(entry, raw, rawInput, { requestId, signal, traceparent }) {
      const { definition, path } = entry;
      const credential = presentedCredential(raw, acceptIamCookie);
      const base = {
        ...context,
        requestId,
        ...(signal ? { signal } : {}),
        ...(traceparent
          ? { traceparent, commands: tracedCommands(context.commands, traceparent) }
          : {}),
      };

      if (definition.kind === 'public') {
        const input = definition.validate(rawInput ?? {});
        return definition.handler({ ...base, ...(credential ? { credential } : {}) }, input);
      }

      if (!credential) throw new ComputeError('UNAUTHENTICATED', 'A credential is required');
      const input = definition.validate(rawInput ?? {});
      const caller = await caches.authenticate(credential, () => iam.authenticate(credential));

      const mutation = definition.kind === 'mutation';
      const admission = mutation ? definition.admission : undefined;
      // Admitted methods may learn their resource only in `prepare` (a draft id); a declared one
      // still has to match §9.2 and sets the scope of the pre-check.
      const declared = definition.resource(input);
      const resource =
        admission && declared === undefined ? undefined : checkResource(entry, declared);
      const inputTenant = tenantOf(input);
      const tenantId = decisionTenant(resource, inputTenant);
      if (tenantId === undefined)
        throw new ComputeError('INVALID_CONFIG', `${path} names no tenant to decide in`);

      // §3.4 step 3: before compute's database or any decision, so an outsider learns nothing and
      // puts no traffic on the tenant's audit chain.
      preCheck(caller, tenantId, inputTenant);
      await tenantGate.check(caller, [tenantId, inputTenant], mutation);

      const contextFor = (
        sql: SqlExecutor,
        admitted?: AdmissionContext,
        composite: Pick<CompositeCall, 'check' | 'invoke'> = outsideComposite,
      ): MethodContext => ({
        ...base,
        sql,
        caller,
        credential,
        ...(admitted ? { admission: admitted } : {}),
        check: (path, input) => composite.check(path, input),
        invoke: <O>(tx: SqlTx, path: `${string}/${string}`, input: unknown) =>
          composite.invoke(tx, path, input) as Promise<O>,
      });

      if (admission)
        return waited(
          definition,
          input,
          await admit(
            entry,
            admission as MethodAdmission<unknown, unknown>,
            tenantId,
            input,
            caller,
            credential,
            requestId,
            contextFor,
          ),
          contextFor,
          signal,
        );

      const decision = decisionOf(tenantId, entry.action!, resource!);
      // Exactly one decision, outside any compute transaction (IAM holds its own lock meanwhile).
      if (mutation) await iam.require(credential, decision);
      else if (
        !(await caches.authorize(caller, decision, () => iam.authorize(credential, decision)))
      )
        throw accessDenied();

      if (mutation && definition.transaction === 'manual') {
        // A composite: its handler opens its own transactions and composes checked sub-calls.
        const admitted = admissionOf(caller, decision, requestId, clock.now());
        const composite = composites.begin({
          entry,
          caller,
          credential,
          requestId,
          contextFor: (sql, admission, kind) =>
            kind === 'public' ? { ...base, sql, credential } : contextFor(sql, admission),
        });
        let value: unknown;
        try {
          value = await definition.handler(
            contextFor(outsideTransaction(database), admitted, composite),
            input,
          );
        } finally {
          // Grants live only for this call.
          composite.end();
        }
        await database.transaction((tx) => recordAudit(tx, admitted));
        return value;
      }

      if (!mutation && runsOutsideTransaction(definition))
        return definition.handler(contextFor(readOnlyExecutor(database)), input);

      if (entry.row?.list && !mutation) {
        const itemKind = listItemKind(entry);
        const load = () =>
          database.transaction(
            (tx) => definition.handler(contextFor(withinTransaction(database, tx)), input),
            { readOnly: true },
          );
        const scope = isRecord(input) ? input.scope : undefined;
        if (itemKind && ownerScopedKinds.has(itemKind) && (scope === undefined || scope === 'mine'))
          return load();
        if (!itemKind)
          throw new ComputeError('INVALID_CONFIG', `${path} lists items of no known kind`);
        // The list recipe's per-item checks, after the page's read-only transaction (§9.2).
        let answer: Record<string, unknown> = {};
        const items = await lists.authorizeItems(
          contextFor(readOnlyExecutor(database)),
          tenantId,
          async () => {
            const result: unknown = await load();
            const listed = isRecord(result) ? result.items : undefined;
            if (
              !Array.isArray(listed) ||
              listed.some((item) => !isRecord(item) || typeof item.id !== 'string')
            )
              throw new ComputeError(
                'INTERNAL_ERROR',
                `${path} follows the list recipe and must answer { items: [{ id, … }] }`,
              );
            answer = result as Record<string, unknown>;
            return listed as { id: string }[];
          },
          { action: entry.action!, type: itemKind, id: (item) => item.id },
        );
        return { ...answer, items };
      }

      const admitted = mutation ? admissionOf(caller, decision, requestId, clock.now()) : undefined;
      const output = await database.transaction(
        async (tx) => {
          const value = await definition.handler(
            contextFor(withinTransaction(database, tx), admitted),
            input,
          );
          if (admitted) await recordAudit(tx, admitted);
          return value;
        },
        mutation ? {} : { readOnly: true },
      );
      return mutation ? waited(definition, input, output, contextFor, signal) : output;
    },
  };
}
