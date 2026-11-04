import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeFixtures } from '@better-compute/testing';
import { credentialSubject, type KubernetesClusterView } from '@better-compute/kubernetes';
import { defaultVersion } from './support/fake-kubernetes.js';
import { kubernetesWorld, type KubernetesWorld } from './support/kubernetes-world.js';

// kubernetesClusters.credentials and versions: a short-lived kubeconfig for the caller, its role gated by the
// action the caller holds on the cluster, the token never stored, published or logged.

let world: KubernetesWorld;
let cluster: KubernetesClusterView;
let pending: KubernetesClusterView;

const viewer = 'token-acme-viewer';
const editor = 'token-acme-editor';
const outsider = 'token-acme-outsider';

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code ?? String(error),
  );
const credentials = (token: string, extra: Record<string, unknown> = {}) =>
  world.api.kubernetesClusters.credentials(
    { token },
    { tenantId: world.acmeTenant, clusterId: cluster.id, ...extra },
  );
/** The value of `key:` in the kubeconfig (every scalar is double-quoted JSON). */
const field = (kubeconfig: string, key: string) =>
  JSON.parse(new RegExp(`^\\s*-?\\s*${key}: (".*")$`, 'm').exec(kubeconfig)![1]!) as string;

beforeAll(async () => {
  world = await kubernetesWorld();
  const { iam } = world.fixture;
  // Within acme: a viewer (connect only), an editor (connect and update), and someone without connect.
  for (const [token, identityId] of [
    [viewer, 'usr_viewer'],
    [editor, 'usr_editor'],
    [outsider, 'usr_outsider'],
  ] as const) {
    iam.addCaller(token, { tenantId: world.acmeTenant, identityId });
    iam.allow({ token });
  }
  iam.deny({ token: viewer, action: 'compute:kubernetes:update' });
  iam.deny({ token: viewer, action: 'compute:kubernetes:delete' });
  iam.deny({ token: editor, action: 'compute:kubernetes:delete' });
  iam.deny({ token: outsider, action: 'compute:kubernetes:connect' });
  const create = (name: string) =>
    world.api.kubernetesClusters.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      name,
      mode: 'autopilot',
      location: 'us-central1',
      idempotencyKey: name,
    });
  cluster = await create('dev');
  await world.until(
    async () =>
      (
        await world.api.kubernetesClusters.get(world.acme, {
          tenantId: world.acmeTenant,
          clusterId: cluster.id,
        })
      ).state === 'ready',
  );
  pending = await create('later');
});
afterAll(closeFixtures);

