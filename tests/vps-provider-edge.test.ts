import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  manualClock,
  type Caller,
  type ExternalMachine,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type ProviderCertificateSpec,
  type ProviderLoadBalancerSpec,
  type ProviderResourceState,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, setQuota } from '@better-compute/capacity';
import {
  defineProvider,
  providerResourceName,
  providerResourcesWork,
  vps,
  vpsMigrations,
  type VpsApi,
} from '@better-compute/vps';

// (DO P4) Edge resources in vps: `certificates.*` and `loadBalancers.*` record what a tenant wants, and the
// `vps.provider-resources` reconciler converges the provider through `ProviderImpl.certificates` and
// `ProviderImpl.loadBalancers`. The provider is an inline stand-in that keeps them in memory (never
// provider-digitalocean: its own suite covers the provider side).

const T0 = Date.UTC(2026, 10, 5, 12);
const SITE = 'site_01jz0000000000000000000d03';
let db: SqlExecutor;
let clock: ManualClock;

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'root',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const mallory: Caller = { ...alice, identityId: 'usr_mallory', tenantId: 'other' };

// --- The stand-in provider ---------------------------------------------------------------------

interface FakeCertificate {
  id: string;
  spec: ProviderCertificateSpec;
  /** What the resolver gave for each ref (the upload's PEMs). */
  resolved: string[];
}
interface FakeLoadBalancer {
  id: string;
  spec: ProviderLoadBalancerSpec;
}

const cloud = {
  certificates: new Map<string, FakeCertificate>(),
  loadBalancers: new Map<string, FakeLoadBalancer>(),
  calls: [] as string[],
  failNext: undefined as ComputeError | undefined,
  /** Managed certificates and load balancers answer `pending` this many times first. */
  pendingTicks: 0,
  progress: new Map<string, number>(),
  counter: 0,
  reset() {
    this.certificates.clear();
    this.loadBalancers.clear();
    this.calls.length = 0;
    this.failNext = undefined;
    this.pendingTicks = 0;
    this.progress.clear();
  },
  call(label: string): void {
    this.calls.push(label);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  },
  running(label: string): boolean {
    const asked = (this.progress.get(label) ?? 0) + 1;
    if (asked <= this.pendingTicks) {
      this.progress.set(label, asked);
      return true;
    }
    this.progress.delete(label);
    return false;
  },
  lbState(lb: FakeLoadBalancer, state: ProviderResourceState['state'] = 'ready'): ProviderResourceState {
    return {
      id: lb.id,
      state,
      outputs: { scope: lb.spec.scope, address: `198.51.100.${lb.id.slice(3)}` },
    };
  },
};

