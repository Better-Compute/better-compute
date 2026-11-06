import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { shardOf, type ComputeEvent } from '@better-compute/core';
import { localSealedSecretStore } from '@better-compute/pki';
import { CommandBodySchema, decodeMessage, unpackCommandPayload } from '@better-compute/protocol';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import {
  awsSecretsManagerStore,
  eventBridgeSink,
  generateKmsSealingKey,
  kmsSealingKeys,
  routeSecretStores,
  s3AuditSink,
  s3BlobStore,
} from '@better-compute/aws';
import { AwsEmulator } from './support/aws-platform-emulator/index.js';
import { kmsFake } from './support/aws-platform-emulator/kms.js';
import { eventBridgeFake } from './support/aws-platform-emulator/messaging.js';
import { s3Fake } from './support/aws-platform-emulator/s3.js';
import { secretsManagerFake } from './support/aws-platform-emulator/secrets.js';
import { sibling } from './support/runtime.js';

// A host on AWS (A8 exit gate): every platform seam wired to one emulator at once. Each piece is
// optional and independent; this checks they compose under one betterCompute().

afterEach(closeFixtures);

const NODE = 'node_01k5w00000000000000000aw01';

async function seedNode(fixture: ComputeFixture) {
  const root = fixture.tenants.root;
  await fixture.database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_aws', $1, 'shared', 'us-east-1', 1)`,
    [root.id],
  );
  await fixture.database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_aws', $1, 'site_aws', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [root.id],
  );
  await fixture.database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
       next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_aws', 'pool_aws', $2, 'host', 'adopted', false, false, 'connected',
       'platform', '{}', 1, 1, 1, 1, $3, 1)`,
    [NODE, root.id, shardOf(NODE)],
  );
  await fixture.database.query('INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)', [NODE]);
  await fixture.database.query(
    "INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, $2, '{}')",
    [NODE, root.id],
  );
}

async function awsHost() {
  const emu = new AwsEmulator();
  const sm = secretsManagerFake(emu);
  const kms = kmsFake(emu);
  kms.addSymmetricKey('sealing');
  const events = eventBridgeFake(emu);
  const s3 = s3Fake(emu);
  s3.createBucket('bc-audit');
  s3.createBucket('bc-blobs');
  const aws = { region: 'us-east-1', credentials: emu.credentials, fetch: emu.fetch, endpoint: 'http://emu.local', clock: emu.clock };

  const fixture = await computeFixture();
  await seedNode(fixture);
  fixture.iam.allow({ token: fixture.tenants.root.token });
  const wrapped = await generateKmsSealingKey({ ...aws, keyId: 'sealing' });
  const local = localSealedSecretStore({ sql: fixture.database, keys: await kmsSealingKeys({ ...aws, current: 'k1', wrapped: { k1: wrapped } }) });
  const secretsManager = awsSecretsManagerStore(aws);
  const blob = s3BlobStore({ ...aws, bucket: 'bc-blobs' });
  const compute = await sibling(fixture, {
    secrets: [routeSecretStores({ routes: [{ prefix: 'secret://aws-sm/', store: secretsManager }], fallback: local, putTo: secretsManager })],
    sinks: { events: [eventBridgeSink({ ...aws, id: 'eventbridge' })], audit: [s3AuditSink({ ...aws, bucket: 'bc-audit', prefix: 'audit' })] },
    downloads: { blob },
    supportBundles: { blob },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { emu, sm, events, s3, fixture, compute, local };
}

describe('a host on AWS', () => {
  it('a provider account secret round-trips through Secrets Manager', async () => {
    const { compute, fixture, sm, local } = await awsHost();
    const root = { token: fixture.tenants.root.token };
    const { ref } = await compute.api.secrets.put(root, {
      tenantId: fixture.tenants.root.id,
      name: 'aws-account',
      value: '{"accessKeyId":"AKIAEXAMPLEEXAMPLE00","secretAccessKey":"provider-secret"}',
      idempotencyKey: 'aws-account',
    });
    expect(ref.startsWith(`secret://aws-sm/${fixture.tenants.root.id}/`)).toBe(true);
    expect([...sm.secrets.values()][0]!.tags).toEqual([{ Key: 'better-compute:tenant', Value: fixture.tenants.root.id }]);
    await expect(compute.context.secrets.resolve(ref, { tenantId: fixture.tenants.root.id })).resolves.toContain('provider-secret');
    await expect(compute.context.secrets.resolve(ref, { tenantId: fixture.tenants.acme.id })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    // Existing local-sealed refs (KMS-wrapped key) keep resolving through the fallback.
    const legacy = await local.put(fixture.tenants.root.id, 'legacy-value');
    await expect(compute.context.secrets.resolve(legacy)).resolves.toBe('legacy-value');
    await compute.stop();
  });

  it('an instance event reaches EventBridge', async () => {
    const { compute, fixture, events } = await awsHost();
    await compute.context.sql.transaction((tx) =>
      compute.context.events.publish(tx, { type: 'instance.running', tenantId: fixture.tenants.acme.id, subject: 'instance/ins_1', data: { id: 'ins_1' } }),
    );
    await compute.jobs['outbox-dispatch']!.tick();
    const delivered = events.entries.map((entry) => JSON.parse(String(entry.Detail)) as ComputeEvent);
    expect(delivered.filter((event) => event.type === 'instance.running')).toEqual([
      expect.objectContaining({ subject: 'instance/ins_1', tenantId: fixture.tenants.acme.id }),
    ]);
    expect(events.entries.find((entry) => entry.DetailType === 'instance.running')).toMatchObject({ Source: 'better-compute', EventBusName: 'default' });
    await compute.stop();
  });

  it('audit records land in S3', async () => {
    const { compute, fixture, s3 } = await awsHost();
    await compute.api.secrets.put({ token: fixture.tenants.root.token }, {
      tenantId: fixture.tenants.root.id,
      name: 'audited',
      value: 'x',
      idempotencyKey: 'audited',
    });
    await compute.jobs['audit-sinks']!.tick();
    const objects = [...s3.buckets.get('bc-audit')!.entries()];
    expect(objects.length).toBeGreaterThan(0);
    const [key, object] = objects[0]!;
    expect(key).toMatch(/^audit\/year=\d{4}\/month=\d{2}\/day=\d{2}\/.+\.jsonl\.gz$/);
    const records = gunzipSync(object.body).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(records.some((record) => String(record.action).includes('secrets'))).toBe(true);
    expect(gunzipSync(object.body).toString('utf8')).not.toContain('"value":"x"');
    await compute.stop();
  });

  it('a support bundle uploads through the presigned S3 URL', async () => {
    const { compute, fixture, emu, s3 } = await awsHost();
    const command = await compute.api.commands.run({ token: fixture.tenants.root.token }, {
      tenantId: fixture.tenants.root.id,
      nodeId: NODE,
      kind: 'logs.collect',
      payload: { sinceSeconds: 3600 },
      idempotencyKey: 'bundle-1',
    });
    const { rows } = await fixture.database.query<{ body: Uint8Array }>('SELECT body FROM commands WHERE id = $1', [command.id]);
    const payload = unpackCommandPayload('logs.collect', decodeMessage(CommandBodySchema, new Uint8Array(rows[0]!.body)).payload) as { uploadUrl: string };
    expect(new URL(payload.uploadUrl).host).toBe('bc-blobs.emu.local');
    // The daemon PUTs the bundle to the URL it was given, with no credentials of its own.
    const response = await emu.fetch(payload.uploadUrl, { method: 'PUT', body: new TextEncoder().encode('bundle-bytes') });
    expect(response.status).toBe(200);
    expect(s3.object('bc-blobs', command.bundleKey!)!.body.toString()).toBe('bundle-bytes');
    await compute.stop();
  });
});
