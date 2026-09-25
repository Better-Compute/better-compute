import { fileURLToPath } from 'node:url';
import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalDriver, sha256File, type ExternalDriverHost } from '@better-compute/driver-sdk';
import { DriverInvokeResultSchema } from '@better-compute/protocol';
import { defineProfile, provisionModule } from '@better-compute/provision';
import { createDevStack, fakeDriverInvoke, type DevStack } from '@better-compute/testing';

// PLAN.md §16 v0.5 exit: "a third-party TS driver runs on a node via bcx". A driver written with
// defineDriver and served by serveDriver runs as its own process (tests/fixtures/bcx-echo-driver.mjs),
// pinned by sha256, behind the node agent's bcx host. A profile step naming a driver operation
// (`power.getPower`, bound to that driver in the profile) becomes a workflow step, the engine sends
// it as one `driver.invoke` command through the real command queue and gateway, the node runs the
// operation in the plugin, and the step succeeds with the plugin's result.

const fixture = fileURLToPath(new URL('../fixtures/bcx-echo-driver.mjs', import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const profile = defineProfile({
  id: 'bcx-power-check',
  version: 1,
  target: 'metal',
  drivers: { power: { driver: 'echo', config: { endpoint: 'https://bmc.example' } } },
  steps: [
    { use: 'power.getPower', on: 'node' },
    { use: 'power.setPower', on: 'node', with: { action: 'cycle' } },
  ],
});

let host: ExternalDriverHost;
let dev: DevStack;
let nodeId: string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  host = externalDriver({
    command: [process.execPath, fixture],
    sha256: await sha256File(fixture),
    log: silent,
  });
  const drivers = await host.start();
  dev = await createDevStack({
    modules: [provisionModule({ profiles: [profile], remediation: false })],
    daemon: { kinds: { 'driver.invoke': fakeDriverInvoke({ drivers }) } },
  });
  const { poolId } = await dev.createPool({ key: 'bcx' });
  [nodeId] = await dev.join({ poolId, seed: 'bcx' });
  await dev.waitFor([nodeId!], { timeoutMs: 45_000 });
}, 120_000);

afterAll(async () => {
  await dev?.close();
  await host?.close();
});

describe('a third-party TS driver on a node via bcx (§16 v0.5)', () => {
  it('runs a profile step in the plugin through driver.invoke', async () => {
    const context = dev.compute.context as {
      workflows: { start(tx: unknown, input: Record<string, unknown>): Promise<{ id: string }> };
    };
    const { id } = await dev.database.transaction((tx) =>
      context.workflows.start(tx, {
        tenantId: dev.rootTenantId,
        profileId: profile.id,
        profileVersion: profile.version,
        nodeId,
      }),
    );
    let workflow: { state: string } | undefined;
    for (let tries = 0; tries < 400; tries++) {
      const { rows } = await dev.database.query<{ state: string }>(
        'SELECT state FROM workflows WHERE id = $1',
        [id],
      );
      workflow = rows[0];
      if (workflow && ['succeeded', 'failed', 'aborted'].includes(workflow.state)) break;
      await sleep(50);
    }
    expect(workflow?.state).toBe('succeeded');

    const { rows: commands } = await dev.database.query<{
      kind: string;
      state: string;
      result: Uint8Array | null;
      idempotency_key: string;
    }>(
      `SELECT kind, state, result, idempotency_key FROM commands
        WHERE node_id = $1 AND kind = 'driver.invoke' ORDER BY seq`,
      [nodeId],
    );
    expect(commands.map((command) => [command.kind, command.state])).toEqual([
      ['driver.invoke', 'succeeded'],
      ['driver.invoke', 'succeeded'],
    ]);
    expect(commands[0]!.idempotency_key).toBe(`wf:${id}:main.1`);
    // The plugin answered: its power state, over bcx, into the command's DriverInvokeResult.
    const results = commands.map((command) =>
      JSON.parse(fromBinary(DriverInvokeResultSchema, new Uint8Array(command.result!)).resultJson),
    );
    expect(['on', 'off']).toContain(results[0]);
    expect(results[1]).toBeNull();
    // The plugin process served it (one process, still up, pinned).
    expect(host.drivers.map((driver) => driver.id)).toEqual(['echo', 'quiet']);
  }, 60_000);
});
