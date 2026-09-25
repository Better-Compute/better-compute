import { describe, expect, it } from 'vitest';
import { createDeployment, settledCommandOwner, unconfiguredIam } from '@better-compute/cli';
import { pglite } from '@better-compute/postgres/pglite';

// The gateway's commandOwner as `serve` hosts compose it: a settled command wakes the reconciler named by its
// idempotency key (`<reconciler>:<key>:…`), only when that reconciler runs here, never a built-in job or `node`.

describe('settledCommandOwner', () => {
  it('maps idempotency keys to registered reconcilers only', async () => {
    const deployment = createDeployment(
      {
        database: pglite(),
        iam: unconfiguredIam(),
        secret: 'better-compute-command-owner-test-secret-0123',
        baseURL: 'http://127.0.0.1:3000',
        rootTenantId: 'root',
      },
      'test',
    );
    try {
      await deployment.compute.initialize();
      const owner = settledCommandOwner(deployment.compute);
      const registered = Object.keys(deployment.compute.jobs).find(
        (name) => !['command-sweeper', 'outbox-dispatch', 'event-subscribers', 'node'].includes(name),
      )!;
      expect(owner(`${registered}:key_1:attempt-1`)).toEqual({ kind: registered, key: 'key_1' });
      expect(owner('command-sweeper:x:1')).toBeUndefined();
      expect(owner('node:node_1:1')).toBeUndefined();
      expect(owner('not-a-reconciler:x:1')).toBeUndefined();
      expect(owner('no-separator')).toBeUndefined();
    } finally {
      await deployment.close();
    }
  });
});
