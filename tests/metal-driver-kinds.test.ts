import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  apiSurface,
  defineDriver,
  field,
  manifest,
  provisionStateTable,
  provisionVerbs,
  targets,
  type DriverConcern,
  type DriverContext,
  type DriverDefinition,
  type DriverKinds,
  type PowerAction,
  type PowerState,
  type SecretRef,
} from '@better-compute/core';
import {
  metalDriverKinds,
  metalVerbs,
  metalVerbTransitions,
  type BiosDriver,
  type BootDriver,
  type ConsoleDriver,
  type DeployDriver,
  type FirmwareDriver,
  type InspectDriver,
  type ManagementDriver,
  type MetalDriverKind,
  type PowerDriver,
  type RaidDriver,
  type VirtualMediaDriver,
} from '@better-compute/metal';
import type { NodeInventory } from '@better-compute/protocol';

// Type assertions here are checked by tsc (vitest only runs the file); importing
// @better-compute/metal is what merges its kinds into DriverKinds. tests/stubs-driver-kinds.test.ts
// proves that a program without it rejects the same driver.

const context = {} as DriverContext;

describe('metal driver kinds', () => {
  it('are merged into DriverKinds by importing @better-compute/metal', () => {
    expectTypeOf<DriverKinds['power']>().toEqualTypeOf<PowerDriver>();
    expectTypeOf<DriverKinds['management']>().toEqualTypeOf<ManagementDriver>();
    expectTypeOf<DriverKinds['boot']>().toEqualTypeOf<BootDriver>();
    expectTypeOf<DriverKinds['deploy']>().toEqualTypeOf<DeployDriver>();
    expectTypeOf<DriverKinds['inspect']>().toEqualTypeOf<InspectDriver>();
    expectTypeOf<DriverKinds['virtual-media']>().toEqualTypeOf<VirtualMediaDriver>();
    expectTypeOf<DriverKinds['console']>().toEqualTypeOf<ConsoleDriver>();
    expectTypeOf<DriverKinds['bios']>().toEqualTypeOf<BiosDriver>();
    expectTypeOf<DriverKinds['raid']>().toEqualTypeOf<RaidDriver>();
    expectTypeOf<DriverKinds['firmware']>().toEqualTypeOf<FirmwareDriver>();
    expectTypeOf<MetalDriverKind>().toExtend<keyof DriverKinds>();
    expectTypeOf<MetalDriverKind>().toExtend<DriverConcern>();
    expectTypeOf<ReturnType<InspectDriver['inspect']>>().toEqualTypeOf<Promise<NodeInventory>>();
  });

  it('list the kinds this package adds with the phase of their built-in drivers', () => {
    expect(metalDriverKinds).toEqual({
      power: 'v0.2',
      management: 'v0.2',
      boot: 'v0.2',
      deploy: 'v0.2',
      inspect: 'v0.2',
      'virtual-media': 'v0.2',
      console: 'v0.3',
      bios: 'v0.5',
      raid: 'v0.5',
      firmware: 'v0.5',
    });
    expect(Object.isFrozen(metalDriverKinds)).toBe(true);
  });

  it('let one driver implement several kinds (an Ironic hardware type)', async () => {
    const redfish = defineDriver({
      id: 'redfish',
      version: '1.0.0',
      runsOn: 'site',
      config: manifest({ address: field.url(), credentials: field.secret() }),
      implements: {
        power: () => ({ getPower: async () => 'on', setPower: async () => undefined }),
        management: () => ({ setBootDevice: async () => undefined }),
        'virtual-media': () => ({ insert: async () => undefined, eject: async () => undefined }),
      },
      retrySafe: { power: ['getPower', 'setPower'], management: ['setBootDevice'] },
    });
    expect(redfish.extension).toBe('driver');
    expectTypeOf(redfish).toEqualTypeOf<
      DriverDefinition<
        { address: string; credentials: SecretRef },
        'power' | 'management' | 'virtual-media'
      >
    >();
    const power = await redfish.implements.power(
      { address: 'https://bmc.test', credentials: 'secret://bmc' },
      context,
    );
    expectTypeOf(power).toEqualTypeOf<PowerDriver>();
    expectTypeOf(power.getPower).returns.toEqualTypeOf<Promise<PowerState>>();
    expectTypeOf(power.setPower).parameter(0).toEqualTypeOf<PowerAction>();
    expect(await power.getPower()).toBe('on');
  });

  it('reject operations of the wrong shape', () => {
    const maybe = { getPower: async () => 'maybe' as const, setPower: async () => undefined };
    defineDriver({
      id: 'bad-power',
      version: '1.0.0',
      runsOn: 'site',
      config: manifest({}),
      implements: {
        // @ts-expect-error: getPower resolves to on, off or unknown
        power: () => maybe,
      },
    });
    defineDriver({
      id: 'bad-kind',
      version: '1.0.0',
      runsOn: 'site',
      config: manifest({}),
      implements: {
        // @ts-expect-error: no imported package declares this kind
        'metal-test-no-such-kind': () => ({}),
      },
    });
  });
});

describe('metal verbs', () => {
  const rows = apiSurface.filter((row) => row.group === 'metal');

  it('are the metal methods of the §9.2 table', () => {
    expect([...metalVerbs]).toEqual(rows.map((row) => row.method));
    for (const row of rows) {
      expect(row.module).toBe('metal');
      expect(row.action).toBe(
        row.method === 'power' ? 'compute:nodes:power' : 'compute:nodes:provision',
      );
      expect(row.resource).toBe(row.method === 'enroll' || row.method === 'bulk' ? 'pool' : 'node');
    }
  });

  it('map onto verbs of the provision state table that some state allows', () => {
    expect(Object.keys(metalVerbTransitions)).toEqual([...metalVerbs]);
    for (const [method, verb] of Object.entries(metalVerbTransitions)) {
      if (verb === null) {
        // enroll creates the node, power is its own axis, bulk applies the verb it names.
        expect(['enroll', 'power', 'bulk']).toContain(method);
        continue;
      }
      expect(provisionVerbs).toContain(verb);
      expect(
        provisionStateTable.states.some(
          (state) => targets(provisionStateTable, state, verb).length,
        ),
        method,
      ).toBe(true);
    }
    expect(provisionStateTable.initial).toContain('enrolling');
    expect(targets(provisionStateTable, 'deployed', metalVerbTransitions.undeploy!)).toEqual([
      'releasing',
    ]);
  });
});
