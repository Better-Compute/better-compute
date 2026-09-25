import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  IamError,
  type AuditEvent,
  type Decision,
  type IamPlugin,
  type PolicyDocument,
  type PolicyStatement,
  type ResourceRef,
  type ResourceTypeDefinition,
} from '@better-iam/core';
import {
  IamError as ServerIamError,
  createSessionTokenVerifier,
  type AuthorizationCheck,
  type BatchAuthorizationRequest,
  type BetterIam,
  type BetterIamOptions,
  type GetSessionTokenInput,
  type IamBilling,
  type SessionTokenClaims,
  type UsageInput,
  type UsageReceipt,
} from '@better-iam/server';
import { createIamClient } from '@better-iam/client';
import {
  COMPUTE_AUDIENCE,
  ORIGIN,
  closeIamFixtures,
  computeCatalog,
  computePlugin,
  iamFixture,
  sessionSigningKey,
  type Credential,
  type IamFixture,
} from './support/iam.js';

/**
 * Pins every better-iam surface better-compute relies on (PLAN.md §0 "Five better-iam facts", §12.1 failure modes,
 * §12.4 resolver rules, §12.6 policies, §12.7 billing, §12.8 events, §12.10), against the vendored better-iam 0.1.0
 * packages as installed. A failure here means the vendored snapshot changed a behavior compute builds on: update the
 * plan and the bridge before updating the assertion.
 */
afterEach(closeIamFixtures);

const denied: Decision = { allowed: false, reason: 'ACCESS_DENIED', matched: [] };

/** A decision request in Acme (or `tenantId`) for one compute resource. */
function request(
  f: IamFixture,
  credential: Credential,
  action: string,
  type: string,
  id: string,
  tenantId = f.tenantId,
) {
  return { ...credential, tenantId, action, resource: { type, id } };
}

// PLAN.md §12.6, verbatim.
const gpuUserStatements: PolicyStatement[] = [
  {
    sid: 'ListInTenant',
    effect: 'allow',
    actions: ['compute:pools:read', 'compute:capacity:read', 'compute:reservations:read'],
    resources: ['compute-tenant/*'],
  },
  {
    sid: 'SeeSharedPools',
    effect: 'allow',
    actions: ['compute:pools:read', 'compute:capacity:read'],
    resources: ['compute-pool/*'],
    conditions: { ArrayContains: { 'resource.relations': 'user' } },
  },
  {
    sid: 'ReserveBoundedH100',
    effect: 'allow',
    actions: ['compute:reservations:create'],
    resources: ['compute-reservation/*'],
    conditions: {
      StringEquals: {
        'resource.gpuModel': 'H100',
        'resource.region': ['eu-west-1', 'eu-central-1'],
      },
      NumericLessThanEquals: { 'resource.gpuCount': 8, 'resource.durationHours': 72 },
      ArrayContains: { 'resource.parentRelations': 'user', 'tenant.features': 'compute.h100' },
    },
  },
  {
    sid: 'OwnReservations',
    effect: 'allow',
    actions: ['compute:reservations:read', 'compute:reservations:release'],
    resources: ['compute-reservation/*'],
    conditions: { StringEquals: { 'resource.ownerId': '${principal.id}' } },
  },
  {
    sid: 'BoundedExtend',
    effect: 'allow',
    actions: ['compute:reservations:extend'],
    resources: ['compute-reservation/*'],
    conditions: {
      StringEquals: { 'resource.ownerId': '${principal.id}' },
      NumericLessThanEquals: { 'resource.durationHours': 72 },
    },
  },
  {
    sid: 'StopWhenOverBudget',
    effect: 'deny',
    actions: [
      'compute:reservations:create',
      'compute:reservations:extend',
      'compute:instances:create',
      'compute:sandboxes:create',
      'compute:sandboxes:update',
    ],
    resources: ['*'],
    conditions: { Bool: { 'principal.spendExceeded': true } },
  },
  {
    sid: 'SessionJwtForCompute',
    effect: 'allow',
    actions: ['iam:session-tokens:create'],
    resources: ['iam/${principal.id}'],
  },
  {
    sid: 'AssertToCompute',
    effect: 'allow',
    actions: ['iam:assertions:create'],
    resources: ['iam/https://compute.example.com'],
  },
];
const gpuUser: { name: string; document: PolicyDocument } = {
  name: 'gpu-user',
  document: { version: 1, statements: gpuUserStatements },
};
const agentGuardrails: { name: string; document: PolicyDocument } = {
  name: 'agent-guardrails',
  document: {
    version: 1,
    statements: [
      {
        sid: 'AgentKeys',
        effect: 'deny',
        actions: ['compute:nodes:ssh-root', 'compute:nodes:provision', 'compute:images:publish'],
        resources: ['*'],
        conditions: { StringEquals: { 'principal.kind': 'agent' } },
      },
      {
        sid: 'DelegatedSessions',
        effect: 'deny',
        actions: ['compute:nodes:ssh-root', 'compute:nodes:provision', 'compute:images:publish'],
        resources: ['*'],
        conditions: { Bool: { 'principal.delegated': true } },
      },
      {
        sid: 'DelegatedSmall',
        effect: 'deny',
        actions: ['compute:reservations:create', 'compute:reservations:extend'],
        resources: ['compute-reservation/*'],
        conditions: {
          Bool: { 'principal.delegated': true },
          NumericGreaterThan: { 'resource.gpuCount': 4 },
        },
      },
    ],
  },
};
const statement = (sid: string): PolicyDocument => ({
  version: 1,
  statements: gpuUserStatements.filter((item) => item.sid === sid),
});

