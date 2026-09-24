import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  newId,
  type ComputeError,
  type MethodContext,
  type ModuleContext,
} from '@better-compute/core';
import { importSpecifiers } from '../scripts/source-scan.mjs';

// The umbrella package (PLAN.md §4.4): the curated root entry and every subpath of umbrella.json,
// imported by their public specifiers, including the four named stub subpaths.

const packageDir = new URL('../packages/better-compute/', import.meta.url);
const umbrella = JSON.parse(readFileSync(new URL('umbrella.json', packageDir), 'utf8')) as {
  subpaths: Record<string, string>;
};
const subpaths = Object.entries(umbrella.subpaths).map(([subpath, specifier]) => ({
  specifier: `better-compute/${subpath.slice(2)}`,
  target: specifier,
}));

/** Imports a module by a specifier computed at run time. */
const load = (specifier: string) => import(/* @vite-ignore */ specifier) as Promise<object>;

/** The NOT_IMPLEMENTED error `run` throws or rejects with. */
async function notImplemented(run: () => unknown): Promise<ComputeError> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  if (!isComputeError(error, 'NOT_IMPLEMENTED'))
    throw new Error(`expected NOT_IMPLEMENTED, got ${String(error)}`);
  return error;
}

describe("the root entry 'better-compute'", () => {
  it('exports exactly the curated values, the same objects as server and core', async () => {
    const root = (await load('better-compute')) as Record<string, unknown>;
    const server = (await load('@better-compute/server')) as Record<string, unknown>;
    const core = (await load('@better-compute/core')) as Record<string, unknown>;
    const fromServer = ['betterCompute', 'configOptions', 'defineConfig'];
    const fromCore = [
      'ComputeError',
      'defineAttestor',
      'defineDriver',
      'defineModule',
      'definePlugin',
      'defineSchedulerPlugin',
      'defineSink',
      'field',
      'manifest',
    ];
    expect(Object.keys(root).sort()).toEqual([...fromServer, ...fromCore].sort());
    for (const name of fromServer) expect(root[name], name).toBe(server[name]);
    for (const name of fromCore) expect(root[name], name).toBe(core[name]);
  });

  it('imports only @better-compute/server and @better-compute/core', () => {
    const source = readFileSync(new URL('src/index.ts', packageDir), 'utf8');
    expect(new Set(importSpecifiers(source))).toEqual(
      new Set(['@better-compute/server', '@better-compute/core']),
    );
  });
});

describe('the subpaths of umbrella.json', () => {
  it('include the four named stub subpaths', () => {
    expect(subpaths.map(({ specifier }) => specifier)).toEqual(
      expect.arrayContaining([
        'better-compute/inventory',
        'better-compute/provision',
        'better-compute/metal',
        'better-compute/vps',
      ]),
    );
  });

  it.each(subpaths)('$specifier resolves and re-exports $target', async ({ specifier, target }) => {
    const module = await load(specifier);
    const scoped = await load(target);
    expect(Object.keys(module).length, `${specifier} exports nothing`).toBeGreaterThan(0);
    expect(Object.keys(module).sort()).toEqual(Object.keys(scoped).sort());
    for (const [name, value] of Object.entries(scoped))
      expect((module as Record<string, unknown>)[name], name).toBe(value);
  });
});

describe('the four named subpaths', () => {
  it('better-compute/metal: metal() builds the metal module', async () => {
    const { metal } = (await load(
      'better-compute/metal',
    )) as typeof import('@better-compute/metal');
    expect(metal().name).toBe('metal');
  });

  it('better-compute/vps: vps() builds the vps module', async () => {
    const { vps } = (await load('better-compute/vps')) as typeof import('@better-compute/vps');
    expect(vps().name).toBe('vps');
  });

  it('better-compute/provision: provisionModule() builds the provision module', async () => {
    const { provisionModule } = (await load(
      'better-compute/provision',
    )) as typeof import('@better-compute/provision');
    expect(provisionModule().name).toBe('provision');
  });

  it('better-compute/inventory: inventoryModule serves the inventory group', async () => {
    const { inventoryModule } = (await load(
      'better-compute/inventory',
    )) as typeof import('@better-compute/inventory');
    expect(inventoryModule.name).toBe('inventory');
    // Behaviour is covered in tests/inventory-*.test.ts; here only the subpath and the §9.2 shape.
    const api = inventoryModule.api!({} as ModuleContext);
    for (const method of ['get', 'history', 'diff'] as const) {
      const definition = api.inventory[method];
      expect(definition.action, method).toBe('compute:nodes:read');
      expect(definition.kind, method).toBe('read');
      const input = definition.validate({ tenantId: 'tenant-acme', nodeId: newId('node') });
      expect(definition.resource(input)).toMatchObject({ type: 'node' });
    }
  });
});