const standard = {
  '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};
const edgeLike = defineProvider({
  id: 'fake-edge',
  version: '1.0.0',
  provides: ['vps'],
  config: standard as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create(): Promise<ExternalMachine> {
      throw new Error('unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
    certificates: {
      async ensureCertificate(spec, context) {
        cloud.call(`ensureCertificate ${spec.name}`);
        const resolved: string[] = [];
        for (const ref of [spec.certificate, spec.privateKey, spec.chain])
          if (ref) resolved.push(await context.secrets.resolve(ref));
        let certificate = [...cloud.certificates.values()].find((entry) => entry.spec.name === spec.name);
        if (!certificate) {
          certificate = { id: `cert-${++cloud.counter}`, spec, resolved };
          cloud.certificates.set(certificate.id, certificate);
        }
        const pending = spec.kind === 'managed' && cloud.running(`issue ${spec.name}`);
        return {
          id: certificate.id,
          state: pending ? 'pending' : 'ready',
          outputs: {
            kind: spec.kind,
            domains: (spec.domains ?? ['custom.example.com']).join(','),
            ...(pending ? {} : { notAfter: '2027-02-03T00:00:00.000Z', fingerprint: 'ab12' }),
          },
        };
      },
      async getCertificate(id) {
        const certificate = cloud.certificates.get(id);
        return certificate ? { id, state: 'ready' } : undefined;
      },
      async deleteCertificate(id) {
        cloud.call(`deleteCertificate ${id}`);
        if ([...cloud.loadBalancers.values()].some((lb) => lb.spec.forwarding.some((rule) => rule.certificate === id)))
          throw new ComputeError('CONFLICT', 'in use by a load balancer');
        cloud.certificates.delete(id);
        return { id, state: 'deleted' };
      },
    },
    loadBalancers: {
      async ensureLoadBalancer(spec) {
        cloud.call(
          `ensureLoadBalancer ${spec.name} ${(spec.targets.machines ?? spec.targets.loadBalancers ?? []).join(',') || '-'}`,
        );
        let lb = spec.id
          ? cloud.loadBalancers.get(spec.id)
          : [...cloud.loadBalancers.values()].find((entry) => entry.spec.name === spec.name);
        if (!lb) {
          lb = { id: `lb-${++cloud.counter}`, spec };
          cloud.loadBalancers.set(lb.id, lb);
        } else lb.spec = spec;
        return cloud.lbState(lb, cloud.running(`lb ${spec.name}`) ? 'pending' : 'ready');
      },
      async getLoadBalancer(id) {
        const lb = cloud.loadBalancers.get(id);
        return lb ? cloud.lbState(lb) : undefined;
      },
      async findLoadBalancer(name) {
        cloud.call(`findLoadBalancer ${name}`);
        const lb = [...cloud.loadBalancers.values()].find((entry) => entry.spec.name === name);
        return lb ? cloud.lbState(lb) : undefined;
      },
      async deleteLoadBalancer(id) {
        cloud.call(`deleteLoadBalancer ${id}`);
        cloud.loadBalancers.delete(id);
        return { id, state: 'deleted' };
      },
    },
  }),
});

// --- The module context ------------------------------------------------------------------------

const events: { type: string; subject: string; data: Record<string, unknown> }[] = [];
const projected = new Map<string, string>();
const queue = new Map<string, number>();
const required: string[] = [];
const resolvedRefs: string[] = [];

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: {
      resolve: async (ref: string) => {
        resolvedRefs.push(ref);
        return `PEM(${ref})`;
      },
    },
    authz: {
      async upsert(_tx: SqlTx, row: { type: string; id: string; tenantId: string }) {
        projected.set(`${row.type}/${row.id}`, row.tenantId);
      },
      async remove(_tx: SqlTx, ref: { type: string; id: string }) {
        projected.delete(`${ref.type}/${ref.id}`);
      },
      async setPending() {},
    },
    events: {
      async publish(_tx: SqlTx, event: { type: string; subject: string; data: Record<string, unknown> }) {
        events.push({ type: event.type, subject: event.subject, data: event.data });
      },
    },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string, options?: { notBefore?: number }) {
        if (kind === providerResourcesWork) queue.set(key, options?.notBefore ?? clock.now());
      },
    },
    desired: { async invalidate() {} },
    iam: {
      rootTenantId: 'root',
      async require(_credential: unknown, request: { action: string; resource: { type: string; id: string } }) {
        required.push(`${request.action} ${request.resource.type}/${request.resource.id}`);
      },
    },
  } as unknown as ModuleContext;
}
function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn, options) => db.transaction(fn, options),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  };
}

const module = vps({ providers: [edgeLike], images: { resolve: async () => undefined } });
const api = module.api!({} as ModuleContext) as VpsApi;

type Definition = {
  action: string | null;
  validate(raw: unknown): unknown;
  resource(input: unknown): { type: string; id: string } | undefined;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
  admission?: {
    prepare(
      context: MethodContext,
      input: unknown,
      tx: SqlTx,
    ): Promise<{ status: string; result?: unknown; resource?: { type: string; id: string } }>;
    denied?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
    abandoned?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
    check?(context: MethodContext, input: unknown, resource: unknown): Promise<void>;
  };
};
/** As the envelope runs a method: tenant pre-check, admission, decision on the projected resource, handler. */
async function run(definition: Definition, raw: unknown, who: Caller): Promise<any> {
  const input = definition.validate(raw);
  const tenantId = (input as { tenantId: string }).tenantId;
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, credential: { kind: 'test' }, requestId: 'req' }) as MethodContext;
  if (who.tenantId !== tenantId) throw new ComputeError('ACCESS_DENIED', 'The caller belongs to another tenant');
  const admission = definition.admission;
  let resource = definition.resource(input);
  if (admission) {
    const plan = await db.transaction((tx) => admission.prepare(context(tx), input, tx));
    if (plan.status === 'replay') return plan.result;
    resource = plan.resource;
  }
  const home = resource ? projected.get(`${resource.type}/${resource.id}`) : undefined;
  if (resource && home !== undefined && home !== tenantId) {
    const error = new ComputeError('ACCESS_DENIED', `denied on ${resource.type}/${resource.id}`);
    if (admission?.denied) await db.transaction((tx) => admission.denied!(context(tx), input, tx, error));
    throw error;
  }
  if (admission?.check)
    await admission.check(
      { ...moduleContext(db), caller: who, credential: { kind: 'test' }, requestId: 'req' } as MethodContext,
      input,
      resource,
    );
  try {
    return await db.transaction((tx) => definition.handler(context(tx), input));
  } catch (error) {
    if (admission?.abandoned) await db.transaction((tx) => admission.abandoned!(context(tx), input, tx, error));
    throw error;
  }
}
const call = (group: 'certificates' | 'loadBalancers', method: string, raw: unknown, who: Caller = alice) =>
  run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