describe('decisions and failure mode (a): a host without the compute catalog', () => {
  it('masks every denial as ACCESS_DENIED, UNKNOWN_ACTION included, and validates compute:* policies only where the plugin is installed', async () => {
    const f = await iamFixture();
    const alice = await f.member('alice');
    const aliceSession = await f.signIn('alice');
    f.project('compute-pool', 'pool-1');
    const readPool = (credential: Credential) =>
      request(f, credential, 'compute:pools:read', 'compute-pool', 'pool-1');

    // No grant: the decision is opaque, without matched statements or the internal reason.
    expect(await f.iam.authorize(readPool(aliceSession))).toEqual(denied);
    await expect(f.iam.require(readPool(aliceSession))).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
    });
    // Approvals are stripped of matched statements too.
    expect(await f.iam.authorize(readPool(f.ownerCredential))).toMatchObject({
      allowed: true,
      matched: [],
    });

    // A second host on the same store without the plugin: the owner, allowed above, is denied as UNKNOWN_ACTION
    // (masked), which is decided before the resolver is consulted.
    const bare = f.host({ resolveResource: f.projection.resolve });
    const resolved = f.projection.calls.length;
    expect(await bare.authorize(readPool(f.ownerCredential))).toEqual(denied);
    await expect(bare.require(readPool(f.ownerCredential))).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
    });
    expect(f.projection.calls).toHaveLength(resolved);

    // The doctor's catalog check: only the plugin host lists compute:* actions and compute-* types.
    const catalogOf = async (host: BetterIam) => ({
      actions: (await host.api.actions.list(f.ownerCredential, { tenantId: f.tenantId })).map(
        (item) => item.name,
      ),
      types: (await host.api.resourceTypes.list(f.ownerCredential, { tenantId: f.tenantId })).map(
        (item) => item.name,
      ),
    });
    const installed = await catalogOf(f.iam);
    expect(installed.actions).toEqual(
      expect.arrayContaining(['compute:reservations:create', 'compute:nodes:ssh-root']),
    );
    expect(installed.types).toEqual(expect.arrayContaining(Object.keys(computeCatalog())));
    const missing = await catalogOf(bare);
    expect(missing.actions.filter((name) => name.startsWith('compute:'))).toEqual([]);
    expect(missing.types.filter((name) => name.startsWith('compute-'))).toEqual([]);

    // policies.create checks named actions against the constructing host's catalog...
    const document: PolicyDocument = {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:pools:read'], resources: ['compute-pool/*'] },
      ],
    };
    await expect(
      bare.api.policies.create(f.ownerCredential, {
        tenantId: f.tenantId,
        name: 'pool-readers',
        document,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACTION' });
    // ...but never resolves wildcard patterns, so `compute:*` is accepted even there.
    await expect(
      bare.api.policies.create(f.ownerCredential, {
        tenantId: f.tenantId,
        name: 'compute-wildcard',
        document: {
          version: 1,
          statements: [{ effect: 'allow', actions: ['compute:*'], resources: ['compute-pool/*'] }],
        },
      }),
    ).resolves.toMatchObject({ name: 'compute-wildcard' });
    const accepted = await f.iam.api.policies.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'pool-readers',
      document,
    });
    expect(accepted.document).toEqual(document);

    // Relationships on compute types need the plugin's type definition as well.
    const share = {
      tenantId: f.tenantId,
      type: 'compute-pool',
      id: 'pool-1',
      relation: 'user',
      subjectType: 'identity' as const,
      subjectId: alice.id,
    };
    await expect(bare.api.relationships.create(f.ownerCredential, share)).rejects.toMatchObject({
      code: 'INVALID_RESOURCE_TYPE',
    });
    await expect(f.iam.api.relationships.create(f.ownerCredential, share)).resolves.toMatchObject({
      type: 'compute-pool',
      resourceId: 'pool-1',
    });

    // The catalog is process-local: a grant stored through the plugin host still decides UNKNOWN_ACTION on the other.
    await f.bind(alice.id, [accepted.id]);
    expect((await f.iam.authorize(readPool(aliceSession))).allowed).toBe(true);
    expect(await bare.authorize(readPool(aliceSession))).toEqual(denied);
  });
});

describe('resolveResource and failure mode (b)', () => {
  it('requires the resolver to echo {tenantId, type, id}; a plugin host without one fails with RESOURCE_RESOLVER_REQUIRED', async () => {
    const f = await iamFixture();
    const reserve = request(
      f,
      f.ownerCredential,
      'compute:reservations:create',
      'compute-reservation',
      'draft-1',
    );
    const echoing = (patch: Partial<ResourceRef>) =>
      f.host({
        plugins: [computePlugin()],
        resolveResource: async (reference) => ({ ...reference, ...patch }),
      });
    expect(await echoing({}).authorize(reserve)).toMatchObject({ allowed: true });
    for (const patch of [{ id: 'draft-2' }, { type: 'compute-pool' }, { tenantId: f.rootTenantId }])
      await expect(echoing(patch).authorize(reserve)).rejects.toMatchObject({
        code: 'RESOURCE_MISMATCH',
        status: 403,
      });
    // Returning nothing is a mismatch too, never an allow or a plain deny.
    const empty = f.host({
      plugins: [computePlugin()],
      resolveResource: async () => undefined as never,
    });
    await expect(empty.authorize(reserve)).rejects.toMatchObject({
      code: 'RESOURCE_MISMATCH',
      status: 403,
    });

    const unresolved = f.host({ plugins: [computePlugin()] });
    await expect(unresolved.authorize(reserve)).rejects.toMatchObject({
      code: 'RESOURCE_RESOLVER_REQUIRED',
      status: 400,
    });
    await expect(unresolved.require(reserve)).rejects.toMatchObject({
      code: 'RESOURCE_RESOLVER_REQUIRED',
    });
    // IAM's own iam/{tenantId} checks never need it.
    expect(
      await unresolved.authorize(
        request(f, f.ownerCredential, 'iam:groups:read', 'iam', f.tenantId),
      ),
    ).toMatchObject({ allowed: true });
  });

  it('feeds resolved attributes into resource.* and parentType/parentId into resource.parentRelations', async () => {
    const f = await iamFixture();
    const alice = await f.member('alice');
    const aliceSession = await f.signIn('alice');
    // Sharing on an app-owned id: no registration with IAM is needed.
    await f.iam.api.relationships.create(f.ownerCredential, {
      tenantId: f.tenantId,
      type: 'compute-pool',
      id: 'pool-1',
      relation: 'user',
      subjectType: 'identity',
      subjectId: alice.id,
    });
    await f.grant(alice.id, {
      version: 1,
      statements: [
        {
          effect: 'allow',
          actions: ['compute:reservations:create'],
          resources: ['compute-reservation/*'],
          conditions: {
            StringEquals: { 'resource.gpuModel': 'H100' },
            ArrayContains: { 'resource.parentRelations': 'user' },
          },
        },
        {
          effect: 'allow',
          actions: ['compute:pools:read'],
          resources: ['compute-pool/*'],
          conditions: { ArrayContains: { 'resource.relations': 'user' } },
        },
      ],
    });
    const inPool = (parentId: string) => ({ parentType: 'compute-pool', parentId });
    f.project('compute-reservation', 'draft-h100', { gpuModel: 'H100', ...inPool('pool-1') });
    f.project('compute-reservation', 'draft-a100', { gpuModel: 'A100', ...inPool('pool-1') });
    f.project('compute-reservation', 'draft-elsewhere', { gpuModel: 'H100', ...inPool('pool-2') });
    f.project('compute-pool', 'pool-1');
    f.project('compute-pool', 'pool-2');
    const allowed = async (action: string, type: string, id: string) =>
      (await f.iam.authorize(request(f, aliceSession, action, type, id))).allowed;
    const create = 'compute:reservations:create';

    f.projection.calls.length = 0;
    expect(await allowed(create, 'compute-reservation', 'draft-h100')).toBe(true);
    // One resolver call per decision, with exactly the requested reference.
    expect(f.projection.calls).toEqual([
      { tenantId: f.tenantId, type: 'compute-reservation', id: 'draft-h100' },
    ]);
    expect(await allowed(create, 'compute-reservation', 'draft-a100')).toBe(false);
    expect(await allowed(create, 'compute-reservation', 'draft-elsewhere')).toBe(false);
    expect(await allowed('compute:pools:read', 'compute-pool', 'pool-1')).toBe(true);
    expect(await allowed('compute:pools:read', 'compute-pool', 'pool-2')).toBe(false);

    // A resolver miss (§12.4 throws NOT_FOUND) is not a denial: it propagates as 404 and nothing is audited.
    await expect(
      f.iam.authorize(request(f, aliceSession, create, 'compute-reservation', 'draft-missing')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(
      await f.iam.store.find('audit', { tenantId: f.tenantId, resourceId: 'draft-missing' }),
    ).toEqual([]);
    expect(
      await f.iam.store.find('audit', { tenantId: f.tenantId, resourceId: 'draft-a100' }),
    ).toMatchObject([{ outcome: 'deny', action: create, actorId: alice.id }]);
  });

  it('resolves before the tenant check, and resolves iam/{tenantId} itself only for iam:* actions (fact 4)', async () => {
    const f = await iamFixture();
    const alice = await f.member('alice');
    const aliceSession = await f.signIn('alice');
    f.project('compute-fleet', 'global', {}, f.rootTenantId);
    const inRoot = (id: string) =>
      request(f, aliceSession, 'compute:fleet:admin', 'compute-fleet', id, f.rootTenantId);

    // An Acme member asking in the root tenant: the resolver runs for the root tenant first, then TENANT_MISMATCH
    // is masked, and the denial lands on the root tenant's audit chain.
    f.projection.calls.length = 0;
    expect(await f.iam.authorize(inRoot('global'))).toEqual(denied);
    expect(f.projection.calls).toEqual([
      { tenantId: f.rootTenantId, type: 'compute-fleet', id: 'global' },
    ]);
    expect(
      await f.iam.store.find('audit', { tenantId: f.rootTenantId, resourceId: 'global' }),
    ).toMatchObject([{ outcome: 'deny', action: 'compute:fleet:admin', actorId: alice.id }]);
    // An absent id answers 404 instead of 403: the existence oracle compute's own tenant pre-check closes (§3.4).
    await expect(f.iam.authorize(inRoot('absent'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });

    // iam:* on iam/{tenantId} never reaches the resolver; a compute:* action on the same reference does.
    f.projection.calls.length = 0;
    expect(
      await f.iam.authorize(request(f, f.ownerCredential, 'iam:groups:read', 'iam', f.tenantId)),
    ).toMatchObject({ allowed: true });
    expect(f.projection.calls).toEqual([]);
    await expect(
      f.iam.authorize(request(f, f.ownerCredential, 'compute:pools:read', 'iam', f.tenantId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.projection.calls).toEqual([{ tenantId: f.tenantId, type: 'iam', id: f.tenantId }]);
  });
});

describe('authorizeMany', () => {
  it('accepts 50 checks, rejects 51 with INVALID_INPUT, and a resolver miss aborts the whole batch unaudited', async () => {
    const f = await iamFixture();
    await f.member('alice');
    const aliceSession = await f.signIn('alice');
    const checks: AuthorizationCheck[] = Array.from({ length: 51 }, (_, index) => {
      f.project('compute-pool', `pool-${index}`);
      return {
        action: 'compute:pools:read',
        resource: { type: 'compute-pool', id: `pool-${index}` },
      };
    });
    const batch = (items: AuthorizationCheck[]) =>
      f.iam.authorizeMany({ ...aliceSession, tenantId: f.tenantId, checks: items });

    const { results } = await batch(checks.slice(0, 50));
    expect(results).toHaveLength(50);
    expect(results[0]).toEqual({ ...checks[0], allowed: false, reason: 'ACCESS_DENIED' });
    expect(results.every((result) => !result.allowed && result.reason === 'ACCESS_DENIED')).toBe(
      true,
    );
    for (const size of [51, 0])
      await expect(batch(checks.slice(0, size))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        status: 400,
        message: 'Provide 1-50 authorization checks',
      });

    // One unresolvable check fails the batch; the denials evaluated before it roll back with it.
    const audited = async () =>
      (await f.iam.store.find('audit', { tenantId: f.tenantId, resourceId: 'pool-0' })).length;
    const before = await audited();
    expect(before).toBe(1);
    await expect(
      batch([
        checks[0]!,
        { action: 'compute:pools:read', resource: { type: 'compute-pool', id: 'missing' } },
      ]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(await audited()).toBe(before);
  });
});

describe('billing (§12.7)', () => {
  it('records usage idempotently by idempotencyKey and all-or-nothing through iam.billing.recordMany', async () => {
    const f = await iamFixture();
    for (const key of ['gpu.h100.hours', 'node.metal.hours'])
      await f.iam.api.billing.createMeter(f.rootCredential, {
        tenantId: f.rootTenantId,
        key,
        name: key,
        unit: 'hour',
      });
    const alice = await f.member('alice');
    const bob = await f.member('bob');
    const hour = 3_600_000;
    const usage = (windowStart: number, extra: Partial<UsageInput> = {}): UsageInput => ({
      tenantId: f.tenantId,
      meter: 'gpu.h100.hours',
      quantity: 8,
      identityId: alice.id,
      occurredAt: f.now() - hour,
      tags: { region: 'eu-west-1', pool: 'pool-1', gpuModel: 'H100' },
      idempotencyKey: `cmp:alloc-1:${windowStart}`,
      ...extra,
    });

    const first = await f.iam.billing.recordMany([usage(0), usage(hour)]);
    expect(first.map((receipt) => receipt.duplicate)).toEqual([false, false]);
    // A replayed flush returns the first receipts and records nothing twice.
    const replay = await f.iam.billing.recordMany([usage(0), usage(hour), usage(2 * hour)]);
    expect(replay.map((receipt) => receipt.duplicate)).toEqual([true, true, false]);
    expect(replay[0]!.id).toBe(first[0]!.id);

    // One event for an identity that does not exist fails the whole batch...
    await expect(
      f.iam.billing.recordMany([usage(3 * hour), usage(4 * hour, { identityId: 'no-such-id' })]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'Identity not found' });
    // ...as does one for an identity deleted before the flush (the §12.8 offboarding case)...
    await f.iam.api.identities.delete(f.ownerCredential, {
      tenantId: f.tenantId,
      identityId: bob.id,
    });
    await expect(
      f.iam.billing.recordMany([usage(3 * hour), usage(4 * hour, { identityId: bob.id })]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // ...and neither recorded anything: the good event is still new when it is sent alone.
    expect((await f.iam.billing.recordMany([usage(3 * hour)]))[0]!.duplicate).toBe(false);

    // A key reused on another meter is a CONFLICT, which the usage sink dead-letters.
    await expect(
      f.iam.billing.recordMany([usage(0, { meter: 'node.metal.hours' })]),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    // Batch caps: 1000 events in process, 100 through the credentialed API (remote mode).
    for (const size of [0, 1001])
      await expect(
        f.iam.billing.recordMany(Array.from({ length: size }, (_, index) => usage(index))),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const events = Array.from({ length: 101 }, (_, index) => {
      const { tenantId: _tenantId, ...event } = usage(index);
      return event;
    });
    await expect(
      // better-iam 0.1.0 types `events` as `Omit<UsageInput, 'tenantId'> & {...}[]` (an array intersected with one
      // event), so a correct array needs a cast.
      f.iam.api.billing.recordMany(f.ownerCredential, {
        tenantId: f.tenantId,
        events: events as never,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'events must list 1-100 usage events',
    });
  });
});

describe('event intake (§12.8)', () => {
  /** Records one audited denial on `host` whose resource id names it. */
  async function deny(f: IamFixture, host: BetterIam, credential: Credential, marker: string) {
    f.project('compute-pool', marker);
    expect(
      await host.authorize(request(f, credential, 'compute:pools:read', 'compute-pool', marker)),
    ).toEqual(denied);
  }
  const hooksFor = async (f: IamFixture, marker: string) =>
    (await f.iam.store.find('auditHooks', { tenantId: f.tenantId })).filter(
      (row) => (row.event as AuditEvent).resourceId === marker,
    );

  it('queues events only where the recording host has afterAudit, onEvent or a subscriber, and runs the dispatching host handlers', async () => {
    const seen: AuditEvent[] = [];
    const f = await iamFixture({
      plugins: [
        computePlugin({
          afterAudit: async (event) => {
            seen.push(event);
          },
        }),
      ],
    });
    await f.member('alice');
    const aliceSession = await f.signIn('alice');
    await f.iam.events.dispatch();
    seen.length = 0;
    const markers = () => seen.map((event) => event.resourceId);
    // Catalog and resolver, but no afterAudit, onEvent or subscriber.
    const bare = f.host({ plugins: [computePlugin()], resolveResource: f.projection.resolve });

    await deny(f, bare, aliceSession, 'recorded-by-bare');
    await deny(f, f.iam, aliceSession, 'recorded-by-compute');
    expect(
      await f.iam.store.find('audit', { tenantId: f.tenantId, resourceId: 'recorded-by-bare' }),
    ).toHaveLength(1);
    expect(await hooksFor(f, 'recorded-by-bare')).toEqual([]);
    expect(await f.iam.events.dispatch()).toEqual({ dispatched: 1 });
    expect(markers()).toEqual(['recorded-by-compute']);
    // The fields the inbox stores (event_id, tenant_id, sequence, occurred_at).
    expect(seen[0]).toMatchObject({
      id: expect.any(String),
      tenantId: f.tenantId,
      action: 'compute:pools:read',
      outcome: 'deny',
      sequence: expect.any(Number),
      timestamp: expect.any(Number),
    });

    // A subscriber alone makes the recording host queue its events; whoever dispatches then delivers them.
    const unsubscribe = bare.events.subscribe('nothing:*', () => {});
    await deny(f, bare, aliceSession, 'recorded-while-subscribed');
    unsubscribe();
    expect(await f.iam.events.dispatch()).toEqual({ dispatched: 1 });
    expect(markers()).toEqual(['recorded-by-compute', 'recorded-while-subscribed']);

    // A dispatcher without compute's afterAudit marks rows delivered that compute never saw.
    await deny(f, f.iam, aliceSession, 'swallowed');
    expect(await bare.events.dispatch()).toEqual({ dispatched: 1 });
    expect(await hooksFor(f, 'swallowed')).toMatchObject([{ delivered: true }]);
    expect(await f.iam.events.dispatch()).toEqual({ dispatched: 0 });
    expect(markers()).not.toContain('swallowed');
  });

  it('lets one throwing afterAudit block the dispatch pass: it rejects and every row stays undelivered', async () => {
    const seen: string[] = [];
    const f = await iamFixture({
      plugins: [
        computePlugin({
          afterAudit: async (event) => {
            seen.push(event.resourceId);
          },
        }),
      ],
    });
    await f.member('alice');
    const aliceSession = await f.signIn('alice');
    await f.iam.events.dispatch();
    seen.length = 0;
    await deny(f, f.iam, aliceSession, 'blocked-1');
    await deny(f, f.iam, aliceSession, 'blocked-2');
    // Per-tenant chain positions are contiguous: what the inbox worker orders by.
    const [one] = await f.iam.store.find<AuditEvent>('audit', {
      tenantId: f.tenantId,
      resourceId: 'blocked-1',
    });
    const [two] = await f.iam.store.find<AuditEvent>('audit', {
      tenantId: f.tenantId,
      resourceId: 'blocked-2',
    });
    expect(two!.sequence).toBe(one!.sequence! + 1);

    const reached: string[] = [];
    const broken = f.host({
      plugins: [
        computePlugin({
          afterAudit: async () => {
            throw new Error('compute inbox unreachable');
          },
        }),
        {
          id: 'later-plugin',
          afterAudit: async (event) => {
            reached.push(`plugin:${event.resourceId}`);
          },
        },
      ],
      resolveResource: f.projection.resolve,
      events: {
        onEvent: (event) => {
          reached.push(`onEvent:${event.resourceId}`);
        },
      },
    });
    broken.events.subscribe('*', (event) => {
      reached.push(`subscriber:${event.resourceId}`);
    });
    const undelivered = async () =>
      (await f.iam.store.find('auditHooks', { delivered: false })).length;
    expect(await undelivered()).toBe(2);
    // The same head row fails every pass: nothing after it runs, nothing is marked delivered.
    for (let pass = 0; pass < 2; pass++)
      await expect(broken.events.dispatch()).rejects.toThrow('compute inbox unreachable');
    expect(reached).toEqual([]);
    expect(await undelivered()).toBe(2);
    // A healthy dispatcher then delivers both rows.
    expect(await f.iam.events.dispatch()).toEqual({ dispatched: 2 });
    expect(seen.sort()).toEqual(['blocked-1', 'blocked-2']);
    expect(await undelivered()).toBe(0);
  });
});

