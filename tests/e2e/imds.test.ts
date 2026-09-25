import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkloadIssuer,
  createWorkloadTokenRequest,
  imdsSessionHeader,
  imdsSessionTtlHeader,
} from '@better-compute/pki';
import { instanceStatusHandler, setIpPool, vps } from '@better-compute/vps';
import { createDevStack, type DevStack, type FakeDaemon } from '@better-compute/testing';

// PLAN.md §16 v0.5 exit: "IMDS cross-instance access fails" (§12.2 workload identity, §13 IMDS bound
// per instance). Each VPS host serves its instances an IMDSv2-style metadata service; a workload
// token is minted by the control plane (the host holds no key) through a node-signed
// WorkloadTokenRequest relayed by the real gateway, answered as a JWE to a one-time key. Only the
// instance the request came from, only if it runs on that host, only in pools that turned workload
// identity on, only for configured audiences.

const issuer = createWorkloadIssuer({
  issuer: 'https://id.compute.example',
  defaultAudience: 'sts.iam.example',
});
const IMAGE = {
  url: 'https://images.example/base.qcow2',
  sha256: 'ab'.repeat(32),
  format: 'qcow2' as const,
  verified: true,
};
let dev: DevStack;
let api: any;
let tenantId: string;
let enabledPool: string;
let disabledPool: string;
let nodes: string[];
let keys = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const daemon = (nodeId: string): FakeDaemon => dev.daemons.get(nodeId)!;

/** A running instance in `poolId`; resolves to its id and host. */
async function running(poolId: string): Promise<{ id: string; nodeId: string }> {
  const instance = await api.instances.create(dev.root, {
    tenantId,
    poolId,
    flavor: 's',
    imageId: 'base',
    idempotencyKey: `imds-${++keys}`,
  });
  await until(`instance ${instance.id} running`, async () => {
    const current = await api.instances.get(dev.root, { tenantId, instanceId: instance.id });
    return current.state === 'running';
  });
  return { id: instance.id, nodeId: instance.nodeId };
}

/** A request from the guest `instanceId` to its host's metadata address. */
const imds = (host: string, instanceId: string, init: RequestInit & { path: string }) =>
  daemon(host).handleImds(new Request(`http://169.254.169.254${init.path}`, init), instanceId);
async function session(host: string, instanceId: string): Promise<string> {
  const response = await imds(host, instanceId, {
    path: '/latest/api/token',
    method: 'PUT',
    headers: { [imdsSessionTtlHeader]: '300' },
  });
  expect(response.status).toBe(200);
  return response.text();
}
const identity = (host: string, instanceId: string, token: string, audience?: string) =>
  imds(host, instanceId, {
    path: `/latest/identity-token${audience ? `?audience=${encodeURIComponent(audience)}` : ''}`,
    headers: { [imdsSessionHeader]: token },
  });
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

