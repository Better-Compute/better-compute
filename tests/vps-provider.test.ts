import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineDriver,
  field,
  isComputeError,
  manifest,
  type CallContext,
  type ComputeError,
  type DriverContext,
  type DriverKinds,
  type Extension,
  type InstanceSpec,
  type ProviderContext,
  type SecretRef,
} from '@better-compute/core';
import {
  defineProvider,
  type ProviderDefinition,
  type ProviderImpl,
  type RuntimeDriver,
  type RuntimeInstanceStatus,
} from '@better-compute/vps';

const config = manifest({
  token: field.secret().describe('API token'),
  location: field.option(['fsn1', 'nbg1', 'hel1']).default('fsn1'),
});
type Config = manifest.Infer<typeof config>;

const client: ProviderImpl = {
  listOffers: async () => [],
  create: async (request, context) => ({
    id: context.idempotencyKey,
    name: request.name,
    state: 'pending',
    addresses: [],
  }),
  get: async () => undefined,
  delete: async () => undefined,
};

function configError(run: () => unknown): ComputeError {
  try {
    run();
  } catch (error) {
    if (isComputeError(error, 'INVALID_CONFIG')) return error;
    throw error;
  }
  throw new Error('expected INVALID_CONFIG');
}

describe('defineProvider', () => {
  it('declares a provider whose accounts are validated by its manifest', async () => {
    const acme = defineProvider({
      id: 'acme-cloud',
      version: '1.0.0',
      provides: ['vps'],
      config,
      capabilities: ['rescue'],
      create: (account) => (account.location === 'fsn1' ? client : client),
    });
    expect(acme.extension).toBe('provider');
    expect(Object.isFrozen(acme)).toBe(true);
    expectTypeOf(acme).toEqualTypeOf<ProviderDefinition<Config>>();
    expectTypeOf(acme).toExtend<Extension>();
    expectTypeOf(acme.create)
      .parameter(0)
      .toEqualTypeOf<{ token: SecretRef; location: 'fsn1' | 'nbg1' | 'hel1' }>();
    const impl = await acme.create(config.parse({ token: 'secret://acme' }), {} as ProviderContext);
    const machine = await impl.create(
      { offerId: 'cx22', image: 'ubuntu-24.04', userData: '', name: 'web-1' },
      { idempotencyKey: 'inst_1' } as CallContext,
    );
    expect(machine).toMatchObject({ id: 'inst_1', name: 'web-1', state: 'pending' });
  });

  const base = {
    id: 'acme-cloud',
    version: '1.0.0',
    provides: ['vps', 'metal'],
    config,
    create: () => client,
  };
  const invalid: [label: string, change: Record<string, unknown>, path: string][] = [
    ['an upper-case id', { id: 'Acme' }, 'id'],
    ['a missing version', { version: undefined }, 'version'],
    ['nothing provided', { provides: [] }, 'provides'],
    ['an unknown kind', { provides: ['cloud'] }, 'provides'],
    ['a repeated kind', { provides: ['vps', 'vps'] }, 'provides'],
    ['a config that is not a schema', { config: { token: 'x' } }, 'config'],
    ['an empty capability', { capabilities: [''] }, 'capabilities'],
    ['no create', { create: undefined }, 'create'],
    ['a misspelt field', { provide: ['vps'] }, 'provide'],
  ];
  it.each(invalid)('rejects %s', (_label, change, path) => {
    const error = configError(() => defineProvider({ ...base, ...change } as never));
    expect(error.details).toEqual({ path });
    expect(error.message).toMatch(/^Provider /);
  });

  it('rejects values that are not objects', () => {
    expect(configError(() => defineProvider(undefined as never)).message).toBe(
      'Provider: must be an object',
    );
  });
});

describe('runtime driver kind', () => {
  it('is merged into DriverKinds by importing @better-compute/vps', async () => {
    expectTypeOf<DriverKinds['runtime']>().toEqualTypeOf<RuntimeDriver>();
    const status: RuntimeInstanceStatus = { id: 'inst_1', state: 'running', addresses: [] };
    const kvm = defineDriver({
      id: 'libvirt-kvm',
      version: '1.0.0',
      runsOn: 'node',
      config: manifest({ uri: field.string().default('qemu:///system') }),
      implements: {
        runtime: () => ({
          traits: {
            isolation: 'vm',
            multiTenant: true,
            gpuPassthrough: true,
            imageFormats: ['qcow2', 'raw'],
          },
          list: async () => [status],
          apply: async (spec) => ({ ...status, id: spec.id }),
          reboot: async () => undefined,
          remove: async () => undefined,
        }),
      },
    });
    const runtime = await kvm.implements.runtime({ uri: 'qemu:///system' }, {} as DriverContext);
    expectTypeOf(runtime.apply).parameter(0).toEqualTypeOf<InstanceSpec>();
    expect(runtime.traits.isolation).toBe('vm');
    expect(await runtime.list()).toEqual([status]);
  });

  it('rejects traits of the wrong shape', () => {
    const jail = {
      traits: {
        isolation: 'jail' as const,
        multiTenant: false,
        gpuPassthrough: false,
        imageFormats: [],
      },
      list: async () => [],
      apply: async () => ({ id: 'x', state: 'running' as const, addresses: [] }),
      reboot: async () => undefined,
      remove: async () => undefined,
    };
    defineDriver({
      id: 'bad-runtime',
      version: '1.0.0',
      runsOn: 'node',
      config: manifest({}),
      implements: {
        // @ts-expect-error: isolation is vm, microvm or container
        runtime: () => jail,
      },
    });
  });
});