describe('kubernetesClusters.credentials', () => {
  it('returns a view kubeconfig by default, minted for the caller’s subject', async () => {
    const now = world.fixture.clock.now();
    const issued = await credentials(viewer);
    expect(issued.role).toBe('view');
    expect(issued.expiresAt).toBe(now + 3600 * 1000);
    const subject = credentialSubject('usr_viewer', 'view');
    expect(subject).toMatch(/^bc-u-[0-9a-f]{16}-view$/);
    expect(world.cloud.credentials.at(-1)).toMatchObject({
      request: { subject, role: 'view', ttlSeconds: 3600 },
    });
    const token = world.cloud.tokens.at(-1)!;
    const { kubeconfig } = issued;
    expect(kubeconfig).toMatch(/^apiVersion: v1\nkind: Config\n/);
    const providerCluster = [...world.cloud.clusters.values()].find(
      (entry) => entry.spec.name === cluster.providerName,
    )!;
    expect(field(kubeconfig, 'server')).toBe(providerCluster.endpoint);
    expect(field(kubeconfig, 'certificate-authority-data')).toBe(
      'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t',
    );
    expect(field(kubeconfig, 'token')).toBe(token);
    expect(field(kubeconfig, 'current-context')).toBe('dev');
    expect(field(kubeconfig, 'user')).toBe(`${subject}@dev`);
    expect(kubeconfig).toContain('contexts:\n- name: "dev"\n  context:\n    cluster: "dev"');
  });

  it('takes a ttl from 600 s to a day', async () => {
    const now = world.fixture.clock.now();
    const issued = await credentials(viewer, { ttlSeconds: 900 });
    expect(issued.expiresAt).toBe(now + 900_000);
    expect(world.cloud.credentials.at(-1)!.request.ttlSeconds).toBe(900);
    expect(await codeOf(credentials(viewer, { ttlSeconds: 60 }))).toBe('INVALID_INPUT');
    expect(await codeOf(credentials(viewer, { ttlSeconds: 86_401 }))).toBe('INVALID_INPUT');
    expect(await codeOf(credentials(viewer, { role: 'root' }))).toBe('INVALID_INPUT');
  });

  it('gates edit on kubernetes:update and admin on kubernetes:delete, with one subject per role', async () => {
    world.fixture.iam.reset();
    expect(await codeOf(credentials(viewer, { role: 'edit' }))).toBe('ACCESS_DENIED');
    expect(await codeOf(credentials(viewer, { role: 'admin' }))).toBe('ACCESS_DENIED');
    expect(
      world.fixture.iam.calls
        .filter((call) => call.method === 'require' && call.token === viewer)
        .map((call) => [call.decision!.action, call.decision!.resource]),
    ).toEqual(
      expect.arrayContaining([
        ['compute:kubernetes:update', { type: 'compute-kubernetes-cluster', id: cluster.id }],
        ['compute:kubernetes:delete', { type: 'compute-kubernetes-cluster', id: cluster.id }],
      ]),
    );
    const edit = await credentials(editor, { role: 'edit' });
    expect(edit.role).toBe('edit');
    expect(world.cloud.credentials.at(-1)!.request).toMatchObject({
      subject: credentialSubject('usr_editor', 'edit'),
      role: 'edit',
    });
    expect(await codeOf(credentials(editor, { role: 'admin' }))).toBe('ACCESS_DENIED');
    const admin = await credentials(world.acme.token, { role: 'admin' });
    expect(admin.role).toBe('admin');
    expect(world.cloud.credentials.at(-1)!.request.subject).toMatch(/-admin$/);
    // One subject per (identity, role): a later view kubeconfig never rebinds the admin one's account.
    await credentials(world.acme.token, { role: 'view' });
    const acmeIdentity = world.fixture.tenants.acme.caller.identityId;
    const subjects = world.cloud.credentials.slice(-2).map((entry) => entry.request.subject);
    expect(subjects).toEqual([
      credentialSubject(acmeIdentity, 'admin'),
      credentialSubject(acmeIdentity, 'view'),
    ]);
    expect(new Set(subjects).size).toBe(2);
    for (const subject of subjects) expect(subject).toMatch(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/);
    // Without kubernetes:connect, nothing is minted.
    const minted = world.cloud.tokens.length;
    expect(await codeOf(credentials(outsider))).toBe('ACCESS_DENIED');
    expect(world.cloud.tokens.length).toBe(minted);
  });

  it('refuses a cluster that is not ready, and one of another tenant', async () => {
    expect(
      await codeOf(
        world.api.kubernetesClusters.credentials(world.acme, {
          tenantId: world.acmeTenant,
          clusterId: pending.id,
        }),
      ),
    ).toBe('INVALID_STATE');
    expect(
      await codeOf(
        world.api.kubernetesClusters.credentials(world.other, {
          tenantId: world.otherTenant,
          clusterId: cluster.id,
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('publishes credentials-issued without the token, and never logs or stores a token', async () => {
    await credentials(world.acme.token);
    const events = await world.events('kubernetes.cluster.credentials-issued');
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({
      subject: `kubernetes-cluster/${cluster.id}`,
      tenantId: world.acmeTenant,
      data: { clusterId: cluster.id, role: expect.any(String), subject: expect.any(String) },
    });
    expect(world.cloud.tokens.length).toBeGreaterThan(0);
    const { rows: outbox } = await world.fixture.database.query<{ text: string }>(
      `SELECT payload::text AS text FROM outbox`,
    );
    const { rows: audit } = await world.fixture.database.query<{ text: string }>(
      `SELECT to_jsonb(a)::text AS text FROM audit_events a`,
    );
    const { rows: clusters } = await world.fixture.database.query<{ text: string }>(
      `SELECT to_jsonb(k)::text AS text FROM kubernetes_clusters k`,
    );
    for (const token of world.cloud.tokens) {
      for (const row of [...outbox, ...audit, ...clusters]) expect(row.text).not.toContain(token);
      for (const line of world.logs) expect(line).not.toContain(token);
    }
  });
});

describe('kubernetesClusters.versions', () => {
  it('answers the provider’s versions for a location of a visible pool', async () => {
    const versions = await world.api.kubernetesClusters.versions(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      location: 'us-central1-a',
    });
    expect(versions).toMatchObject({
      defaultVersion,
      validVersions: [defaultVersion, '1.34.1-gke.100'],
    });
    expect(world.cloud.calls.at(-1)).toBe('versions us-central1-a');
    expect(
      await codeOf(
        world.api.kubernetesClusters.versions(world.acme, {
          tenantId: world.acmeTenant,
          poolId: world.plainPoolId,
          location: 'us-central1',
        }),
      ),
    ).toBe('UNSUPPORTED');
    expect(
      await codeOf(
        world.api.kubernetesClusters.versions(world.acme, {
          tenantId: world.acmeTenant,
          poolId: world.poolId,
          location: 'asia-east1',
        }),
      ),
    ).toBe('INVALID_INPUT');
  });
});