let pool: string;
let account: string;
let keyCounter = 0;

const createCertificate = (raw: Record<string, unknown> = {}, who: Caller = alice) =>
  call(
    'certificates',
    'create',
    {
      tenantId: who.tenantId,
      poolId: pool,
      name: `cert-${++keyCounter}`,
      kind: 'managed',
      domains: ['www.example.com'],
      idempotencyKey: `k-${keyCounter}`,
      ...raw,
    },
    who,
  );
const http = { entryProtocol: 'http', entryPort: 80, targetProtocol: 'http', targetPort: 8080 };
const createLoadBalancer = (raw: Record<string, unknown> = {}, who: Caller = alice) =>
  call(
    'loadBalancers',
    'create',
    {
      tenantId: who.tenantId,
      poolId: pool,
      name: `lb-${++keyCounter}`,
      region: 'nyc3',
      targets: { pool: true },
      forwarding: [http],
      idempotencyKey: `k-${keyCounter}`,
      ...raw,
    },
    who,
  );

/** A provider instance with a machine (the instances API is not under test here). */
async function insertInstance(options: { tenantId?: string; flavor?: string; state?: string } = {}) {
  const instanceId = `inst_01jz${String(++keyCounter).padStart(22, '0')}`;
  await db.query(
    `INSERT INTO instances (id, tenant_id, pool_id, flavor_id, flavor, image_id, runtime, draft, state, desired_state,
                            provider_account_id, external_id, owner_identity_id, idempotency_key, request_hash, version)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'img', 'provider', false, $5, 'running', $6, $7, 'usr_alice', $1,
             decode('00', 'hex'), 1)`,
    [
      instanceId,
      options.tenantId ?? 'root',
      pool,
      options.flavor ?? 'flv_nyc',
      options.state ?? 'running',
      account,
      `droplet-${keyCounter}`,
    ],
  );
  return { instanceId, machine: `droplet-${keyCounter}` };
}

const reconciler = () => module.reconcilers!.find((entry) => entry.name === providerResourcesWork)!;
const runKey = (key: string) =>
  reconciler().run({ ...moduleContext(db), signal: new AbortController().signal } as never, key);
