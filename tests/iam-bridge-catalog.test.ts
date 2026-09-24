import { describe, expect, it } from 'vitest';
import {
  apiSurface,
  computeActions,
  computeResourceTypes,
  defineModule,
  definePlugin,
  isComputeError,
} from '@better-compute/core';
import { buildComputeCatalog } from '@better-compute/iam';
import { computeCatalog as planCatalog } from './support/iam.js';

// The catalog compute installs on every IAM host (PLAN.md §12.3): core's normative types, merged with
// module and plugin catalogs.

function configError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isComputeError(error, 'INVALID_CONFIG')) return error.message;
    throw error;
  }
  throw new Error('expected INVALID_CONFIG');
}

describe('buildComputeCatalog', () => {
  it('is the §12.3 catalog verbatim by default, and holds every §9.2 action', () => {
    const catalog = buildComputeCatalog();
    expect(catalog.typePrefix).toBe('compute-');
    const shape = (types: Record<string, { actions?: string[] }>) =>
      Object.fromEntries(
        Object.entries(types).map(([type, { actions, ...rest }]) => [
          type,
          { ...rest, actions: [...(actions ?? [])].sort() },
        ]),
      );
    const { resourceTypes } = catalog;
    const withoutDescriptions = Object.fromEntries(
      Object.entries(resourceTypes).map(([type, { description: _d, ...rest }]) => [type, rest]),
    );
    expect(shape(withoutDescriptions)).toEqual(shape(planCatalog()));
    expect(catalog.actions).toEqual([]);
    expect(catalog.allActions().sort()).toEqual([...computeActions].sort());
    for (const row of apiSurface)
      if (row.action) expect(catalog.has(row.action), row.action).toBe(true);
    expect(catalog.has('compute:nope:read')).toBe(false);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it('applies a prefix to types and parents', () => {
    const catalog = buildComputeCatalog({ typePrefix: 'gpu-' });
    expect(Object.keys(catalog.resourceTypes)).toEqual(Object.keys(computeResourceTypes('gpu-')));
    expect(catalog.resourceTypes['gpu-node']!.parent).toBe('gpu-pool');
    expect(configError(() => buildComputeCatalog({ typePrefix: 'Bad Prefix' }))).toMatch(/prefix/);
  });

  it('merges module catalogs: new types, and actions/attributes/relations added to existing ones', () => {
    const metalish = defineModule({
      name: 'metal',
      catalog: {
        actions: ['compute:metal:bulk-import'],
        resourceTypes: {
          node: {
            actions: ['compute:nodes:rescue'],
            attributes: { bmcVendor: 'string', gpuCount: 'number' },
            relations: ['operator', 'auditor'],
          },
          bmc: { parent: 'node', actions: ['compute:bmc:read'], attributes: { vendor: 'string' } },
        },
      },
    });
    const catalog = buildComputeCatalog({ modules: [metalish] });
    const node = catalog.resourceTypes['compute-node']!;
    expect(node.actions).toContain('compute:nodes:rescue');
    expect(node.actions).toContain('compute:nodes:read');
    expect(node.attributes).toMatchObject({
      bmcVendor: 'string',
      gpuCount: 'number',
      trust: 'string',
    });
    expect(node.relations).toEqual(['operator', 'auditor']);
    expect(catalog.resourceTypes['compute-bmc']).toEqual({
      parent: 'compute-node',
      actions: ['compute:bmc:read'],
      attributes: { vendor: 'string' },
    });
    expect(catalog.actions).toEqual(['compute:metal:bulk-import']);
    expect(catalog.has('compute:metal:bulk-import')).toBe(true);
    expect(catalog.has('compute:bmc:read')).toBe(true);
    // The input is not mutated, and core's catalog is untouched.
    expect(computeResourceTypes()['compute-node']!.actions).not.toContain('compute:nodes:rescue');
  });

  it('confines plugin actions to compute:<id>:*', () => {
    const good = definePlugin({
      id: 'acme-autoinstall',
      catalog: {
        resourceTypes: { 'acme-job': { actions: ['compute:acme-autoinstall:run'] } },
      },
    });
    expect(buildComputeCatalog({ plugins: [good] }).has('compute:acme-autoinstall:run')).toBe(true);
    const sneaky = definePlugin({ id: 'acme', catalog: { actions: ['compute:nodes:ssh-root'] } });
    expect(configError(() => buildComputeCatalog({ plugins: [sneaky] }))).toMatch(
      /must start with compute:acme:/,
    );
    const typed = definePlugin({
      id: 'acme',
      catalog: { resourceTypes: { node: { actions: ['compute:nodes:ssh-root'] } } },
    });
    expect(configError(() => buildComputeCatalog({ plugins: [typed] }))).toMatch(/compute:acme:/);
  });

  it('rejects conflicts, invalid names and limit breaches', () => {
    const extra = (resourceTypes: Record<string, object>, actions?: string[]) => () =>
      buildComputeCatalog({ extra: [{ resourceTypes, ...(actions ? { actions } : {}) }] });
    expect(configError(extra({ node: { attributes: { gpuCount: 'string' } } }))).toMatch(
      /gpuCount is number, not string/,
    );
    expect(configError(extra({ node: { parent: 'site' } }))).toMatch(/parent compute-pool/);
    expect(configError(extra({ widget: { parent: 'gadget' } }))).toMatch(/not in the catalog/);
    expect(configError(extra({ widget: { actions: ['nodes:read'] } }))).toMatch(/invalid action/);
    expect(configError(extra({}, ['compute:Bad:x']))).toMatch(/invalid action/);
    expect(configError(extra({ widget: { attributes: { size: 'date' } } }))).toMatch(
      /invalid type/,
    );
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a${i}`, 'string']));
    expect(configError(extra({ widget: { attributes: many } }))).toMatch(/more than 64 attributes/);
    const relations = Array.from({ length: 33 }, (_, i) => `r${i}`);
    expect(configError(extra({ widget: { relations } }))).toMatch(/more than 32 relations/);
    expect(configError(extra({ ['x'.repeat(60)]: {} }))).toMatch(/longer than 64/);
  });
});
