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

// The deployment's root tenant is resolved once, from `betterCompute({ rootTenantId })` or the port's own
// `rootTenantId` (they must agree). Modules decide what is the platform's from `context.iam.rootTenantId`
// (vps provider accounts, discovery), so the port they get always names the resolved root, also when the host
// names it only on betterCompute(). Same live view as above, over an empty target for frozen ports; its
// methods run with the port itself as `this` (a class port's private fields), one bound copy per method.

export function withRootTenant(iam: IamPort, rootTenantId: string): IamPort {
  if (iam.rootTenantId === rootTenantId) return iam;
  const own = { value: rootTenantId, writable: false, enumerable: true, configurable: true };
  const bound = new WeakMap<object, unknown>();
  return new Proxy({} as IamPort, {
    get(_target, key) {
      if (key === 'rootTenantId') return rootTenantId;
      const value: unknown = Reflect.get(iam, key);
      if (typeof value !== 'function') return value;
      if (!bound.has(value)) bound.set(value, (value as (...a: unknown[]) => unknown).bind(iam));
      return bound.get(value);
    },
    set: (_target, key, value) => key !== 'rootTenantId' && Reflect.set(iam, key, value),
    has: (_target, key) => key === 'rootTenantId' || Reflect.has(iam, key),
    ownKeys: () => [...new Set([...Reflect.ownKeys(iam), 'rootTenantId'])],
    getOwnPropertyDescriptor(_target, key) {
      if (key === 'rootTenantId') return own;
      const descriptor = Reflect.getOwnPropertyDescriptor(iam, key);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}
