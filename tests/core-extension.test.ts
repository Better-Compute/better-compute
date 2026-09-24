import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineAttestor,
  defineDriver,
  defineMethod,
  defineModule,
  definePlugin,
  defineSchedulerPlugin,
  defineSink,
  field,
  manifest,
  type ApiOf,
  type ComputeModule,
  type DriverDefinition,
  type Extension,
  type ProviderDefinition,
  type ProviderImpl,
  type StepDefinition,
  type MethodDefinition,
  type MethodInput,
  type MethodOutput,
  type ModuleApis,
  type PluginApis,
  type UsageSink,
} from '@better-compute/core';

// A test-only driver kind, merged the way `metal` and `vps` add theirs.
declare module '@better-compute/core' {
  interface DriverKinds {
    'core-test-probe': { ping(): Promise<'pong'> };
  }
}

const echo = defineMethod({
  action: 'compute:nodes:read',
  kind: 'read',
  resource: (input: { tenantId: string; nodeId: string }) => ({ type: 'node', id: input.nodeId }),
  validate: (input) => input as { tenantId: string; nodeId: string },
  handler: async (_context, input) => ({ nodeId: input.nodeId, ok: true as const }),
});

const metalLike = defineModule({
  name: 'metal-like',
  api: () => ({ metal: { echo } }),
  commandKinds: [],
});
const vpsLike = defineModule({ name: 'vps-like', api: () => ({ instances: { echo } }) });
const bare = defineModule({ name: 'bare' });
const acme = definePlugin({ id: 'acme-autoinstall', api: () => ({ isos: { render: echo } }) });

describe('modules and plugins', () => {
  it('keep their definitions and give plugins a name', () => {
    expect(metalLike.name).toBe('metal-like');
    expect(acme).toMatchObject({ id: 'acme-autoinstall', name: 'acme-autoinstall' });
    expectTypeOf(metalLike.name).toEqualTypeOf<'metal-like'>();
    expectTypeOf(acme.id).toEqualTypeOf<'acme-autoinstall'>();
    expectTypeOf(metalLike).toExtend<ComputeModule>();
    expectTypeOf(acme).toExtend<ComputeModule>();
  });

  it('type the merged API of modules and plugins', () => {
    type Modules = ModuleApis<[typeof metalLike, typeof vpsLike, typeof bare]>;
    expectTypeOf<Modules['metal']['echo']>().toEqualTypeOf<typeof echo>();
    expectTypeOf<Modules['instances']['echo']>().toEqualTypeOf<typeof echo>();
    expectTypeOf<ModuleApis<[]>>().toEqualTypeOf<{}>();
    expectTypeOf<keyof ApiOf<typeof bare>>().toEqualTypeOf<never>();
    type Plugins = PluginApis<[typeof acme]>;
    expectTypeOf<keyof Plugins>().toEqualTypeOf<'acme-autoinstall'>();
    expectTypeOf<Plugins['acme-autoinstall']['isos']['render']>().toEqualTypeOf<typeof echo>();
    expectTypeOf<MethodInput<typeof echo>>().toEqualTypeOf<{ tenantId: string; nodeId: string }>();
    expectTypeOf<MethodOutput<typeof echo>>().toEqualTypeOf<{ nodeId: string; ok: true }>();
  });

  it('run methods through their declared parts', async () => {
    expect(echo.resource({ tenantId: 't', nodeId: 'node_1' })).toEqual({
      type: 'node',
      id: 'node_1',
    });
    expect(await echo.handler({} as never, { tenantId: 't', nodeId: 'node_1' })).toEqual({
      nodeId: 'node_1',
      ok: true,
    });
    expect(Object.isFrozen(echo)).toBe(true);
    const publicMethod: MethodDefinition<undefined, { version: string }> = defineMethod({
      action: null,
      kind: 'public',
      resource: () => undefined,
      validate: () => undefined,
      handler: async () => ({ version: '0.1.0' }),
    });
    expect(publicMethod.action).toBeNull();
  });
});

describe('extensions', () => {
  it('stamp their extension kind', async () => {
    const config = manifest({ endpoint: field.url() });
    const probe = defineDriver({
      id: 'probe',
      version: '1.0.0',
      runsOn: 'control-plane',
      config,
      implements: { 'core-test-probe': () => ({ ping: async () => 'pong' as const }) },
      retrySafe: { 'core-test-probe': ['ping'] },
    });
    expect(probe.extension).toBe('driver');
    const driver = await probe.implements['core-test-probe'](
      { endpoint: 'https://bmc.test' },
      {} as never,
    );
    expect(await driver.ping()).toBe('pong');
    expectTypeOf(probe).toExtend<DriverDefinition>();
    expectTypeOf(probe.implements['core-test-probe'])
      .parameter(0)
      .toEqualTypeOf<{ endpoint: string }>();

    const spread = defineSchedulerPlugin({
      id: 'rack-spread',
      scorers: [{ id: 'rack', score: () => 1 }],
    });
    expect(spread.extension).toBe('scheduler');

    const attestor = defineAttestor({
      id: 'join-token',
      version: '1',
      roles: ['node'],
      verify: async () => ({ tenantId: 't', role: 'node' }),
    });
    expect(attestor.extension).toBe('attestor');

    const usage = defineSink({ id: 'usage', kind: 'usage', write: async () => [] });
    expect(usage).toMatchObject({ extension: 'sink', kind: 'usage' });
    expectTypeOf(usage).toEqualTypeOf<UsageSink>();
    expect(Object.isFrozen(usage)).toBe(true);
  });

  it('give server-facing shapes to providers and steps defined in vps and provision', () => {
    const config = manifest({ token: field.secret() });
    const impl: ProviderImpl = {
      listOffers: async () => [],
      create: async (request) => ({
        id: 'm1',
        name: request.name,
        state: 'pending',
        addresses: [],
      }),
      get: async () => undefined,
      delete: async () => undefined,
    };
    const provider: ProviderDefinition<manifest.Infer<typeof config>> = {
      extension: 'provider',
      id: 'acme-cloud',
      version: '1.0.0',
      provides: ['vps'],
      config,
      create: async (account) => (account.token.startsWith('secret://') ? impl : impl),
    };
    const step: StepDefinition<{ level: number }> = {
      extension: 'step',
      id: 'diag.dcgm',
      runsOn: 'ramdisk',
      timeout: '30m',
      retrySafe: true,
      input: manifest({ level: field.int({ min: 1, max: 4 }) }),
      command: 'diag.dcgm',
    };
    expectTypeOf(provider).toExtend<ProviderDefinition>();
    expectTypeOf(step).toExtend<StepDefinition>();
    expectTypeOf([provider, step, echo]).not.toExtend<Extension[]>();
    expectTypeOf([provider, step]).toExtend<Extension[]>();
  });
});
