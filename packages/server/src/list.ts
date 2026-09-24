import {
  ComputeError,
  defineMethod,
  isComputeError,
  type Check,
  type Decision,
  type MethodContext,
  type MethodDefinition,
  type SqlExecutor,
} from '@better-compute/core';
import type { Caches } from './caches.js';

// The list recipe of PLAN.md §9.2 (P7, P11):
// 1. coarse gate: the envelope's one decision on the method's scope (`compute-tenant/{t}` or
//    `compute-project/{id}`);
// 2. SQL pre-filter: the method's own query, scoped to the tenant and to rows the projection holds;
// 3. owner-scoped kinds with `scope: 'mine'`: the coarse decision plus `owner_identity_id = caller`;
// 4. everything else: per-item checks with `authorizeMany`, at most 50 per call, answered from the
//    read-decision cache where it can. A batch error fails the request; a resolver NOT_FOUND (a row
//    the local projection does not hold yet) reloads the page and retries once.
// IAM is never called inside a compute transaction, so list methods run without the envelope's
// wrapping transaction (`defineListMethod`) and read through a read-only executor.

/** better-iam's `authorizeMany` batch size. */
export const itemBatchSize = 50;

/** How each item of a page is decided. */
export interface ItemCheck<T> {
  /** The action (`compute:nodes:read`). */
  action: string;
  /** The item's resource kind without the type prefix (`node`). */
  type: string;
  id(item: T): string;
}

export interface ListRecipeOptions {
  /** The IAM resource type prefix (`compute-`). */
  typePrefix: string;
  caches: Caches;
  /** How long to let the projection catch up before the one retry (default 100 ms). */
  retryDelayMs?: number;
  sleep?(ms: number): Promise<void>;
}

export interface ListRecipe {
  /**
   * Step 4: loads a page with `load` (SQL, outside IAM), decides each item, and returns the allowed
   * items in page order. Throws when a batch fails (never "all false"), after one reload-and-retry
   * when the batch failed with `NOT_FOUND`.
   */
  authorizeItems<T>(
    context: MethodContext,
    tenantId: string,
    load: () => Promise<readonly T[]>,
    check: ItemCheck<T>,
  ): Promise<T[]>;
  /**
   * Step 3: the owner-scoped shortcut. The SQL already filtered on the caller's identity; any row
   * owned by someone else is a bug and fails the request rather than leaking.
   */
  mine<T>(
    context: MethodContext,
    items: readonly T[],
    ownerOf: (item: T) => string | undefined,
  ): T[];
}

const isNotFound = (error: unknown) =>
  isComputeError(error, 'NOT_FOUND') ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'NOT_FOUND');

function callerOf(context: MethodContext) {
  if (!context.caller || !context.credential)
    throw new ComputeError('INVALID_STATE', 'The list recipe needs an authenticated caller');
  return { caller: context.caller, credential: context.credential };
}

export function createListRecipe(options: ListRecipeOptions): ListRecipe {
  const { typePrefix, caches } = options;
  const delay = options.retryDelayMs ?? 100;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function decide<T>(
    context: MethodContext,
    tenantId: string,
    items: readonly T[],
    check: ItemCheck<T>,
  ): Promise<T[]> {
    const { caller, credential } = callerOf(context);
    const decisions: Decision[] = items.map((item) => ({
      tenantId,
      action: check.action,
      resource: { type: `${typePrefix}${check.type}`, id: check.id(item) },
    }));
    const allowed = decisions.map((decision) => caches.cachedDecision(caller, decision) === true);
    const pending = allowed.flatMap((known, index) => (known ? [] : [index]));
    const generation = caches.generation();
    const fresh: Decision[] = [];
    for (let start = 0; start < pending.length; start += itemBatchSize) {
      const chunk = pending.slice(start, start + itemBatchSize);
      const checks: Check[] = chunk.map((index) => ({
        action: decisions[index]!.action,
        resource: decisions[index]!.resource,
      }));
      const results: unknown = await context.iam.authorizeMany(credential, tenantId, checks);
      // P11: an answer that does not match the batch is an error, never a partial list.
      if (
        !Array.isArray(results) ||
        results.length !== chunk.length ||
        results.some((result) => typeof result !== 'boolean')
      )
        throw new ComputeError(
          'INTERNAL_ERROR',
          `authorizeMany answered ${Array.isArray(results) ? results.length : 'no list'} for ${chunk.length} checks`,
        );
      chunk.forEach((index, position) => {
        if (results[position] === true) {
          allowed[index] = true;
          fresh.push(decisions[index]!);
        }
      });
    }
    caches.rememberAllowed(caller, fresh, generation);
    return items.filter((_, index) => allowed[index]);
  }

  return {
    async authorizeItems(context, tenantId, load, check) {
      let items = await load();
      try {
        return await decide(context, tenantId, items, check);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      // The resolver did not know an item yet: give the projection a moment, reload, retry once.
      if (delay > 0) await sleep(delay);
      items = await load();
      return decide(context, tenantId, items, check);
    },
    mine(context, items, ownerOf) {
      const { caller } = callerOf(context);
      if (items.some((item) => ownerOf(item) !== caller.identityId))
        throw new ComputeError(
          'INTERNAL_ERROR',
          'An owner-scoped list read a row of another owner',
        );
      return [...items];
    },
  };
}

// --- Methods that run outside the envelope's transaction ------------------------------------------

const untransacted = new WeakSet<object>();

/**
 * A read method that follows the list recipe. The envelope decides the coarse gate as for any read,
 * but runs the handler without a wrapping transaction: `context.sql` runs each statement (and each
 * explicit `transaction`) read-only, so the handler may call IAM between its reads.
 */
export function defineListMethod<I, O>(method: MethodDefinition<I, O>): MethodDefinition<I, O> {
  if (method.kind !== 'read')
    throw new ComputeError('INVALID_CONFIG', 'Only read methods follow the list recipe');
  const definition = defineMethod(method);
  untransacted.add(definition);
  return definition;
}

/** Whether the envelope runs this method's handler outside a transaction. */
export function runsOutsideTransaction(definition: MethodDefinition): boolean {
  return untransacted.has(definition);
}

/** An executor whose every statement and transaction is read-only; for list handlers. */
export function readOnlyExecutor(database: SqlExecutor): SqlExecutor {
  const refuse = (what: string) => () =>
    Promise.reject(new ComputeError('INVALID_STATE', `${what} cannot run inside a method`));
  return {
    dialect: database.dialect,
    kind: database.kind,
    query: (text, params) =>
      database.transaction((tx) => tx.query(text, params), { readOnly: true }),
    transaction: (fn, options) => database.transaction(fn, { ...options, readOnly: true }),
    migrate: refuse('migrate()'),
    close: refuse('close()'),
  };
}
