// An IamPort spy for the v0.1 security negative (PLAN.md §16, P7): "an IamPort spy records zero IAM calls on
// heartbeat, inventory and command paths over a 10-minute simulated run". Code paths tag themselves with
// `spy.path('heartbeat', fn)`; every IAM call made inside (across awaits) is attributed to the innermost
// path, so a test can assert that fleet paths never reach IAM while admissions do.

import { AsyncLocalStorage } from 'node:async_hooks';
import { systemClock, type Clock, type IamPort } from '@better-compute/core';

export type IamPortMethod = Exclude<keyof IamPort, 'rootTenantId' | 'capabilities'>;

export interface IamCall {
  method: IamPortMethod;
  /** The innermost `path()` active when the call was made; absent outside any path. */
  path?: string;
  /** Every active path, outermost first. */
  paths: string[];
  at: number;
  tenantId?: string;
  action?: string;
  resource?: { type: string; id: string };
  /** `authorizeMany`: the batch size; `recordUsage`: the event count. */
  size?: number;
  outcome: 'ok' | 'error';
}

export interface IamSpy extends IamPort {
  readonly calls: readonly IamCall[];
  /** Runs `fn` with `name` pushed onto the path stack of every IAM call it makes, across awaits. */
  path<T>(name: string, fn: () => T): T;
  /** Calls attributed to `path` (as the innermost path, or anywhere in the stack with `{ nested: true }`). */
  callsOn(path: string, options?: { nested?: boolean }): IamCall[];
  /** Calls per innermost path (`(none)` for untagged calls). */
  summary(): Record<string, number>;
  reset(): void;
}

/** Wraps an IamPort; the wrapper behaves exactly like `inner` and records each call it forwards. */
export function spyIamPort(inner: IamPort, options: { clock?: Clock } = {}): IamSpy {
  const clock = options.clock ?? systemClock;
  const storage = new AsyncLocalStorage<string[]>();
  const calls: IamCall[] = [];

  const describe = (method: IamPortMethod, args: unknown[]): Partial<IamCall> => {
    const [, second, third] = args as [unknown, unknown, unknown];
    switch (method) {
      case 'require':
      case 'authorize':
      case 'requestConfirmation': {
        const decision = second as {
          tenantId: string;
          action: string;
          resource: IamCall['resource'];
        };
        return {
          tenantId: decision.tenantId,
          action: decision.action,
          resource: decision.resource,
        };
      }
      case 'authorizeMany':
        return { tenantId: second as string, size: (third as unknown[]).length };
      case 'recordUsage':
        return { size: (args[0] as unknown[]).length };
      case 'featureEnabled':
        return { tenantId: args[0] as string, action: `feature:${String(second)}` };
      case 'billingCheck':
      case 'quote':
      case 'spend':
        return { tenantId: (args[0] as { tenantId: string }).tenantId };
      default:
        return {};
    }
  };

  const wrap = <M extends IamPortMethod>(method: M) =>
    (async (...args: unknown[]) => {
      const paths = [...(storage.getStore() ?? [])];
      const call: IamCall = {
        method,
        paths,
        at: clock.now(),
        outcome: 'ok',
        ...describe(method, args),
      };
      if (paths.length) call.path = paths[paths.length - 1]!;
      calls.push(call);
      try {
        return await (inner[method] as (...forwarded: unknown[]) => Promise<unknown>)(...args);
      } catch (error) {
        call.outcome = 'error';
        throw error;
      }
    }) as IamPort[M];

  const spy: IamSpy = {
    ...(inner.rootTenantId === undefined ? {} : { rootTenantId: inner.rootTenantId }),
    authenticate: wrap('authenticate'),
    require: wrap('require'),
    authorize: wrap('authorize'),
    authorizeMany: wrap('authorizeMany'),
    requestConfirmation: wrap('requestConfirmation'),
    billingCheck: wrap('billingCheck'),
    recordUsage: wrap('recordUsage'),
    featureEnabled: wrap('featureEnabled'),
    capabilities: () => inner.capabilities(),
    // Optional members the inner port has (billing: meters, prices, quotes, spend) are forwarded and recorded too.
    ...(inner.ensureMeters ? { ensureMeters: wrap('ensureMeters') } : {}),
    ...(inner.setPrice ? { setPrice: wrap('setPrice') } : {}),
    ...(inner.listPrices ? { listPrices: wrap('listPrices') } : {}),
    ...(inner.quote ? { quote: wrap('quote') } : {}),
    ...(inner.spend ? { spend: wrap('spend') } : {}),
    get calls() {
      return calls;
    },
    path<T>(name: string, fn: () => T): T {
      return storage.run([...(storage.getStore() ?? []), name], fn);
    },
    callsOn(path: string, options: { nested?: boolean } = {}) {
      return calls.filter((call) =>
        options.nested ? call.paths.includes(path) : call.path === path,
      );
    },
    summary() {
      const counts: Record<string, number> = {};
      for (const call of calls)
        counts[call.path ?? '(none)'] = (counts[call.path ?? '(none)'] ?? 0) + 1;
      return counts;
    },
    reset() {
      calls.length = 0;
    },
  };
  return spy;
}