describe('delegated confirmation', () => {
  it('refuses requestConfirmation with INVALID_INPUT for actions confirm[] does not hold back, and keys approvals by (action, type, id)', async () => {
    const f = await iamFixture();
    const alice = await f.member('alice');
    const aliceSession = await f.signIn('alice');
    const reservations = await f.policy({
      version: 1,
      statements: [
        {
          effect: 'allow',
          actions: ['compute:reservations:*'],
          resources: ['compute-reservation/*'],
        },
      ],
    });
    const guardrails = await f.policy(agentGuardrails.document, agentGuardrails.name);
    await f.bind(alice.id, [reservations.id, guardrails.id]);
    const agent = await f.iam.api.agents.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'Scheduler agent',
      model: 'claude-sonnet-5',
    });
    const key = await f.iam.api.credentials.create(f.ownerCredential, {
      tenantId: f.tenantId,
      identityId: agent.id,
    });
    const delegation = await f.iam.api.delegations.grant(aliceSession, {
      tenantId: f.tenantId,
      agentId: agent.id,
      scopes: ['compute:reservations:*'],
      confirm: ['compute:reservations:create'],
    });
    const acting: Credential = {
      token: (
        await f.iam.api.delegations.assume(
          { token: key.token },
          { tenantId: f.tenantId, delegationId: delegation.id },
        )
      ).token,
    };
    f.project('compute-reservation', 'draft-small', { gpuCount: 2 });
    f.project('compute-reservation', 'draft-other', { gpuCount: 2 });
    f.project('compute-reservation', 'draft-big', { gpuCount: 8 });
    const create = 'compute:reservations:create';
    const decide = (credential: Credential, action: string, id: string) =>
      f.iam.authorize(request(f, credential, action, 'compute-reservation', id));
    const ask = (action: string, id: string) =>
      f.iam.api.delegations.requestConfirmation(acting, {
        tenantId: f.tenantId,
        action,
        resource: { type: 'compute-reservation', id },
        reason: 'Reserve GPUs for the nightly run',
      });
    const approve = (confirmationId: string) =>
      f.iam.api.delegations.decideConfirmation(aliceSession, {
        tenantId: f.tenantId,
        confirmationId,
        approve: true,
      });

    expect((await decide(acting, 'compute:reservations:read', 'draft-small')).allowed).toBe(true);
    // Held back: denied (CONFIRMATION_REQUIRED, masked) until the person confirms.
    expect(await decide(acting, create, 'draft-small')).toEqual(denied);
    for (const action of ['compute:reservations:read', 'compute:reservations:extend'])
      await expect(ask(action, 'draft-small')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'This delegation does not hold that action back for confirmation',
      });
    const pending = await ask(create, 'draft-small');
    expect(pending).toMatchObject({
      status: 'pending',
      action: create,
      resource: { type: 'compute-reservation', id: 'draft-small' },
      subjectId: alice.id,
    });
    await approve(pending.id);
    expect((await decide(acting, create, 'draft-small')).allowed).toBe(true);
    expect(await decide(acting, create, 'draft-other')).toEqual(denied);

    // principal.delegated is true for the delegated session: agent-guardrails' DelegatedSmall still denies >4 GPUs
    // after an approval, while alice's own session is not affected.
    await approve((await ask(create, 'draft-big')).id);
    expect(await decide(acting, create, 'draft-big')).toEqual(denied);
    expect((await decide(aliceSession, create, 'draft-big')).allowed).toBe(true);
  });
});

