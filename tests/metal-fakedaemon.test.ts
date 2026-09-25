import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComputeError, field, manifest } from '@better-compute/core';
import { httpViaSite, metal } from '@better-compute/metal';
import { defineProfile, defineStep, provisionModule, stepNotReady } from '@better-compute/provision';
import { createDevStack, type DevStack } from '@better-compute/testing';
import { fakeMetalSite, type FakeMetalSite } from './support/metal-fake-site.js';

// Metal on the dev stack (PLAN.md §3.5, §5.6 walkthrough 3): the real control plane (betterCompute
// with provision + metal, workers, JoinService), the real gateway, and a site agent that is a
// FakeDaemon (role site, joined with a site token) in front of simulated BMCs. An agentless (Talos)
// machine is enrolled, commissioned, deployed and released entirely out of band, every command
// crossing the gateway to the site agent and back.

const talosReady = defineStep({
  id: 'wait.talosReady',
  runsOn: 'control-plane',
  relays: ['site'],
  timeout: '20m',
  retrySafe: true,
  input: manifest({ port: field.int({ min: 1, max: 65535 }).default(50000) }),
  async run(input, context) {
    const rows = await context.sql.query<{ addresses: string[] }>('SELECT addresses FROM metal_nodes WHERE node_id = $1', [context.node!.id]);
    const address = rows.rows[0]?.addresses[0];
    if (!address) throw new ComputeError('INVALID_STATE', 'no address');
    const response = await httpViaSite(context, { url: `https://${address}:${input.port}/machine/version`, tlsSpkiSha256: 'ab'.repeat(32), poll: true });
    if (response.status !== 200) throw stepNotReady(500);
    return { talos: response.json<{ version: string }>().version };
  },
});
const talos = defineProfile({
  id: 'talos-1.8',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [
    { use: 'media.insert', on: 'site', with: { url: 'https://cache.site/talos-1.8.iso' } },
    { use: 'management.setBootDevice', on: 'site', with: { device: 'cd' } },
    { use: 'power.setPower', on: 'site', with: { action: 'cycle' } },
    { use: 'wait.talosReady' },
  ],
});

let stack: DevStack;
let world: FakeMetalSite;
let poolId: string;
let siteId: string;

beforeAll(async () => {
  const bareMetal = metal();
  stack = await createDevStack({
    modules: [provisionModule({ modules: [bareMetal], steps: [talosReady], profiles: [talos] }), bareMetal],
  });
  const api = stack.compute.api as any;
  ({ siteId } = await stack.createPool({ key: 'metal' }));
  const pool = await api.pools.create(stack.root, {
    tenantId: stack.rootTenantId,
    siteId,
    class: 'metal-host',
    agent: 'none',
    policy: { allowUnverifiedRelease: true, provisioningCidrs: ['10.30.0.0/16'] },
    idempotencyKey: 'talos-pool',
  });
  poolId = pool.id;
  world = fakeMetalSite();
  await stack.joinSite({ siteId, kinds: world.kinds });
}, 90_000);
afterAll(() => stack?.close());

const state = async (id: string) =>
  (await stack.database.query<{ provision_state: string; role: string }>('SELECT provision_state, role FROM nodes WHERE id = $1', [id])).rows[0]!;
async function until(id: string, want: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { provision_state } = await state(id);
    if (provision_state === want) return;
    if (provision_state === 'failed' || Date.now() > deadline) {
      const error = await stack.database.query('SELECT last_error FROM metal_nodes WHERE node_id = $1', [id]);
      const commands = await stack.database.query('SELECT kind, node_id, state, reason FROM commands ORDER BY seq');
      const workflows = await stack.database.query('SELECT profile_id, state, step_id, error FROM workflows WHERE node_id = $1', [id]);
      throw new Error(
        `${id} is ${provision_state}, wanted ${want}: ${JSON.stringify(error.rows[0])} commands=${JSON.stringify(commands.rows)} workflows=${JSON.stringify(workflows.rows)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('metal on FakeDaemon site agents, through the real gateway', () => {
  it('enrolls, commissions, deploys Talos and releases an agentless machine out of band', async () => {
    const machine = world.machine('https://10.20.0.5', { macs: ['52:54:00:aa:bb:01'], ipAddresses: ['10.30.1.7'] });
    machine.api = (url) =>
      machine.bootDevice === 'cd' && machine.mounted.includes('talos') && machine.power === 'on' && url.pathname === '/machine/version'
        ? { status: 200, body: '{"version":"v1.8.3"}' }
        : undefined;
    const api = stack.compute.api as any;
    const enrolled = await api.metal.enroll(stack.root, {
      tenantId: stack.rootTenantId,
      siteId,
      poolId,
      bmc: { address: 'https://10.20.0.5', driver: 'redfish', credentials: 'secret://tenant-root/bmc-1' },
    });
    await until(enrolled.nodeId, 'ready');
    const addresses = await stack.database.query<{ addresses: string[] }>('SELECT addresses FROM metal_nodes WHERE node_id = $1', [enrolled.nodeId]);
    expect(addresses.rows[0]!.addresses).toEqual(['10.30.1.7']);

    await api.metal.deploy(stack.root, { tenantId: stack.rootTenantId, nodeId: enrolled.nodeId, profileId: 'talos-1.8', profileVersion: 1 });
    await until(enrolled.nodeId, 'deployed');
    expect(world.seen.map((entry) => `${entry.kind}:${entry.operation}`)).toEqual(
      expect.arrayContaining([
        'bmc.query:power.getPower',
        'bmc.query:inspect.inspect',
        'bmc.boot:virtual-media.insert',
        'bmc.boot:management.setBootDevice',
        'bmc.power:power.setPower',
        'site.httpProxy:https://10.30.1.7:50000/machine/version',
      ]),
    );

    await api.metal.undeploy(stack.root, { tenantId: stack.rootTenantId, nodeId: enrolled.nodeId });
    await until(enrolled.nodeId, 'ready');
    expect(machine.mounted).toBe('');
    expect(machine.power).toBe('off');
    // Every metal command went through the gateway to the site agent and came back succeeded.
    const { rows } = await stack.database.query<{ kind: string; state: string }>(
      `SELECT kind, state FROM commands WHERE kind LIKE 'bmc.%' OR kind = 'site.httpProxy'`,
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((row) => row.state === 'succeeded')).toBe(true);
  }, 120_000);
});
