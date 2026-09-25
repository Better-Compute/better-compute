import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  defineMethod,
  defineModule,
  isComputeError,
  manualClock,
  type ComputeModule,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fakeIam, type FakeIam } from './support/fake-iam.js';
import { ACME, options } from './support/server.js';
import { START } from './support/server-api.js';

// Per-input actions (core `MethodResource.action`): a §9.2 row with "… or @ …" alternatives whose
// action differs (tunnels.open: `instances:exec` @ instance, or `nodes:console` @ node) lets the
// method name the alternative's action with its resource. The envelope decides on that action, and
// refuses any (action, resource) pair the row does not list, overrides included.

const USER = 'token-override-user-0123456789';

type OpenInput = { tenantId: string; instanceId?: string; nodeId?: string; mode?: string };

/** Stands in for the tunnels module; `mode` picks what `resource()` answers. */
const tunnels: ComputeModule = defineModule({
  name: 'tunnels',
  api: () => ({
    tunnels: {
      open: defineMethod<OpenInput, { decided: true }>({
        action: 'compute:instances:exec',
        kind: 'mutation',
        resource: (input) => {
          switch (input.mode) {
            case 'node-console':
              return { type: 'node', id: input.nodeId!, action: 'compute:nodes:console' };
            case 'node-default':
              // The method's own action on the alternative's resource: not a listed pair.
              return { type: 'node', id: input.nodeId! };
            case 'unlisted':
              return { type: 'node', id: input.nodeId!, action: 'compute:nodes:delete' };
            case 'malformed':
              return { type: 'node', id: input.nodeId!, action: 'nodes:console' as never };
            default:
              return { type: 'instance', id: input.instanceId! };
          }
        },
        validate: (raw) => {
          const input = raw as OpenInput;
          if (typeof input?.tenantId !== 'string')
            throw new ComputeError('INVALID_INPUT', 'tenantId is required');
          return input;
        },
        handler: async () => ({ decided: true }),
      }),
    },
  }),
});

let store: ReturnType<typeof pglite>;
let iam: FakeIam;
let compute: BetterCompute;

beforeAll(async () => {
  store = pglite();
  iam = fakeIam();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user', sessionId: 'ses-user' });
  compute = betterCompute({
    ...options(store, iam),
    clock: manualClock(START),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    modules: [tunnels],
  }) as unknown as BetterCompute;
  await compute.initialize();
  await useSimClock(store, START);
});
afterAll(async () => {
  await compute.stop();
  await store.close();
});
beforeEach(() => {
  iam.reset();
  iam.allow({});
  compute.caches.clear();
});

const open = (input: Omit<OpenInput, 'tenantId'>) =>
  (compute.api as any).tunnels.open({ token: USER }, { tenantId: ACME, ...input });
const decisions = () =>
  iam.calls.filter((call) => call.method === 'require').map((call) => call.decision);
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (isComputeError(error) ? error.code : String(error)),
  );

describe('MethodResource.action', () => {
  it("decides the method's own action on its row resource", async () => {
    await expect(open({ instanceId: 'inst_1' })).resolves.toEqual({ decided: true });
    expect(decisions()).toEqual([
      {
        tenantId: ACME,
        action: 'compute:instances:exec',
        resource: { type: 'compute-instance', id: 'inst_1' },
      },
    ]);
  });

  it("decides an alternative's own action when the resource names it", async () => {
    await expect(open({ nodeId: 'node_1', mode: 'node-console' })).resolves.toEqual({
      decided: true,
    });
    expect(decisions()).toEqual([
      {
        tenantId: ACME,
        action: 'compute:nodes:console',
        resource: { type: 'compute-node', id: 'node_1' },
      },
    ]);
  });

  it('refuses a pair the row does not list, before any decision', async () => {
    for (const mode of ['node-default', 'unlisted', 'malformed']) {
      expect(await codeOf(open({ nodeId: 'node_1', mode })), mode).toBe('INVALID_CONFIG');
    }
    expect(decisions()).toEqual([]);
  });

  it('a denied alternative action is ACCESS_DENIED, and the handler never runs', async () => {
    iam.deny({ action: 'compute:nodes:console' });
    expect(await codeOf(open({ nodeId: 'node_1', mode: 'node-console' }))).toBe('ACCESS_DENIED');
    // The instance path still decides its own action.
    await expect(open({ instanceId: 'inst_1' })).resolves.toEqual({ decided: true });
  });
});