describe('session JWTs for compute (§12.2)', () => {
  it('mints a JWT for [issuer, compute] only with iam:session-tokens:create and iam:assertions:create, and IAM accepts it', async () => {
    const f = await iamFixture({
      sts: { jwt: { signingKeys: [sessionSigningKey()], audiences: [COMPUTE_AUDIENCE] } },
    });
    const issuer = f.iam.sessionTokens!.issuer;
    expect(issuer).toBe(`${ORIGIN}/api/iam`);
    const alice = await f.member('alice');
    const aliceSession = await f.signIn('alice');
    const mint = (audience: string[]) =>
      f.iam.api.sts.getSessionToken(aliceSession, { format: 'jwt', audience });
    await f.grant(alice.id, statement('ListInTenant'));
    f.project('compute-tenant', f.tenantId);

    // Nothing is minted without iam:session-tokens:create on iam/{identityId}.
    await expect(mint([issuer, COMPUTE_AUDIENCE])).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
    });
    await f.grant(alice.id, statement('SessionJwtForCompute'));
    expect((await mint([issuer])).audience).toEqual([issuer]);
    // Naming compute needs iam:assertions:create on iam/<computeAud> as well.
    await expect(mint([issuer, COMPUTE_AUDIENCE])).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
      message: `This credential may not obtain tokens for audience ${COMPUTE_AUDIENCE}`,
    });
    // An audience outside sts.jwt.audiences is refused outright.
    await expect(mint([issuer, 'https://other.example.com'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await f.grant(alice.id, statement('AssertToCompute'));
    const minted = await mint([issuer, COMPUTE_AUDIENCE]);
    expect(minted.audience).toEqual([issuer, COMPUTE_AUDIENCE]);

    // Accepted by iam.authorize / authenticate like any credential of alice's.
    const listTenant = (token: string) =>
      f.iam.authorize(request(f, { token }, 'compute:pools:read', 'compute-tenant', f.tenantId));
    expect(await listTenant(minted.token)).toMatchObject({ allowed: true });
    expect((await f.iam.authenticate({ token: minted.token })).session).toMatchObject({
      kind: 'session-token',
      format: 'jwt',
      identityId: alice.id,
    });
    // The online check compute's embedded mode uses, and the offline verifier remote reads use.
    const claims = await f.iam.sessionTokens!.verify(minted.token, { audience: COMPUTE_AUDIENCE });
    expect(claims).toMatchObject({
      iss: issuer,
      aud: [issuer, COMPUTE_AUDIENCE],
      sub: alice.id,
      tid: f.tenantId,
      kind: 'session-token',
    });
    const offline = createSessionTokenVerifier({
      issuer,
      audience: COMPUTE_AUDIENCE,
      jwks: f.iam.sessionTokens!.jwks(),
      now: f.now,
    });
    expect((await offline.verify(minted.token)).sid).toBe(claims.sid);

    // Signing out the source ends the token inside IAM at once; an offline verifier cannot know until exp.
    await f.iam.api.auth.signOut(aliceSession);
    await expect(
      f.iam.sessionTokens!.verify(minted.token, { audience: COMPUTE_AUDIENCE }),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION_TOKEN', reason: 'revoked' });
    await expect(listTenant(minted.token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await offline.verify(minted.token)).sid).toBe(claims.sid);
  });
});

