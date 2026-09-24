import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createListResource, createPermissions, createStore } from '@better-compute/console-kit';
import { useList, usePermission, useStore } from '@better-compute/console-kit/react';

// The `./react` subpath against real React 19: server rendering reads the stores' current values
// through useSyncExternalStore (with the server snapshot), so a console page renders on the server.
// React is console-kit's dev dependency: load it from there, the same copy `./react` binds.
const fromConsoleKit = createRequire(
  new URL('../packages/console-kit/package.json', import.meta.url),
);
const { createElement } = fromConsoleKit('react') as typeof import('react');
const { renderToString } = fromConsoleKit('react-dom/server') as typeof import('react-dom/server');

describe('console-kit/react with React 19', () => {
  it('renders store values, list items and permission states on the server', async () => {
    const counter = createStore({ gpus: 8 });
    const list = createListResource<{ id: string }>({
      key: (item) => item.id,
      load: async () => ({ items: [{ id: 'rsv_1' }, { id: 'rsv_2' }] }),
    });
    await list.refresh();
    const permissions = createPermissions({ authorize: async (checks) => checks.map(() => true) });
    const check = { action: 'compute:nodes:cordon', resource: { type: 'compute-node', id: 'n1' } };

    function Page() {
      const { gpus } = useStore(counter);
      const { items, status } = useList(list);
      const allowed = usePermission(permissions, check);
      return createElement(
        'main',
        null,
        createElement('p', null, `${gpus} GPUs, ${status}`),
        createElement(
          'ul',
          null,
          ...items.map((item) => createElement('li', { key: item.id }, item.id)),
        ),
        createElement('button', { disabled: allowed !== true }, 'Cordon'),
      );
    }

    const before = renderToString(createElement(Page));
    expect(before).toContain('8 GPUs, ready');
    expect(before).toContain('<li>rsv_1</li><li>rsv_2</li>');
    expect(before).toContain('disabled=""');

    counter.set({ gpus: 16 });
    await permissions.can(check);
    const after = renderToString(createElement(Page));
    expect(after).toContain('16 GPUs');
    expect(after).not.toContain('disabled');
  });
});
