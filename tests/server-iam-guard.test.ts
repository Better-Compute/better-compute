import { describe, expect, it, vi } from 'vitest';
import { ComputeError, type IamPort, type Logger } from '@better-compute/core';
import { guardIamPort, withRootTenant } from '../packages/server/src/iam-guard.js';

// PLAN.md §8.1: no IamPort call is awaited inside a compute transaction. The guard reports (`warn`)
// or refuses (`throw`) one made while the executor's transaction is open.

function port(): IamPort {
  return {
    authenticate: vi.fn(async () => ({ identityId: 'id-1' })),
    require: vi.fn(async () => ({ decisionId: 'd-1' })),
    authorize: vi.fn(async () => true),
    authorizeMany: vi.fn(async (_c, _t, checks: unknown[]) => checks.map(() => true)),
    requestConfirmation: vi.fn(async () => 'not-held-back' as const),
    billingCheck: vi.fn(async () => ({ allowed: true, budgets: [] })),
    recordUsage: vi.fn(async () => undefined),
    featureEnabled: vi.fn(async () => true),
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
  } as unknown as IamPort;
}

function logger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

describe('iamGuard (§8.1)', () => {
  it('refuses a call inside a transaction in throw mode, and passes one outside', async () => {
    let open = false;
    const inner = port();
    const iam = guardIamPort(inner, () => open, 'throw', logger());
    await expect(
      iam.authorize('cred' as never, 't', 'a', { type: 'x', id: '1' } as never),
    ).resolves.toBe(true);
    open = true;
    const refused = iam.authorize('cred' as never, 't', 'a', { type: 'x', id: '1' } as never);
    await expect(refused).rejects.toBeInstanceOf(ComputeError);
    await expect(refused).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(inner.authorize).toHaveBeenCalledTimes(1);
    // The flag cache answers from memory: exempt.
    await expect(iam.featureEnabled('f' as never, 't' as never)).resolves.toBe(true);
  });

  it('logs and goes ahead in warn mode', async () => {
    const log = logger();
    const inner = port();
    const iam = guardIamPort(inner, () => true, 'warn', log);
    await iam.billingCheck('t' as never, [] as never);
    expect(inner.billingCheck).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'IamPort.billingCheck was called inside a compute transaction (§8.1)',
      { method: 'billingCheck' },
    );
  });

  it('is the port itself when off', () => {
    const inner = port();
    expect(guardIamPort(inner, () => true, 'off', logger())).toBe(inner);
  });

  it('wraps a frozen port and sees methods swapped on it later', async () => {
    const frozen = Object.freeze(port());
    const iam = guardIamPort(frozen, () => false, 'throw', logger());
    await expect(
      iam.authorize('c' as never, 't', 'a', { type: 'x', id: '1' } as never),
    ).resolves.toBe(true);
    expect(Object.isFrozen(frozen)).toBe(true);

    const live = port();
    const guarded = guardIamPort(live, () => false, 'throw', logger());
    const refreshResource = vi.fn(async () => undefined);
    live.refreshResource = refreshResource;
    live.authorize = vi.fn(async () => false);
    expect(guarded.refreshResource).toBe(refreshResource);
    await expect(
      guarded.authorize('c' as never, 't', 'a', { type: 'x', id: '1' } as never),
    ).resolves.toBe(false);
    expect('authorizeMany' in guarded).toBe(true);
  });
});

// Modules read the platform tenant from `context.iam.rootTenantId`; the server resolves it from
// betterCompute({ rootTenantId }) too, so the port modules get names it either way.
describe('withRootTenant', () => {
  it('is the port itself when it already names the root', () => {
    const inner = Object.assign(port(), { rootTenantId: 'root' });
    expect(withRootTenant(inner, 'root')).toBe(inner);
  });

  it('names the resolved root over a frozen port and forwards the rest', async () => {
    const frozen = Object.freeze(port());
    const iam = withRootTenant(frozen, 'root');
    expect(iam.rootTenantId).toBe('root');
    expect('rootTenantId' in iam).toBe(true);
    expect({ ...iam }.rootTenantId).toBe('root');
    expect(Object.getOwnPropertyDescriptor(iam, 'rootTenantId')?.value).toBe('root');
    await expect(
      iam.authorize('c' as never, 't', 'a', { type: 'x', id: '1' } as never),
    ).resolves.toBe(true);
    expect(frozen.authorize).toHaveBeenCalledTimes(1);
    expect((frozen as { rootTenantId?: string }).rootTenantId).toBeUndefined();
    // A write never moves the deployment's root.
    expect(Reflect.set(iam, 'rootTenantId', 'acme')).toBe(false);
    expect(iam.rootTenantId).toBe('root');
  });

  it("calls a class port's methods on the port itself, and sees methods swapped later", async () => {
    class Port {
      #allowed = true;
      async authorize() {
        return this.#allowed;
      }
    }
    const inner = Object.assign(new Port(), port(), {
      authorize: Port.prototype.authorize,
    }) as unknown as IamPort;
    const rooted = withRootTenant(inner, 'root');
    const iam = guardIamPort(rooted, () => false, 'throw', logger());
    await expect(
      iam.authorize('c' as never, 't', 'a', { type: 'x', id: '1' } as never),
    ).resolves.toBe(true);
    expect(rooted.authorize).toBe(rooted.authorize);

    inner.authorize = vi.fn(async () => false);
    await expect(
      iam.authorize('c' as never, 't', 'a', { type: 'x', id: '1' } as never),
    ).resolves.toBe(false);
  });
});
