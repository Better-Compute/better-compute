import { describe, expect, expectTypeOf, it } from 'vitest';
import { apiSurface, newId, type ComputeModule, type ModuleContext } from '@better-compute/core';
import * as inventory from '@better-compute/inventory';
import * as metalPackage from '@better-compute/metal';
import * as provision from '@better-compute/provision';
import * as vpsPackage from '@better-compute/vps';
import * as umbrellaInventory from 'better-compute/inventory';
import * as umbrellaMetal from 'better-compute/metal';
import * as umbrellaProvision from 'better-compute/provision';
import * as umbrellaVps from 'better-compute/vps';

const { metal } = metalPackage;
const { vps } = vpsPackage;
const { provisionModule } = provision;

describe('module factories of the P0 stubs', () => {
  // The metal control plane landed in v0.2 (tests/metal-*.test.ts).
  it('metal() returns the metal module', () => {
    const module = metal({ hardwareProfiles: {} });
    expect(module.name).toBe('metal');
    expectTypeOf(module).toExtend<ComputeModule<'metal'>>();
  });

  // The VPS control plane landed in v0.3 (tests/vps-*.test.ts).
  it('vps() returns the vps module', () => {
    const module = vps({ runtimes: ['libvirt-kvm'] });
    expect(module.name).toBe('vps');
    expectTypeOf(module).toExtend<ComputeModule<'vps'>>();
  });

  // The workflow engine landed ahead of the rest of v0.2 (tests/provision-*.test.ts).
  it('provisionModule() returns the provision module', () => {
    const module = provisionModule();
    expect(module.name).toBe('provision');
    expectTypeOf(module).toExtend<ComputeModule<'provision'>>();
  });
});

describe('inventoryModule', () => {
  const api = inventory.inventoryModule.api!({} as ModuleContext);
  const input = { tenantId: 'ten_acme', nodeId: newId('node') };

  // Every inventory method is implemented (tests/inventory-store.test.ts); here only the §9.2 shape.
  it.each(apiSurface.filter((row) => row.group === 'inventory'))('inventory.$method matches its §9.2 row', ({ method, action, kind }) => {
    const definition = api.inventory[method as keyof typeof api.inventory];
    expect([definition.action, definition.kind]).toEqual([action, kind]);
    expect(definition.resource(definition.validate(input))).toEqual({ type: 'node', id: input.nodeId });
  });
});

describe('umbrella subpaths', () => {
  it.each([
    ['better-compute/inventory', umbrellaInventory, inventory],
    ['better-compute/provision', umbrellaProvision, provision],
    ['better-compute/metal', umbrellaMetal, metalPackage],
    ['better-compute/vps', umbrellaVps, vpsPackage],
  ] as const)('%s re-exports its package', (_subpath, umbrella, scoped) => {
    expect(Object.keys(umbrella).sort()).toEqual(Object.keys(scoped).sort());
    for (const [name, value] of Object.entries(scoped))
      expect((umbrella as Record<string, unknown>)[name], name).toBe(value);
  });

  it('carry the implemented helpers', () => {
    expect(typeof umbrellaInventory.normalizeGpuProduct).toBe('function');
    expect(typeof umbrellaProvision.defineStep).toBe('function');
    expect(typeof umbrellaProvision.defineProfile).toBe('function');
    expect(typeof umbrellaVps.defineProvider).toBe('function');
    expect(typeof umbrellaMetal.metal).toBe('function');
  });
});
