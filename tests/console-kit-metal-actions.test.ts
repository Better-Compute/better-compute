import { describe, expect, it } from 'vitest';
import { actionsFor, applicable } from '@better-compute/console-kit';

// The console's node Lifecycle panel (apps/console nodes/[nodeId]): the metal verbs are node actions, gated by the
// provision state machine.

describe('metal lifecycle actions on a node', () => {
  const actions = actionsFor('node', 'node_01k5w0000000000000000000aa');
  const byPath = (path: string) => actions.find((action) => action.path === path)!;

  it('offers every metal verb the panel shows', () => {
    for (const verb of ['manage', 'inspect', 'provide', 'rescue', 'unrescue', 'abort', 'recover', 'undeploy', 'retire'])
      expect(byPath(`metal/${verb}`), verb).toMatchObject({ action: 'compute:nodes:provision' });
  });

  it('gates them by the provision state', () => {
    const ready = { id: 'node_1', provisionState: 'ready' };
    expect(applicable('node', byPath('metal/inspect'), ready)).toBe(true);
    expect(applicable('node', byPath('metal/rescue'), ready)).toBe(false);
    expect(applicable('node', byPath('metal/rescue'), { ...ready, provisionState: 'deployed' })).toBe(true);
    expect(applicable('node', byPath('metal/recover'), { ...ready, provisionState: 'failed' })).toBe(true);
    expect(applicable('node', byPath('metal/recover'), ready)).toBe(false);
    // Nothing changes a retired node.
    expect(applicable('node', byPath('metal/retire'), { ...ready, provisionState: 'retired' })).toBe(false);
  });
});
