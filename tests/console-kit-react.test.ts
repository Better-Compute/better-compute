import { describe, expect, it } from 'vitest';
import {
  bindReact,
  createDetail,
  createListResource,
  createPermissions,
  createStore,
  type ReactLike,
} from '@better-compute/console-kit';

// The React bindings, driven by a minimal React stand-in: useSyncExternalStore reads the snapshot
// and records the subscription, useEffect runs once per dependency change, re-renders are explicit.

function fakeReact() {
  const subscriptions: (() => void)[] = [];
  let renders = 0;
  const effects = new Map<number, readonly unknown[]>();
  let slot = 0;
  const react: ReactLike = {
    useSyncExternalStore(subscribe, getSnapshot) {
      subscriptions.push(subscribe(() => renders++));
      return getSnapshot();
    },
    useEffect(effect, deps) {
      const index = slot++;
      const previous = effects.get(index);
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) {
        effects.set(index, deps ?? []);
        effect();
      }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value as never, () => undefined];
    },
  };
  return {
    react,
    render<T>(hook: () => T): T {
      slot = 0;
      return hook();
    },
    get renders() {
      return renders;
    },
  };
}

describe('React bindings', () => {
  it('useStore reads snapshots and re-renders on change', () => {
    const fake = fakeReact();
    const { useStore } = bindReact(fake.react);
    const store = createStore({ count: 1 });
    expect(fake.render(() => useStore(store))).toEqual({ count: 1 });
    store.set({ count: 2 });
    expect(fake.renders).toBe(1);
    expect(fake.render(() => useStore(store))).toEqual({ count: 2 });
  });

  it('useList loads an idle list once', async () => {
    const fake = fakeReact();
    const { useList } = bindReact(fake.react);
    let loads = 0;
    const list = createListResource<{ id: string }>({
      key: (item) => item.id,
      load: async () => {
        loads++;
        return { items: [{ id: 'a' }] };
      },
    });
    fake.render(() => useList(list));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.render(() => useList(list));
    expect(loads).toBe(1);
    expect(fake.render(() => useList(list)).items).toEqual([{ id: 'a' }]);
  });

  it('useDetail loads once; useAction runs and reports outcomes', async () => {
    const fake = fakeReact();
    const states: unknown[] = [];
    const react: ReactLike = {
      ...fake.react,
      useState: (initial) => {
        const value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        return [value as never, (next: unknown) => void states.push(next)];
      },
    };
    const { useDetail, useAction } = bindReact(react);
    let loads = 0;
    const api = {
      async $request<O>(path: string) {
        if (path === 'reservations/get') {
          loads++;
          return { id: 'rsv_1', state: 'active' } as O;
        }
        throw Object.assign(new Error('confirm'), {
          code: 'CONFIRMATION_REQUIRED',
          details: { confirmationId: 'c1' },
        });
      },
    };
    const detail = createDetail(api, { tenantId: 'acme', kind: 'reservation', id: 'rsv_1' });
    fake.render(() => useDetail(detail));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.render(() => useDetail(detail));
    expect(loads).toBe(1);
    expect(fake.render(() => useDetail(detail)).item).toEqual({ id: 'rsv_1', state: 'active' });

    const action = fake.render(() => useAction(detail, 'reservations/release'));
    expect(await action.run()).toEqual({ status: 'confirmation-required', confirmationId: 'c1' });
    expect(states).toEqual([
      { pending: true },
      { pending: false, outcome: { status: 'confirmation-required', confirmationId: 'c1' } },
    ]);
  });

  it('usePermission is undefined until IAM answers, then the answer', async () => {
    const fake = fakeReact();
    const { usePermission } = bindReact(fake.react);
    const permissions = createPermissions({ authorize: async (checks) => checks.map(() => true) });
    const check = { action: 'compute:nodes:cordon', resource: { type: 'compute-node', id: 'n1' } };
    expect(fake.render(() => usePermission(permissions, check))).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.render(() => usePermission(permissions, check))).toBe(true);
    expect(fake.render(() => usePermission(permissions, undefined))).toBeUndefined();
  });
});
