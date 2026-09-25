import { afterEach, describe, expect, it } from 'vitest';
import { shardOf, type BlobStore } from '@better-compute/core';
import { CommandBodySchema, decodeMessage, unpackCommandPayload } from '@better-compute/protocol';
import { betterCompute, supportBundleKey } from '@better-compute/server';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { sibling } from './support/runtime.js';

// Support bundles (PLAN.md §6, §16 v0.1 "support bundles hold no tokens"): with `supportBundles`,
// `commands.run logs.collect` gives the daemon a presigned PUT for a per-command key and shows that
// key; no credential travels in the command. Without it nothing is presigned.

afterEach(closeFixtures);

const NODE = 'node_01k5w00000000000000000sb01';

async function seed(fixture: ComputeFixture) {
  const root = fixture.tenants.root;
  await fixture.database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_bun', $1, 'shared', 'eu-1', 1)`,
    [root.id],
  );
  await fixture.database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_bun', $1, 'site_bun', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [root.id],
  );
  await fixture.database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
       next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_bun', 'pool_bun', $2, 'host', 'adopted', false, false, 'connected',
       'platform', '{}', 1, 1, 1, 1, $3, 1)`,
    [NODE, root.id, shardOf(NODE)],
  );
  await fixture.database.query(
    'INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)',
    [NODE],
  );
  await fixture.database.query(
    "INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, $2, '{}')",
    [NODE, root.id],
  );
  fixture.iam.allow({ token: root.token });
}

async function payloadOf(fixture: ComputeFixture, commandId: string) {
  const { rows } = await fixture.database.query<{ body: Uint8Array }>(
    'SELECT body FROM commands WHERE id = $1',
    [commandId],
  );
  const body = decodeMessage(CommandBodySchema, new Uint8Array(rows[0]!.body));
  return unpackCommandPayload('logs.collect', body.payload);
}

describe('support bundles', () => {
  it('presign a per-command upload for logs.collect and show its key', async () => {
    const fixture = await computeFixture({ clock: 'sim' });
    await seed(fixture);
    const presigned: { key: string; method: string; expiresInSeconds: number }[] = [];
    const blob: BlobStore = {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => undefined,
      async presign(key, options) {
        presigned.push({ key, ...options });
        return `https://bundles.example/${key}?X-Signature=abc`;
      },
    };
    const compute = await sibling(fixture, { supportBundles: { blob, maxBytes: 1024 * 1024 } });
    const root = { token: fixture.tenants.root.token };
    const run = (idempotencyKey: string) =>
      compute.api.commands.run(root, {
        tenantId: fixture.tenants.root.id,
        nodeId: NODE,
        kind: 'logs.collect',
        payload: { sinceSeconds: 3600 },
        idempotencyKey,
      });
    const command = await run('bundle-1');
    expect(command.bundleKey).toMatch(
      new RegExp(`^support-bundles/${NODE}/[A-Za-z0-9._-]+\\.bundle$`),
    );
    expect(presigned).toEqual([
      { key: command.bundleKey, method: 'PUT', expiresInSeconds: 600 + 900 },
    ]);
    const payload = await payloadOf(fixture, command.id);
    expect(payload).toMatchObject({
      uploadUrl: `https://bundles.example/${command.bundleKey}?X-Signature=abc`,
      lookbackSeconds: 3600,
      maxBytes: 1048576n,
      supportBundle: true,
    });
    // A retry replays the command without presigning again; get and list show the same key.
    expect((await run('bundle-1')).id).toBe(command.id);
    expect(presigned).toHaveLength(1);
    const shown = await compute.api.commands.get(root, {
      tenantId: fixture.tenants.root.id,
      nodeId: NODE,
      commandId: command.id,
    });
    expect(shown.bundleKey).toBe(command.bundleKey);
    expect(supportBundleKey(NODE, 'api:x/y')).toBe(`support-bundles/${NODE}/x_y.bundle`);
    await compute.stop();
  });

  it('presign nothing without supportBundles, and refuse a store that cannot presign', async () => {
    const fixture = await computeFixture({ clock: 'sim' });
    await seed(fixture);
    const root = { token: fixture.tenants.root.token };
    const command = await fixture.compute.api.commands.run(root, {
      tenantId: fixture.tenants.root.id,
      nodeId: NODE,
      kind: 'logs.collect',
      idempotencyKey: 'bundle-plain',
    });
    expect(command.bundleKey).toBeUndefined();
    expect(await payloadOf(fixture, command.id)).toMatchObject({
      uploadUrl: '',
      supportBundle: false,
    });
    const noPresign = {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => undefined,
    };
    expect(() =>
      betterCompute({
        database: fixture.database,
        iam: fixture.iam,
        secret: 'better-compute-support-bundles-secret-01234567',
        baseURL: 'https://compute.test',
        rootTenantId: fixture.tenants.root.id,
        supportBundles: { blob: noPresign },
      }),
    ).toThrow(/supportBundles\.blob/);
  });
});