describe('§12.6 example policies', () => {
  it('accepts gpu-user and agent-guardrails verbatim and evaluates their resource.*, tenant.features and principal.* conditions', async () => {
    const f = await iamFixture();
    const alice = await f.member('alice');
    const bob = await f.member('bob');
    const aliceSession = await f.signIn('alice');
    const ids: string[] = [];
    for (const { name, document } of [gpuUser, agentGuardrails]) {
      const policy = await f.iam.api.policies.create(f.ownerCredential, {
        tenantId: f.tenantId,
        name,
        document,
      });
      expect(policy).toMatchObject({ name, document });
      ids.push(policy.id);
    }
    const bare = f.host({ resolveResource: f.projection.resolve });
    for (const { document } of [gpuUser, agentGuardrails])
      await expect(
        bare.api.policies.create(f.ownerCredential, {
          tenantId: f.tenantId,
          name: 'without-plugin',
          document,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACTION' });

    await f.bind(alice.id, ids);
    await f.iam.api.relationships.create(f.ownerCredential, {
      tenantId: f.tenantId,
      type: 'compute-pool',
      id: 'pool-1',
      relation: 'user',
      subjectType: 'identity',
      subjectId: alice.id,
    });
    f.project('compute-tenant', f.tenantId);
    f.project('compute-pool', 'pool-1');
    f.project('compute-pool', 'pool-2');
    const draft = (id: string, attributes: Record<string, unknown> = {}) =>
      f.project('compute-reservation', id, {
        region: 'eu-west-1',
        gpuModel: 'H100',
        gpuCount: 8,
        durationHours: 72,
        parentType: 'compute-pool',
        parentId: 'pool-1',
        ownerId: alice.id,
        ...attributes,
      });
    draft('draft-ok');
    draft('draft-9-gpus', { gpuCount: 9 });
    draft('draft-73-hours', { durationHours: 73 });
    draft('draft-us', { region: 'us-east-1' });
    draft('draft-a100', { gpuModel: 'A100' });
    draft('draft-unshared-pool', { parentId: 'pool-2' });
    draft('draft-of-bob', { ownerId: bob.id });
    const allowed = async (action: string, type: string, id: string) =>
      (await f.iam.authorize(request(f, aliceSession, action, type, id))).allowed;
    const create = 'compute:reservations:create';

    // ReserveBoundedH100 needs the tenant flag, read through tenant.features.
    expect(await allowed(create, 'compute-reservation', 'draft-ok')).toBe(false);
    await f.iam.api.features.create(f.rootCredential, {
      tenantId: f.rootTenantId,
      key: 'compute.h100',
      defaultValue: true,
    });
    expect(await allowed(create, 'compute-reservation', 'draft-ok')).toBe(true);
    for (const id of [
      'draft-9-gpus',
      'draft-73-hours',
      'draft-us',
      'draft-a100',
      'draft-unshared-pool',
    ])
      expect(await allowed(create, 'compute-reservation', id)).toBe(false);
    // ListInTenant and SeeSharedPools.
    expect(await allowed('compute:pools:read', 'compute-tenant', f.tenantId)).toBe(true);
    expect(await allowed('compute:pools:read', 'compute-pool', 'pool-1')).toBe(true);
    expect(await allowed('compute:pools:read', 'compute-pool', 'pool-2')).toBe(false);
    // OwnReservations and BoundedExtend (${principal.id}).
    expect(await allowed('compute:reservations:release', 'compute-reservation', 'draft-ok')).toBe(
      true,
    );
    expect(
      await allowed('compute:reservations:release', 'compute-reservation', 'draft-of-bob'),
    ).toBe(false);
    expect(await allowed('compute:reservations:extend', 'compute-reservation', 'draft-ok')).toBe(
      true,
    );
    expect(
      await allowed('compute:reservations:extend', 'compute-reservation', 'draft-73-hours'),
    ).toBe(false);
  });
});

describe('remote mode (v0.4)', () => {
  it('serves the same masked decisions and the 50-check cap to a bearer-less client that forwards the caller per call', async () => {
    const f = await iamFixture();
    await f.member('alice');
    const aliceSession = await f.signIn('alice');
    f.project('compute-pool', 'pool-1');
    const client = createIamClient<BetterIam>({
      baseURL: ORIGIN,
      fetch: async (input, init) => f.iam.handler(new Request(input, init)),
    });
    const as = (credential: Credential) => ({
      headers: { authorization: `Bearer ${credential.token}` },
    });
    const pool = {
      tenantId: f.tenantId,
      action: 'compute:pools:read',
      resource: { type: 'compute-pool', id: 'pool-1' },
    };
    expect(await client.authorize(pool, as(aliceSession))).toEqual(denied);
    expect(await client.authorize(pool, as(f.ownerCredential))).toMatchObject({ allowed: true });
    await expect(client.authorize(pool)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    const checks = Array.from({ length: 51 }, () => ({
      action: pool.action,
      resource: pool.resource,
    }));
    expect(
      (
        await client.authorizeMany(
          { tenantId: f.tenantId, checks: checks.slice(0, 50) },
          as(aliceSession),
        )
      ).results,
    ).toHaveLength(50);
    await expect(
      client.authorizeMany({ tenantId: f.tenantId, checks }, as(aliceSession)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
  });
});

describe('type shapes', () => {
  it('keeps the better-iam types compute builds on', () => {
    // Plugin and catalog (§12.3).
    expectTypeOf<IamPlugin['id']>().toEqualTypeOf<string>();
    expectTypeOf<IamPlugin['actions']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<IamPlugin['resourceTypes']>().toEqualTypeOf<
      Record<string, ResourceTypeDefinition> | undefined
    >();
    expectTypeOf<IamPlugin['afterAudit']>().toEqualTypeOf<
      ((event: AuditEvent) => Promise<void>) | undefined
    >();
    expectTypeOf<ResourceTypeDefinition['actions']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<ResourceTypeDefinition['attributes']>().toEqualTypeOf<
      Record<string, 'string' | 'number' | 'boolean'> | undefined
    >();
    expectTypeOf<ResourceTypeDefinition['parent']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ResourceTypeDefinition['relations']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<ResourceTypeDefinition['managed']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf(computePlugin()).toMatchTypeOf<IamPlugin>();

    // Audit events as the inbox stores them (§12.8).
    expectTypeOf<AuditEvent['id']>().toEqualTypeOf<string>();
    expectTypeOf<AuditEvent['tenantId']>().toEqualTypeOf<string>();
    expectTypeOf<AuditEvent['action']>().toEqualTypeOf<string>();
    expectTypeOf<AuditEvent['sequence']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AuditEvent['timestamp']>().toEqualTypeOf<number>();

    // Resolver and decisions (§12.4, IamPort).
    expectTypeOf<ResourceRef>().toEqualTypeOf<{ tenantId: string; type: string; id: string }>();
    type Resolver = NonNullable<BetterIamOptions['resolveResource']>;
    expectTypeOf<Resolver>().parameters.toEqualTypeOf<[reference: ResourceRef]>();
    expectTypeOf<Resolver>().returns.toEqualTypeOf<
      Promise<ResourceRef & { attributes?: Record<string, unknown> }>
    >();
    expectTypeOf<Decision>().toEqualTypeOf<{
      allowed: boolean;
      reason: string;
      matched: string[];
    }>();
    expectTypeOf<BetterIam['authorize']>().returns.resolves.toEqualTypeOf<Decision>();
    expectTypeOf<BetterIam['require']>().returns.resolves.toEqualTypeOf<void>();
    expectTypeOf<BetterIam['authorizeMany']>()
      .parameter(0)
      .toEqualTypeOf<BatchAuthorizationRequest>();
    expectTypeOf<
      Awaited<ReturnType<BetterIam['authorizeMany']>>['results'][number]
    >().toEqualTypeOf<AuthorizationCheck & { allowed: boolean; reason: string }>();
    expectTypeOf<IamError['code']>().toEqualTypeOf<string>();
    expectTypeOf<IamError['status']>().toEqualTypeOf<number>();

    // Billing (§12.7): no agentId on UsageInput (U9).
    expectTypeOf<IamBilling['recordMany']>().toEqualTypeOf<
      (events: UsageInput[]) => Promise<UsageReceipt[]>
    >();
    expectTypeOf<UsageInput['idempotencyKey']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UsageInput['identityId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UsageInput['tags']>().toEqualTypeOf<Record<string, string> | undefined>();
    expectTypeOf<UsageInput>().not.toHaveProperty('agentId');
    expectTypeOf<UsageReceipt['duplicate']>().toEqualTypeOf<boolean>();

    // Events, flags and session JWTs.
    expectTypeOf<BetterIam['events']['dispatch']>().returns.resolves.toEqualTypeOf<{
      dispatched: number;
    }>();
    expectTypeOf<BetterIam['features']['isEnabled']>().toEqualTypeOf<
      (tenantId: string, key: string) => Promise<boolean>
    >();
    expectTypeOf<GetSessionTokenInput['format']>().toEqualTypeOf<'opaque' | 'jwt' | undefined>();
    expectTypeOf<GetSessionTokenInput['audience']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<NonNullable<BetterIam['sessionTokens']>['verify']>().toEqualTypeOf<
      (token: string, options?: { audience?: string }) => Promise<SessionTokenClaims>
    >();
    expectTypeOf<SessionTokenClaims['aud']>().toEqualTypeOf<string | string[]>();

    // One error class: compute's `instanceof IamError` checks hold for errors raised by the server.
    expect(ServerIamError).toBe(IamError);
  });
});
