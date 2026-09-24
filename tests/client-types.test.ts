import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createComputeClient,
  type ComputeCallOptions,
  type ComputeClient,
} from '@better-compute/client';
import {
  defineMethod,
  defineModule,
  definePlugin,
  type Credential,
  type IamPort,
  type InventorySnapshot,
  type SqlExecutor,
} from '@better-compute/core';
import type { InventoryNodeInput } from '@better-compute/inventory';
import {
  betterCompute,
  type NoInput,
  type SelfCheckReport,
  type ServerInfo,
  type WhoAmI,
} from '@better-compute/server';

// Client inference from `typeof compute` (PLAN.md §9.3): core groups, injected modules' groups and
// plugins under `plugins[id]`, with the credential stripped. `pnpm typecheck` runs this file through
// tests/tsconfig.client.json; vitest runs it too, where the assertions are no-ops.

type NodeInput = { tenantId: string; nodeId: string };
type WidgetInput = { tenantId: string; widgetId: string };
const stub = <I, O>(action: `compute:${string}`, kind: 'read' | 'mutation') =>
  defineMethod<I, O>({
    action,
    kind,
    resource: () => ({ type: 'tenant', id: 't' }),
    validate: (input) => input as I,
    handler: () => Promise.reject(new Error('not called')),
  });

const ops = defineModule({
  name: 'ops',
  api: () => ({
    nodes: { cordon: stub<NodeInput, { cordoned: true }>('compute:nodes:cordon', 'mutation') },
  }),
});
const acme = definePlugin({
  id: 'acme',
  catalog: { actions: ['compute:acme:poke', 'compute:acme:read'] },
  api: () => ({
    widgets: {
      poke: stub<WidgetInput, { poked: string }>('compute:acme:poke', 'mutation'),
      find: stub<{ tenantId?: string; cursor?: string }, { items: string[] }>(
        'compute:acme:read',
        'read',
      ),
    },
  }),
});

const unused = () => Promise.reject(new Error('not called'));
const placeholders = {
  database: { query: unused, transaction: unused, migrate: unused } as unknown as SqlExecutor,
  iam: { authenticate: unused, require: unused, authorize: unused } as unknown as IamPort,
  secret: 'client-types-secret-0123456789abcdef',
  baseURL: 'https://compute.example',
  rootTenantId: 'root',
};
// Construction touches neither the store nor IAM, so placeholders are enough.
const compute = betterCompute({ ...placeholders, modules: [ops], plugins: [acme] });
const bare = betterCompute(placeholders);

const fetch = async () => Response.json({ data: null });
const client = createComputeClient<typeof compute>({ baseURL: 'https://compute.example', fetch });
const bareClient = createComputeClient<typeof bare>({ baseURL: 'https://compute.example', fetch });

describe('client inference', () => {
  it('strips the credential and keeps inputs and outputs', () => {
    expectTypeOf(client).toEqualTypeOf<ComputeClient<typeof compute>>();
    expectTypeOf(client.system.version).parameters.toEqualTypeOf<
      [input?: NoInput, options?: ComputeCallOptions]
    >();
    expectTypeOf(client.system.version).returns.resolves.toEqualTypeOf<ServerInfo>();
    expectTypeOf(client.system.whoami).returns.resolves.toEqualTypeOf<WhoAmI>();
    expectTypeOf(client.system.selfCheck).returns.resolves.toEqualTypeOf<SelfCheckReport>();
    expectTypeOf(client.inventory.get).parameters.toEqualTypeOf<
      [input: InventoryNodeInput, options?: ComputeCallOptions]
    >();
    expectTypeOf(client.inventory.get).returns.resolves.toEqualTypeOf<InventorySnapshot>();
    expectTypeOf(client.$request<number>).returns.resolves.toEqualTypeOf<number>();
    expect(typeof client.system.version).toBe('function');
  });

  it('adds injected modules groups and plugins under plugins[id]', () => {
    expectTypeOf(client.nodes.cordon).parameters.toEqualTypeOf<
      [input: NodeInput, options?: ComputeCallOptions]
    >();
    expectTypeOf(client.nodes.cordon).returns.resolves.toEqualTypeOf<{ cordoned: true }>();
    expectTypeOf(client.plugins.acme.widgets.poke).parameters.toEqualTypeOf<
      [input: WidgetInput, options?: ComputeCallOptions]
    >();
    expectTypeOf(client.plugins.acme.widgets.poke).returns.resolves.toEqualTypeOf<{
      poked: string;
    }>();
    // An input whose fields are all optional may be left out.
    expectTypeOf(client.plugins.acme.widgets.find).toBeCallableWith();
    expectTypeOf(client.plugins.acme.widgets.find).toBeCallableWith({ cursor: 'c' });
    expectTypeOf<keyof typeof client.plugins>().toEqualTypeOf<'acme'>();
    expectTypeOf<keyof typeof bareClient.plugins>().toEqualTypeOf<never>();
  });

  it('types compute.api as (credential, input)', () => {
    expectTypeOf(compute.api.system.version).toEqualTypeOf<
      (credential?: Credential, input?: NoInput) => Promise<ServerInfo>
    >();
    expectTypeOf(compute.api.inventory.get).toEqualTypeOf<
      (credential: Credential, input: InventoryNodeInput) => Promise<InventorySnapshot>
    >();
    expectTypeOf(compute.api.plugins.acme.widgets.poke).toEqualTypeOf<
      (credential: Credential, input: WidgetInput) => Promise<{ poked: string }>
    >();
  });

  it('rejects what the server does not have', () => {
    // Never called: the lines only have to fail to compile.
    const typeOnly = async () => {
      // @ts-expect-error vps() is not among the modules
      void client.instances;
      // @ts-expect-error the server has no plugin `other`
      void client.plugins.other;
      // @ts-expect-error a server without plugins has none
      void bareClient.plugins.acme;
      // @ts-expect-error nor the ops module's group
      void bareClient.nodes;
      // @ts-expect-error the client supplies the credential; version takes no input
      void client.system.version({ token: 'biam_ses_0123456789abcdef' });
      // @ts-expect-error inventory.get needs its input
      void client.inventory.get();
      // @ts-expect-error nodeId is required
      void client.inventory.get({ tenantId: 't' });
      // @ts-expect-error outputs are typed
      const version: number = await client.system.version();
      void version;
    };
    expect(typeof typeOnly).toBe('function');
  });
});
