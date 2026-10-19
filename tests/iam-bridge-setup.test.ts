import { afterEach, describe, expect, it } from 'vitest';
import {
  checkIamHost,
  computeMeters,
  meterCatalog,
  createComputeIamBridge,
  examplePolicies,
  gpuMeterKey,
  iamJobReconcilers,
  iamJobs,
  memoryInbox,
  setupIamMeters,
  type IamJobsHost,
} from '@better-compute/iam';
import {
  closeIamFixtures,
  COMPUTE_AUDIENCE,
  iamFixture,
  sessionSigningKey,
} from './support/iam.js';
import { createEmbeddedTestIam } from '@better-compute/iam/testing';

// better-iam's scheduler jobs under worker role `iam`, `iam setup` (meters and example policies) and the
// per-host doctor checks (PLAN.md §12.1, §12.6, §12.7).

afterEach(closeIamFixtures);

describe('IAM jobs', () => {
  it('runs better-iam scheduler jobs as singleton periodic reconcilers', async () => {
    expect(iamJobs.map((job) => [job.name, job.every])).toEqual([
      ['iam.jobs.audit-hooks', '1s'],
      ['iam.jobs.auth-outbox', '5s'],
      ['iam.jobs.budgets', '1h'],
      ['iam.jobs.close-period', '1h'],
      ['iam.jobs.sweep', '1h'],
    ]);
    const inbox = memoryInbox();
    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin({ inbox })],
      resolveResource: bridge.resolveResource(),
    });
    const reconcilers = iamJobReconcilers(f.iam);
    expect(reconcilers.every((reconciler) => reconciler.shardBy === 'none')).toBe(true);
    const agent = await f.iam.api.agents.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'Nightly',
      model: 'claude-sonnet-5',
    });
    await f.iam.api.agents.suspend(f.ownerCredential, { tenantId: f.tenantId, agentId: agent.id });
    // The audit-hooks job is what delivers IAM events to compute's inbox in the supported topology.
    for (const reconciler of reconcilers)
      expect(await reconciler.run({} as never, 'run'), reconciler.name).toMatch(
        /^(DONE|SYNC_AGAIN)$/,
      );
    expect(inbox.events.some((event) => event.action === 'agent:suspend')).toBe(true);
    expect(await f.iam.store.find('auditHooks', { delivered: false })).toEqual([]);
  });

  it('reports job failures and runs again next period, and filters jobs', async () => {
    const failing: IamJobsHost = {
      events: { dispatch: async () => ({ dispatched: 250 }) },
      auth: { dispatchOutbox: () => Promise.reject(new Error('smtp down')) },
      billing: { checkBudgets: async () => ({}), closePeriod: async () => ({}) },
      sweepExpired: async () => ({ truncated: true }),
    };
    const errors: string[] = [];
    const reconcilers = iamJobReconcilers(failing, {
      onError: (error, job) => {
        errors.push(`${job}: ${(error as Error).message}`);
        throw new Error('reporters cannot break the loop');
      },
    });
    const outcome = async (name: string) =>
      reconcilers.find((item) => item.name === name)!.run({} as never, 'run');
    expect(await outcome('iam.jobs.audit-hooks')).toBe('SYNC_AGAIN');
    expect(await outcome('iam.jobs.auth-outbox')).toBe('DONE');
    expect(await outcome('iam.jobs.sweep')).toBe('SYNC_AGAIN');
    expect(errors).toEqual(['iam.jobs.auth-outbox: smtp down']);
    expect(
      iamJobReconcilers(failing, { only: ['iam.jobs.sweep'] }).map((item) => item.name),
    ).toEqual(['iam.jobs.sweep']);
  });

  it('closes the period hourly, only once the month is closeGraceHours old (D18)', async () => {
    const closes: number[] = [];
    let now = Date.UTC(2026, 10, 1, 0, 3);
    const host: IamJobsHost = {
      events: { dispatch: async () => ({ dispatched: 0 }) },
      auth: { dispatchOutbox: async () => ({}) },
      billing: {
        checkBudgets: async () => ({}),
        closePeriod: async () => {
          closes.push(now);
          return {};
        },
      },
      sweepExpired: async () => ({}),
    };
    const close = () =>
      iamJobReconcilers(host, { only: ['iam.jobs.close-period'], now: () => now })[0]!.run(
        {} as never,
        'run',
      );
    // 00:03 on the 1st: the month that just ended may still have windows to flush.
    expect(await close()).toBe('DONE');
    now = Date.UTC(2026, 10, 1, 5, 59, 59);
    await close();
    expect(closes).toEqual([]);
    // 06:00: the grace has passed, the previous month closes; closing again is harmless.
    now = Date.UTC(2026, 10, 1, 6);
    await close();
    now = Date.UTC(2026, 10, 1, 7);
    await close();
    expect(closes).toEqual([Date.UTC(2026, 10, 1, 6), Date.UTC(2026, 10, 1, 7)]);
    // The run's context clock when no `now` is injected; a grace of 0 closes at once.
    const viaContext = iamJobReconcilers(host, {
      only: ['iam.jobs.close-period'],
      closeGraceHours: 0,
    })[0]!;
    now = Date.UTC(2026, 11, 1, 0, 0, 1);
    await viaContext.run({ clock: { now: () => Date.UTC(2026, 11, 1) } } as never, 'run');
    expect(closes).toHaveLength(3);
    for (const closeGraceHours of [-1, 73, Number.NaN])
      expect(() => iamJobReconcilers(host, { closeGraceHours })).toThrow(/closeGraceHours/);
  });

  it('closing a period twice on a real better-iam is harmless', async () => {
    const at = Date.UTC(2026, 10, 1, 7);
    const t = await createEmbeddedTestIam({ now: () => at });
    try {
      const job = iamJobReconcilers(t.iam as unknown as IamJobsHost, {
        only: ['iam.jobs.close-period'],
        now: () => at,
      })[0]!;
      const errors: unknown[] = [];
      const twice = iamJobReconcilers(t.iam as unknown as IamJobsHost, {
        only: ['iam.jobs.close-period'],
        now: () => at,
        onError: (error) => errors.push(error),
      })[0]!;
      expect(await job.run({} as never, 'run')).toBe('DONE');
      expect(await twice.run({} as never, 'run')).toBe('DONE');
      expect(errors).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('adds the jobs to the iam module with runIamJobs, and refuses hosts that cannot run them', async () => {
    const f = await iamFixture();
    const bridge = createComputeIamBridge();
    bridge.embedded(f.iam, { rootTenantId: f.rootTenantId, runIamJobs: true });
    expect(bridge.modules[0].reconcilers!.map((reconciler) => reconciler.name)).toEqual([
      'iam.inbox',
      'iam.reconcile',
      'iam.usage',
      ...iamJobs.map((job) => job.name),
    ]);
    const other = createComputeIamBridge();
    const { events: _events, ...withoutEvents } = f.iam;
    expect(() => other.embedded(withoutEvents as never, { runIamJobs: true })).toThrow(
      /runIamJobs needs/,
    );
  });
});

describe('iam setup', () => {
  it('names one meter per GPU model plus the node and VPS meters', () => {
    expect(
      computeMeters(['H100', 'RTX-PRO-6000', 'H100', 'other']).map((meter) => meter.key),
    ).toEqual([
      'gpu.h100.hours',
      'gpu.rtx-pro-6000.hours',
      'node.metal.hours',
      'vps.vcpu.hours',
      'vps.memory.gib.hours',
      'vps.sandbox.warm',
    ]);
    expect(() => gpuMeterKey('other')).toThrow(/No meter/);
    expect(() => gpuMeterKey('H 100')).toThrow(/No meter/);
  });

  it('creates missing meters once with a root credential', async () => {
    const f = await iamFixture();
    const root = { credential: f.rootCredential, tenantId: f.rootTenantId };
    const meters = computeMeters(['H100', 'B200']);
    await f.iam.api.billing.createMeter(f.rootCredential, {
      tenantId: f.rootTenantId,
      key: 'gpu.h100.hours',
      name: 'pre-existing',
      unit: 'hour',
    });
    expect(await setupIamMeters(f.iam.api, root, meters)).toEqual({
      created: [
        'gpu.b200.hours',
        'node.metal.hours',
        'vps.vcpu.hours',
        'vps.memory.gib.hours',
        'vps.sandbox.warm',
      ],
      existing: ['gpu.h100.hours'],
    });
    expect((await setupIamMeters(f.iam.api, root, meters)).created).toEqual([]);
  });

  it('creates the whole catalog with each meter’s pricing, once', async () => {
    const f = await iamFixture();
    const root = { credential: f.rootCredential, tenantId: f.rootTenantId };
    const catalog = meterCatalog({ gpuModels: ['H100'] });
    const reported = {
      key: 'vps.passthrough',
      name: 'Pass-through',
      unit: 'currency',
      pricing: 'reported' as const,
    };
    const first = await setupIamMeters(f.iam.api, root, [...catalog, reported]);
    expect(first.created).toEqual([...catalog.map((meter) => meter.key), 'vps.passthrough']);
    const listed = await f.iam.api.billing.listMeters(f.rootCredential, {
      tenantId: f.rootTenantId,
    });
    expect(listed.find((meter) => meter.key === 'vm.vcpu.hours')).toMatchObject({
      pricing: 'rate-card',
    });
    expect(listed.find((meter) => meter.key === 'vps.passthrough')).toMatchObject({
      pricing: 'reported',
    });
    expect(await setupIamMeters(f.iam.api, root, catalog)).toEqual({
      created: [],
      existing: catalog.map((meter) => meter.key),
    });
  });

  it('prints §12.6 policies that validate only on a host with compute’s catalog', async () => {
    const policies = examplePolicies({ audience: COMPUTE_AUDIENCE });
    expect(policies.map((policy) => policy.name)).toEqual(['gpu-user', 'agent-guardrails']);
    const gpuUser = policies[0]!.document.statements;
    expect(gpuUser.map((statement) => statement.sid)).toEqual([
      'ListInTenant',
      'SeeSharedPools',
      'ReserveBoundedH100',
      'OwnReservations',
      'BoundedExtend',
      'StopWhenOverBudget',
      'SessionJwtForCompute',
      'AssertToCompute',
    ]);
    expect(gpuUser.at(-1)!.resources).toEqual([`iam/${COMPUTE_AUDIENCE}`]);
    const custom = examplePolicies({
      audience: 'https://c',
      gpuModel: 'B200',
      maxGpus: 4,
      typePrefix: 'gpu-',
    });
    const reserve = custom[0]!.document.statements[2]!;
    expect(reserve).toMatchObject({
      sid: 'ReserveBoundedB200',
      resources: ['gpu-reservation/*'],
      conditions: {
        NumericLessThanEquals: { 'resource.gpuCount': 4 },
        ArrayContains: { 'tenant.features': 'compute.b200' },
      },
    });

    const bridge = createComputeIamBridge();
    const f = await iamFixture({ plugins: [bridge.plugin({ inbox: memoryInbox() })] });
    const bare = f.host();
    for (const policy of policies) {
      await expect(
        f.iam.api.policies.create(f.ownerCredential, { tenantId: f.tenantId, ...policy }),
      ).resolves.toMatchObject({ name: policy.name });
      await expect(
        bare.api.policies.create(f.ownerCredential, {
          tenantId: f.tenantId,
          ...policy,
          name: `${policy.name}-bare`,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACTION' });
    }
  });
});

describe('checkIamHost', () => {
  it('passes a host with the plugin and resolver, and names each failure mode otherwise', async () => {
    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin({ inbox: memoryInbox() })],
      resolveResource: bridge.resolveResource(),
      sts: { jwt: { signingKeys: [sessionSigningKey()], audiences: [COMPUTE_AUDIENCE] } },
    });
    bridge.embedded(f.iam, { rootTenantId: f.rootTenantId });
    bridge.projection.setSource({
      load: async () => ({ rows: [], cursor: { txid: '0', seq: '0' } }),
      changes: async (cursor) => ({ changed: [], rows: [], cursor }),
      get: async () => undefined,
    });
    await bridge.projection.load();
    const options = {
      catalog: bridge.catalog,
      credential: f.rootCredential,
      rootTenantId: f.rootTenantId,
      expectSessionJwts: true,
    };
    expect(await checkIamHost(f.iam, options)).toEqual([]);

    // Failure mode (a): no plugin at all.
    const bare = f.host({ resolveResource: bridge.resolveResource() });
    expect((await checkIamHost(bare, options)).map((finding) => finding.check)).toEqual([
      'iam.catalog',
      'iam.resource-types',
      'iam.session-jwt',
    ]);
    // Failure mode (b): the catalog without a resolver.
    const unresolved = f.host({ plugins: [bridge.plugin({ inbox: memoryInbox() })] });
    const findings = await checkIamHost(unresolved, { ...options, expectSessionJwts: false });
    expect(findings).toMatchObject([
      {
        check: 'iam.resolver',
        severity: 'error',
        message: expect.stringMatching(/RESOURCE_RESOLVER_REQUIRED/),
      },
    ]);
    // A credential that cannot read the catalog is a finding, not a crash.
    expect(
      (await checkIamHost(f.iam, { ...options, credential: { token: 'biam_ses_nope' } })).map(
        (finding) => finding.check,
      ),
    ).toEqual(['iam.catalog', 'iam.resolver']);
  });
});
