import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  apiSurface,
  isComputeError,
  newId,
  type ApiOf,
  type ComputeModule,
  type InventorySnapshot,
  type MethodInput,
  type MethodOutput,
  type ModuleContext,
} from '@better-compute/core';
import {
  inventoryChangeTypes,
  inventoryModule,
  isNodeConditionType,
  nodeConditionTypes,
  type InventoryApi,
  type InventoryDiff,
  type InventoryNodeInput,
} from '@better-compute/inventory';

const api = inventoryModule.api!({} as ModuleContext);
const rows = apiSurface.filter((row) => row.group === 'inventory');
const input = { tenantId: 'ten_acme', nodeId: newId('node') };

describe('inventoryModule', () => {
  it('is the frozen built-in module named inventory, with no catalog fragment', () => {
    expect(inventoryModule.name).toBe('inventory');
    expect(Object.isFrozen(inventoryModule)).toBe(true);
    expect(inventoryModule.catalog).toBeUndefined();
    expect(Object.keys(api)).toEqual(['inventory']);
    expectTypeOf(inventoryModule).toExtend<ComputeModule<'inventory'>>();
    expectTypeOf<ApiOf<typeof inventoryModule>>().toEqualTypeOf<InventoryApi>();
  });

  it('declares exactly the inventory rows of the §9.2 table', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(api.inventory).sort()).toEqual(rows.map((row) => row.method).sort());
    for (const row of rows) {
      const method = api.inventory[row.method as keyof InventoryApi['inventory']];
      expect(row.module).toBe('inventory');
      expect(method.action).toBe(row.action);
      expect(method.kind).toBe(row.kind);
      expect(method.resource(input)).toEqual({ type: row.resource, id: input.nodeId });
    }
  });

  it('validates input strictly before any handler runs', () => {
    const { get } = api.inventory;
    expect(get.validate(input)).toEqual(input);
    for (const bad of [
      undefined,
      {},
      { tenantId: 'ten_acme' },
      { ...input, extra: true },
      { ...input, nodeId: 'pool_01j9zzzzzzzzzzzzzzzzzzzzzz' },
      { ...input, nodeId: 'node_not-an-id' },
      { ...input, tenantId: '' },
      { ...input, tenantId: 'has space' },
    ]) {
      let error: unknown;
      try {
        get.validate(bad);
      } catch (caught) {
        error = caught;
      }
      expect(isComputeError(error, 'INVALID_INPUT'), JSON.stringify(bad)).toBe(true);
    }
  });

  it('types its methods', () => {
    expectTypeOf<
      MethodInput<InventoryApi['inventory']['get']>
    >().toEqualTypeOf<InventoryNodeInput>();
    expectTypeOf<
      MethodOutput<InventoryApi['inventory']['get']>
    >().toEqualTypeOf<InventorySnapshot>();
    expectTypeOf<MethodOutput<InventoryApi['inventory']['diff']>>().toEqualTypeOf<InventoryDiff>();
  });
});

describe('condition and change types', () => {
  it('list the §10.1 table once each', () => {
    expect(new Set(nodeConditionTypes).size).toBe(nodeConditionTypes.length);
    for (const type of ['GpuCountMismatch', 'GpuModelUnknown', 'Xid79', 'ClockSkew'])
      expect(isNodeConditionType(type)).toBe(true);
    expect(isNodeConditionType('NodeUnreachable')).toBe(false);
    expect(isNodeConditionType('toString')).toBe(false);
    expect(inventoryChangeTypes).toEqual([
      'gpu.missing',
      'gpu.added',
      'disk.replaced',
      'driver.changed',
      'mig.layout.changed',
    ]);
  });
});
