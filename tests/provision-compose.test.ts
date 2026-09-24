import { describe, expect, it } from 'vitest';
import { metal } from '@better-compute/metal';
import { provisionModule } from '@better-compute/provision';
import { createRegistry } from '../packages/server/src/registry.js';

// provisionModule({ modules: [m] }) resolves m's steps and profiles in its engine, but m still
// registers them itself: composing both in one server must not register anything twice.

describe('provision composed with the modules it borrows steps from', () => {
  it('registers each step once, whether or not provision was told about metal', () => {
    const bareMetal = metal();
    const provision = provisionModule({ modules: [bareMetal] });
    const registry = createRegistry({
      core: {},
      modules: [provision, bareMetal],
      plugins: [],
      extensions: [],
      context: () => ({}) as never,
    });
    const steps = registry.extensions.filter((extension) => extension.extension === 'step').map((step) => step.id);
    expect(new Set(steps).size).toBe(steps.length);
    for (const step of bareMetal.extensions ?? []) if (step.extension === 'step') expect(steps).toContain(step.id);
    // The engine still resolves metal's steps.
    for (const step of bareMetal.extensions ?? [])
      if (step.extension === 'step') expect(provision.engineOptions.steps.get(step.id)).toBe(step);
    // And provision re-exports none of metal's profiles.
    const metalProfiles = new Set(bareMetal.profiles ?? []);
    expect((provision.profiles ?? []).some((profile) => metalProfiles.has(profile))).toBe(false);
  });
});
