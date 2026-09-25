import { afterEach, describe, expect, it } from 'vitest';
import { shardOf } from '@better-compute/core';
import { CommandBodySchema, decodeMessage } from '@better-compute/protocol';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';

// Trace context (§14): a valid W3C `traceparent` on an API request reaches the commands the method
// enqueues (CommandBody.traceparent, which the daemon continues); an invalid one is dropped.

afterEach(closeFixtures);

const SITE = 'site_trace';
const NODE = 'node_01k5w00000000000000000trc1';
const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

async function setup() {
  const fixture = await computeFixture({ clock: 'sim' });
  const root = fixture.tenants.root;
  await fixture.database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-1', 1)`,
    [SITE, root.id],
  );
  await fixture.database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_trace', $1, $2, 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [root.id, SITE],
  );
  await fixture.database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
       next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, 'pool_trace', $3, 'host', 'adopted', false, false, 'connected', 'platform',
       '{}', 1, 1, 1, 1, $4, 1)`,
    [NODE, SITE, root.id, shardOf(NODE)],
  );
  await fixture.database.query('INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)', [
    NODE,
  ]);
  await fixture.database.query(
    "INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, $2, '{}')",
    [NODE, root.id],
  );
  fixture.iam.allow({ token: root.token });
  return fixture;
}

async function run(fixture: ComputeFixture, key: string, traceparent?: string) {
  const response = await fixture.compute.handler(
    new Request(`${fixture.compute.endpoint.origin}${fixture.compute.endpoint.basePath}/commands/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-better-compute': '1',
        authorization: `Bearer ${fixture.tenants.root.token}`,
        ...(traceparent !== undefined ? { traceparent } : {}),
      },
      body: JSON.stringify({
        tenantId: fixture.tenants.root.id,
        nodeId: NODE,
        kind: 'inventory.refresh',
        payload: { sections: ['gpus'] },
        idempotencyKey: key,
      }),
    }),
  );
  const { data, error } = (await response.json()) as { data?: { id: string }; error?: unknown };
  if (!data) throw new Error(`commands/run failed: ${JSON.stringify(error)}`);
  const { rows } = await fixture.database.query<{ body: Uint8Array }>(
    'SELECT body FROM commands WHERE id = $1',
    [data.id],
  );
  return decodeMessage(CommandBodySchema, new Uint8Array(rows[0]!.body)).traceparent;
}

describe('traceparent', () => {
  it('travels from the API request into the commands it enqueues, and only when valid', async () => {
    const fixture = await setup();
    expect(await run(fixture, 'trace-1', TRACE)).toBe(TRACE);
    expect(await run(fixture, 'trace-2')).toBe('');
    // Malformed, an unknown version, all-zero ids: dropped, the command still runs.
    for (const [index, bad] of [
      'not-a-trace',
      '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
    ].entries())
      expect(await run(fixture, `trace-bad-${index}`, bad)).toBe('');
  });
});
