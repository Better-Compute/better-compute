import { ComputeError, type IamPort, type Logger } from '@better-compute/core';

// PLAN.md §8.1 (`all` mode) and §12.1: no IamPort call is ever awaited inside a compute transaction.
// Embedded IAM takes its own lock and may wait on the same database; remote IAM is a network round
// trip; either one held inside a compute transaction stalls every writer behind it. `iamGuard`
// wraps the port so a call made while a transaction of the deployment's executor is open is
// reported (`warn`) or refused (`throw`). The flag cache (`featureEnabled`) and the in-memory
// `refreshResource` are exempt: they answer from memory.
//
// The wrapper is a live view (a Proxy), not a copy: a method the host swaps on the port later (a
// test spy, a bridge that fills `refreshResource` after start) is the one called.

export type IamGuardMode = 'off' | 'warn' | 'throw';

const guarded: ReadonlySet<PropertyKey> = new Set([
  'authenticate',
  'require',
  'authorize',
  'authorizeMany',
  'authorizeSession',
  'isMember',
  'requestConfirmation',
  'billingCheck',
  'recordUsage',
]);

export function guardIamPort(
  iam: IamPort,
  inTransaction: () => boolean,
  mode: IamGuardMode,
  log: Logger,
): IamPort {
  if (mode === 'off') return iam;
  // An empty target that forwards to the port: a frozen port (the CLI's `unconfiguredIam()`)
  // would forbid a proxy over it from answering with a wrapper (the non-configurable invariant).
  return new Proxy({} as IamPort, {
    get(_target, key) {
      const value: unknown = Reflect.get(iam, key);
      if (!guarded.has(key) || typeof value !== 'function') return value;
      const name = String(key);
      return (...args: unknown[]) => {
        if (inTransaction()) {
          const message = `IamPort.${name} was called inside a compute transaction (§8.1)`;
          if (mode === 'throw') return Promise.reject(new ComputeError('INVALID_STATE', message));
          log.warn(message, { method: name });
        }
        return (value as (...a: unknown[]) => unknown).apply(iam, args);
      };
    },
    set: (_target, key, value) => Reflect.set(iam, key, value),
    has: (_target, key) => Reflect.has(iam, key),
    ownKeys: () => Reflect.ownKeys(iam),
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(iam, key);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}
