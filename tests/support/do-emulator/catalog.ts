import type { DoEmulator } from './index.js';

// The catalog endpoints: `GET /v2/sizes` and `GET /v2/regions`, paged, over the fixture-seeded
// `state.sizes` and `state.regions`. A test changes availability by editing those arrays.

export function registerCatalog(emulator: DoEmulator): void {
  emulator.route('GET', /^\/regions$/, (context) =>
    emulator.paged(context, 'regions', context.state.regions),
  );
  emulator.route('GET', /^\/sizes$/, (context) =>
    emulator.paged(context, 'sizes', context.state.sizes),
  );
}