async function tick(): Promise<void> {
  clock.advance(5_000);
  await useSimClock(db, clock.now());
  const due = [...queue].filter(([, at]) => at <= clock.now()).map(([key]) => key);
  for (const key of due) {
    queue.delete(key);
    await runKey(key);
  }
}
async function drain(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks && queue.size > 0; i++) await tick();
}
const quotaUsed = async (resource: string) =>
  Number(
    (
      await db.query<{ used: string }>(
        `SELECT used::text AS used FROM quota_usage WHERE tenant_id = 'root' AND pool_id = $1 AND resource = $2`,
        [pool, resource],
      )
    ).rows[0]?.used ?? 0,
  );

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'us', 1)`,
    [SITE],
  );
  const capacity = capacityModule().api!({} as ModuleContext) as unknown as Record<string, Record<string, Definition>>;
  const accounts = api as unknown as Record<string, Record<string, Definition>>;
  account = (
    (await run(
      accounts.providerAccounts!.create!,
      { tenantId: 'root', provider: 'fake-edge', name: 'edge', config: { regions: ['nyc3', 'sfo3'] } },
      alice,
    )) as { id: string }
  ).id;
  pool = (
    (await run(
      capacity.pools!.create!,
      { tenantId: 'root', siteId: SITE, class: 'provider', providerAccountId: account },
      alice,
    )) as { id: string }
  ).id;
  await db.query(
    `INSERT INTO flavors (id, pool_id, name, vcpu, memory_gib, disk_gib, offer_id, version)
     VALUES ('flv_nyc', $1, 'small', 1, 1, 25, 'nyc3/s-1vcpu-1gb', 1),
            ('flv_sfo', $1, 'small-sfo', 1, 1, 25, 'sfo3/s-1vcpu-1gb', 1)`,
    [pool],
  );
  await db.query(`INSERT INTO pool_offers (pool_id, tenant_id) VALUES ($1, 'other')`, [pool]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query(`DELETE FROM provider_load_balancers`);
  await db.query(`DELETE FROM provider_certificates`);
  await db.query(`DELETE FROM instance_usage_intervals`);
  await db.query(`DELETE FROM instances`);
  await db.transaction(async (tx) => {
    await setQuota(tx, 'root', pool, 'loadBalancers', 2);
    await tx.query(`UPDATE quota_usage SET used = 0 WHERE pool_id = $1`, [pool]);
  });
  projected.clear();
  required.length = 0;
  events.length = 0;
  resolvedRefs.length = 0;
  queue.clear();
  cloud.reset();
});

describe('api surface', () => {
  it('every list row has a get, so the list recipe knows its item kind', async () => {
    const { apiMethod, apiSurface } = await import('@better-compute/core');
    for (const group of ['certificates', 'loadBalancers']) {
      expect(apiMethod(group, 'get')?.resource, group).toMatch(/^provider-/);
      const rows = apiSurface.filter((row) => row.group === group);
      expect(Object.keys(api[group as keyof VpsApi] as object).sort(), group).toEqual(
        rows.map((row) => row.method).sort(),
      );
    }
  });
});

describe('certificates', () => {
  it('a managed certificate is pending until issued, then ready with its expiry', async () => {
    cloud.pendingTicks = 1;
    const created = await createCertificate({ name: 'www', idempotencyKey: 'www-1' });
    expect(created).toMatchObject({ name: 'www', kind: 'managed', domains: ['www.example.com'], state: 'pending' });
    expect(await createCertificate({ name: 'www', idempotencyKey: 'www-1' })).toMatchObject({ id: created.id });
    expect(await codeOf(createCertificate({ name: 'www', idempotencyKey: 'www-2' }))).toBe('CONFLICT');
    await drain();
    const ready = await call('certificates', 'get', { tenantId: 'root', certificateId: created.id });
    expect(ready).toMatchObject({ state: 'ready', notAfter: '2027-02-03T00:00:00.000Z', fingerprint: 'ab12' });
    expect(cloud.calls).toEqual([
      `ensureCertificate ${providerResourceName(created.id)}`,
      `ensureCertificate ${providerResourceName(created.id)}`,
    ]);
    expect(events.map((event) => event.type)).toEqual(['providerCertificate.created', 'providerCertificate.ready']);
  });

  it("a custom certificate names only the tenant's own secrets, resolved only for its upload", async () => {
    expect(
      await codeOf(createCertificate({ kind: 'custom', domains: undefined, certificate: 'secret://other/leaf', privateKey: 'secret://root/key' })),
    ).toBe('INVALID_INPUT');
    expect(
      await codeOf(createCertificate({ kind: 'custom', domains: undefined, certificate: 'env://TLS_CERT', privateKey: 'secret://root/key' })),
    ).toBe('INVALID_INPUT');
    expect(await codeOf(createCertificate({ kind: 'custom', certificate: 'secret://root/leaf', privateKey: 'secret://root/key' }))).toBe(
      'INVALID_INPUT',
    );
    const created = await createCertificate({
      kind: 'custom',
      domains: undefined,
      certificate: 'secret://root/leaf',
      privateKey: 'secret://root/key',
    });
    await drain();
    const ready = await call('certificates', 'get', { tenantId: 'root', certificateId: created.id });
    expect(ready).toMatchObject({ state: 'ready', domains: ['custom.example.com'] });
    expect(JSON.stringify(ready)).not.toContain('secret://');
    expect(resolvedRefs).toEqual(['secret://root/leaf', 'secret://root/key']);
    // A row written around the API with a foreign ref is refused at resolve time (fail closed).
    await db.query(`UPDATE provider_certificates SET certificate_ref = 'secret://other/leaf', external_id = NULL,
                    state = 'pending' WHERE id = $1`, [created.id]);
    cloud.certificates.clear();
    queue.set(created.id, clock.now());
    await drain();
    expect(resolvedRefs).toEqual(['secret://root/leaf', 'secret://root/key']);
    expect((await call('certificates', 'get', { tenantId: 'root', certificateId: created.id })).state).toBe('error');
  });

  it("another tenant's certificate is not found, and delete removes it at the provider", async () => {
    const created = await createCertificate();
    await drain();
    expect(await codeOf(call('certificates', 'get', { tenantId: 'other', certificateId: created.id }, mallory))).toBe(
      'ACCESS_DENIED',
    );
    expect((await call('certificates', 'list', { tenantId: 'other' }, mallory)).items).toEqual([]);
    const deleting = await call('certificates', 'delete', { tenantId: 'root', certificateId: created.id });
    expect(deleting).toMatchObject({ state: 'deleting', desiredState: 'deleted' });
    await drain();
    expect(cloud.certificates.size).toBe(0);
    expect((await call('certificates', 'list', { tenantId: 'root' })).items).toEqual([]);
    expect(projected.has(`provider-certificate/${created.id}`)).toBe(false);
  });
});

describe('loadBalancers', () => {
  it("targets the tenant's machines in its pool and region, never another tenant's", async () => {
    const mine = await insertInstance();
    await insertInstance({ flavor: 'flv_sfo' });
    await insertInstance({ tenantId: 'other' });
    await insertInstance({ state: 'provisioning' });
    const created = await createLoadBalancer({ name: 'web', idempotencyKey: 'web-1' });
    expect(created).toMatchObject({ name: 'web', scope: 'regional', region: 'nyc3', targets: { pool: true }, state: 'pending' });
    expect(await quotaUsed('loadBalancers')).toBe(1);
    await drain();
    expect(cloud.calls).toEqual([`ensureLoadBalancer ${providerResourceName(created.id)} ${mine.machine}`]);
    const ready = await call('loadBalancers', 'get', { tenantId: 'root', loadBalancerId: created.id });
    expect(ready).toMatchObject({ state: 'ready', address: expect.stringMatching(/^198\.51\.100\./) });
  });

  it('re-ensures when the pool gains a machine (periodic pass) or loses one (instance delete)', async () => {
    const first = await insertInstance();
    const lb = await createLoadBalancer();
    await drain();
    cloud.calls.length = 0;
    await runKey('all');
    expect(queue.size).toBe(0);
    const second = await insertInstance();
    await runKey('all');
    expect([...queue.keys()]).toEqual([lb.id]);
    await drain();
    expect(cloud.calls).toEqual([
      `ensureLoadBalancer ${providerResourceName(lb.id)} ${[first.machine, second.machine].sort().join(',')}`,
    ]);
    cloud.calls.length = 0;
    await db.query(`UPDATE instances SET state = 'deleted', desired_state = 'deleted' WHERE id = $1`, [first.instanceId]);
    const { onInstanceDeleted } = await import('@better-compute/vps');
    await db.transaction((tx) => onInstanceDeleted(moduleContext(db), tx, first.instanceId, { machineDeleted: true }));
    expect(queue.has(lb.id)).toBe(true);
    await drain();
    expect(cloud.calls).toEqual([`ensureLoadBalancer ${providerResourceName(lb.id)} ${second.machine}`]);
  });

  it('named instances must be the tenant’s, on the account and in the region', async () => {
    const theirs = await insertInstance({ tenantId: 'other' });
    const sfo = await insertInstance({ flavor: 'flv_sfo' });
    const mine = await insertInstance();
    expect(await codeOf(createLoadBalancer({ targets: { instanceIds: [theirs.instanceId] } }))).toBe('ACCESS_DENIED');
    expect(await codeOf(createLoadBalancer({ targets: { instanceIds: [sfo.instanceId] } }))).toBe('INVALID_INPUT');
    expect(await quotaUsed('loadBalancers')).toBe(0);
    const lb = await createLoadBalancer({ targets: { instanceIds: [mine.instanceId] } });
    expect(required).toContainEqual(expect.stringMatching(new RegExp(`^compute:instances:update .*instance/${mine.instanceId}$`)));
    await drain();
    expect(cloud.calls).toEqual([`ensureLoadBalancer ${providerResourceName(lb.id)} ${mine.machine}`]);
  });

  it('terminates TLS with a certificate once it is ready; the certificate is not deleted while used', async () => {
    cloud.pendingTicks = 2;
    const certificate = await createCertificate();
    const lb = await createLoadBalancer({
      forwarding: [http, { entryProtocol: 'https', entryPort: 443, targetProtocol: 'http', targetPort: 8080, certificateId: certificate.id }],
    });
    await tick();
    expect((await call('loadBalancers', 'get', { tenantId: 'root', loadBalancerId: lb.id })).message).toMatch(
      /Waiting for certificate/,
    );
    await drain();
    const fake = [...cloud.loadBalancers.values()][0]!;
    expect(fake.spec.forwarding[1]).toMatchObject({ entryProtocol: 'https', certificate: [...cloud.certificates.keys()][0] });
    expect(await codeOf(call('certificates', 'delete', { tenantId: 'root', certificateId: certificate.id }))).toBe(
      'INVALID_STATE',
    );
    // https without a certificate (or passthrough) is refused before anything is written.
    expect(
      await codeOf(createLoadBalancer({ forwarding: [{ entryProtocol: 'https', entryPort: 443, targetProtocol: 'http', targetPort: 80 }] })),
    ).toBe('INVALID_INPUT');
    // Another tenant cannot name it.
    expect(
      await codeOf(
        createLoadBalancer(
          { forwarding: [{ entryProtocol: 'https', entryPort: 443, targetProtocol: 'http', targetPort: 80, certificateId: certificate.id }] },
          mallory,
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('update changes it in place; delete removes it and refunds its quota', async () => {
    const lb = await createLoadBalancer();
    await drain();
    const updated = await call('loadBalancers', 'update', {
      tenantId: 'root',
      loadBalancerId: lb.id,
      healthCheck: { protocol: 'http', port: 8080, path: '/healthz' },
    });
    expect(updated).toMatchObject({ state: 'updating', healthCheck: { path: '/healthz' }, forwarding: [http] });
    await drain();
    expect([...cloud.loadBalancers.values()][0]!.spec.healthCheck).toMatchObject({ path: '/healthz' });
    expect(await codeOf(call('loadBalancers', 'update', { tenantId: 'root', loadBalancerId: lb.id, domains: [] }))).toBe(
      'INVALID_INPUT',
    );
    await call('loadBalancers', 'delete', { tenantId: 'root', loadBalancerId: lb.id });
    await drain();
    expect(cloud.loadBalancers.size).toBe(0);
    expect(await quotaUsed('loadBalancers')).toBe(0);
    expect(events.map((event) => event.type)).toContain('providerLoadBalancer.deleted');
  });

  it('quota is fail closed, and a global load balancer targets regional ones', async () => {
    const regional = await createLoadBalancer();
    await drain();
    const global = await createLoadBalancer({
      scope: 'global',
      region: undefined,
      targets: { loadBalancerIds: [regional.id] },
      domains: [{ name: 'app.example.com' }],
    });
    await drain();
    const fake = [...cloud.loadBalancers.values()].find((entry) => entry.spec.scope === 'global')!;
    expect(fake.spec.targets.loadBalancers).toEqual([[...cloud.loadBalancers.keys()][0]]);
    expect(fake.spec.domains).toEqual([{ name: 'app.example.com' }]);
    expect(await codeOf(createLoadBalancer())).toBe('QUOTA_EXCEEDED');
    expect(await codeOf(call('loadBalancers', 'delete', { tenantId: 'root', loadBalancerId: regional.id }))).toBe(
      'INVALID_STATE',
    );
    await call('loadBalancers', 'delete', { tenantId: 'root', loadBalancerId: global.id });
    await drain();
  });
});