beforeAll(async () => {
  dev = await createDevStack({
    modules: [vps({ images: { resolve: async () => IMAGE }, hostSyncEvery: '1s' })],
    reports: { status: instanceStatusHandler({ log: () => {} }) },
    daemon: { instances: { runtimes: ['libvirt-kvm'] } },
    workloadIdentity: { issuer, audiences: ['https://vault.example'] },
  });
  api = dev.compute.api;
  tenantId = dev.rootTenantId;
  const site = await api.sites.create(dev.root, {
    tenantId,
    kind: 'shared',
    region: 'dev-1',
    idempotencyKey: 'imds-site',
  });
  const quota = { vcpu: 10_000, memoryGiB: 100_000, diskGiB: 1_000_000 };
  const make = async (key: string, policy: Record<string, unknown>) => {
    const pool = await api.pools.create(dev.root, {
      tenantId,
      siteId: site.id,
      class: 'vps-host',
      policy,
      ownerQuota: quota,
      idempotencyKey: key,
    });
    await setIpPool(dev.database, {
      poolId: pool.id,
      cidr: `10.${9 + keys++}.0.0/24`,
      gateway: `10.${8 + keys}.0.1`,
    });
    await api.flavors.create(dev.root, {
      tenantId,
      poolId: pool.id,
      name: 's',
      vcpu: 2,
      memoryGiB: 4,
      diskGiB: 40,
    });
    return pool.id as string;
  };
  enabledPool = await make('imds-on', { workloadIdentity: true });
  disabledPool = await make('imds-off', {});
  nodes = [
    ...(await dev.join({ poolId: enabledPool, count: 2, seed: 'imds-on' })),
    ...(await dev.join({ poolId: disabledPool, count: 1, seed: 'imds-off' })),
  ];
  await dev.waitFor(nodes, { timeoutMs: 45_000 });
  await until('host capacity', async () => {
    const { rows } = await dev.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM node_resources WHERE node_id = ANY($1) AND resource = 'vcpu'`,
      [nodes],
    );
    return rows[0]!.count === 3;
  });
}, 120_000);

afterAll(async () => {
  await dev?.close();
});

describe('IMDS workload identity (§16 v0.5)', () => {
  it('gives an instance its own token, minted by the control plane', async () => {
    const x = await running(enabledPool);
    const token = await session(x.nodeId, x.id);
    const response = await identity(x.nodeId, x.id, token);
    expect(response.status).toBe(200);
    const jwt = await response.text();
    expect(claims(jwt)).toMatchObject({
      iss: 'https://id.compute.example',
      sub: `t:${tenantId}:instance:${x.id}`,
      aud: 'sts.iam.example',
      tenant_id: tenantId,
      instance_id: x.id,
    });
    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString());
    expect(issuer.jwks().keys.map((key) => (key as { kid?: string }).kid)).toContain(header.kid);
    // A configured audience works; any other is refused.
    const vault = await identity(x.nodeId, x.id, token, 'https://vault.example');
    expect(claims(await vault.text()).aud).toBe('https://vault.example');
    expect((await identity(x.nodeId, x.id, token, 'https://evil.example')).status).toBe(400);
    // Audited without the token.
    const { rows } = await dev.database.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_events WHERE action = 'workload.token.issued' AND resource_id = $1`,
      [x.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rows)).not.toContain(jwt);
  }, 60_000);

  it('refuses cross-instance access at the host and at the control plane', async () => {
    const placed: { id: string; nodeId: string }[] = [];
    for (let attempt = 0; attempt < 8 && new Set(placed.map((p) => p.nodeId)).size < 2; attempt++)
      placed.push(await running(enabledPool));
    const [a, b] = [placed[0]!, placed.find((p) => p.nodeId !== placed[0]!.nodeId)!];
    expect(b).toBeDefined();
    const sameHost = placed.find((p) => p.nodeId === a.nodeId && p.id !== a.id);

    // A's session token is bound to A: presented from another instance it is worthless.
    const tokenA = await session(a.nodeId, a.id);
    if (sameHost) expect((await identity(a.nodeId, sameHost.id, tokenA)).status).toBe(401);
    expect((await identity(b.nodeId, b.id, tokenA)).status).toBe(401);
    // A host answers only instances it runs.
    expect((await imds(a.nodeId, b.id, { path: '/latest/api/token', method: 'PUT' })).status).toBe(
      404,
    );
    // Forwarded requests (SSRF relays) are refused.
    const forwarded = await imds(a.nodeId, a.id, {
      path: '/latest/identity-token',
      headers: { [imdsSessionHeader]: tokenA, 'x-forwarded-for': '10.0.0.9' },
    });
    expect(forwarded.status).toBe(403);

    // A compromised host asking the control plane for an instance it does not run gets nothing.
    const services = dev.compute.gatewayServices;
    const { request } = createWorkloadTokenRequest({
      nodeKey: daemon(a.nodeId).nodeKey!,
      instanceId: b.id,
    });
    const refused = await services.workloadToken!(request, { peerNodeId: a.nodeId });
    expect(refused).toMatchObject({ error: 'not-bound', jwe: '' });
    // Nor can it sign as another node.
    const { request: forged } = createWorkloadTokenRequest({
      nodeKey: daemon(a.nodeId).nodeKey!,
      instanceId: b.id,
    });
    expect(await services.workloadToken!(forged, { peerNodeId: b.nodeId })).toMatchObject({
      error: 'access-denied',
    });
    // A replayed request (a relay's copy) is refused too.
    const { request: once } = createWorkloadTokenRequest({
      nodeKey: daemon(a.nodeId).nodeKey!,
      instanceId: a.id,
    });
    expect((await services.workloadToken!(once, { peerNodeId: a.nodeId })).jwe).not.toBe('');
    expect(await services.workloadToken!(once, { peerNodeId: a.nodeId })).toMatchObject({
      error: 'access-denied',
    });
  }, 90_000);

  it('mints only for an unrestricted node-role certificate (an allowlist)', async () => {
    const x = await running(enabledPool);
    const services = dev.compute.gatewayServices;
    const ask = () =>
      services.workloadToken!(
        createWorkloadTokenRequest({ nodeKey: daemon(x.nodeId).nodeKey!, instanceId: x.id }).request,
        { peerNodeId: x.nodeId },
      );
    expect((await ask()).jwe).not.toBe('');
    for (const [column, value] of [
      ['allowed_kinds', `{"diag.nvml"}`],
      ['role', 'ramdisk'],
    ] as const) {
      const { rows } = await dev.database.query<{ serial: string; before: string | null }>(
        `UPDATE node_certs c SET ${column} = $2 FROM node_certs old
          WHERE c.serial = old.serial AND c.node_id = $1 RETURNING c.serial, old.${column}::text AS before`,
        [x.nodeId, value],
      );
      expect(await ask(), column).toMatchObject({ error: 'access-denied', jwe: '' });
      for (const row of rows)
        await dev.database.query(`UPDATE node_certs SET ${column} = $2 WHERE serial = $1`, [
          row.serial,
          column === 'allowed_kinds' ? null : row.before,
        ]);
    }
    expect((await ask()).jwe).not.toBe('');
  }, 60_000);

  it('mints nothing for a suspended or deleted tenant, before teardown reaches its instances (§12.8)', async () => {
    const x = await running(enabledPool);
    const services = dev.compute.gatewayServices;
    const ask = () =>
      services.workloadToken!(
        createWorkloadTokenRequest({ nodeKey: daemon(x.nodeId).nodeKey!, instanceId: x.id }).request,
        { peerNodeId: x.nodeId },
      );
    try {
      for (const state of ['suspended', 'deleted']) {
        await dev.database.query(
          `INSERT INTO compute_tenant_states (tenant_id, state) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET state = EXCLUDED.state`,
          [tenantId, state],
        );
        expect(await ask(), state).toMatchObject({ error: 'disabled', jwe: '' });
      }
    } finally {
      await dev.database.query('DELETE FROM compute_tenant_states WHERE tenant_id = $1', [tenantId]);
    }
    expect((await ask()).jwe).not.toBe('');
    const { rows } = await dev.database.query<{ data: Record<string, unknown> }>(
      `SELECT payload->'data' AS data FROM outbox WHERE topic = 'security.workload.refused' ORDER BY seq`,
    );
    expect(rows.map((row) => row.data.reason)).toEqual(
      expect.arrayContaining(['tenant-suspended', 'tenant-deleted']),
    );
  }, 60_000);

  it('mints nothing in a pool that did not turn workload identity on', async () => {
    const off = await running(disabledPool);
    const token = await session(off.nodeId, off.id);
    const response = await identity(off.nodeId, off.id, token);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('disabled');
    const { rows } = await dev.database.query<{ data: Record<string, unknown> }>(
      `SELECT payload->'data' AS data FROM outbox WHERE topic = 'security.workload.refused' ORDER BY seq`,
    );
    expect(rows.map((row) => row.data.reason)).toEqual(
      expect.arrayContaining(['not-placed-here', 'disabled']),
    );
  }, 60_000);
});
