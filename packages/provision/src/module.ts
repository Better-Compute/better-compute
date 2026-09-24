import { notImplemented, type ComputeModule } from '@better-compute/core';

/**
 * The provision module: the workflow engine, the `profiles`, `images` and `workflows` groups,
 * config units, renderers and the image catalog (§11.2, §11.5). Injected by the application; the
 * server never imports it.
 *
 * @throws `NOT_IMPLEMENTED` until v0.2.
 */
export function provisionModule(): ComputeModule<'provision'> {
  throw notImplemented('workflow engine', 'v0.2');
}
