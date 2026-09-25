import { afterEach, describe, expect, it } from 'vitest';
import type { PolicyStatement } from '@better-iam/core';
import {
  apiSurface,
  computeResourceKinds,
  fleetResourceId,
  resourceType,
  type ComputeResourceKind,
} from '@better-compute/core';
import {
  createComputeIamBridge,
  memoryInbox,
  type ComputeIamBridge,
  type ProjectionRow,
} from '@better-compute/iam';
import type { IamPort } from '@better-compute/core';
import {
  ORIGIN,
  closeIamFixtures,
  iamFixture,
  type Credential,
  type IamFixture,
} from './support/iam.js';

// The IAM side of the authz matrix (PLAN.md §9.2, §16 "the authz matrix is at 100%"): every (action, resource
// type) pair the API decides on is accepted by a real better-iam carrying the bridge's plugin and resolver,
// allows once granted, and denies otherwise. The envelope side (every registered method) is W5a's generated
// tests/generated/authz-matrix.test.ts. Decisions go through compute's own IamPort: `bridge.embedded`, or with
// BETTER_COMPUTE_IAM_MODE=remote (vitest.iam-remote.config.ts) `bridge.remote` over the same IAM's HTTP API.

afterEach(closeIamFixtures);

interface Pair {
  action: string;
  kind: ComputeResourceKind;
  methods: string[];
}

/** Every distinct (action, resource kind) of §9.2, alternatives included. */
function pairs(): Pair[] {
  const byKey = new Map<string, Pair>();
  for (const row of apiSurface) {
    if (!row.action || !row.resource) continue;
    for (const target of [
      { action: row.action, resource: row.resource },
      ...(row.alternatives ?? []),
    ]) {
      const key = `${target.action} ${target.resource}`;
      const pair = byKey.get(key) ?? { action: target.action, kind: target.resource, methods: [] };
      pair.methods.push(`${row.group}.${row.method}`);
      byKey.set(key, pair);
    }
  }
  return [...byKey.values()];
}

/** A resource of every kind, visible where §12.4 says it resolves. */
async function loadProjection(bridge: ComputeIamBridge, tenantId: string) {
  const rows: ProjectionRow[] = computeResourceKinds
    .filter((kind) => kind !== 'fleet' && kind !== 'tenant')
    .map((kind) => ({ type: kind, id: `matrix-${kind}`, tenantId, attributes: {} }));
  bridge.projection.setSource({
    load: async () => ({ rows, cursor: { txid: '0', seq: '0' } }),
    changes: async (cursor) => ({ changed: [], rows: [], cursor }),
    get: async () => undefined,
  });
  await bridge.projection.load();
}

const remote = process.env.BETTER_COMPUTE_IAM_MODE === 'remote';
/** Requests the remote port sent (so a remote run provably went over HTTP). */
let httpCalls = 0;

/** Compute's port onto the fixture's IAM, in the mode the run asks for. */
function portFor(bridge: ComputeIamBridge, f: IamFixture): IamPort {
  if (!remote) return bridge.embedded(f.iam, { rootTenantId: f.rootTenantId });
  return bridge.remote({
    baseURL: ORIGIN,
    fetch: async (input, init) => {
      httpCalls++;
      return f.iam.handler(new Request(input, init));
    },
    serviceToken: () => f.rootCredential.token,
    rootTenantId: f.rootTenantId,
  });
}

const idOf = (f: IamFixture, kind: ComputeResourceKind) =>
  kind === 'fleet' ? fleetResourceId : kind === 'tenant' ? f.tenantId : `matrix-${kind}`;

describe('the IAM side of the authz matrix', () => {
  it('covers every §9.2 row, allowing each (action, type) only when granted', async () => {
    const all = pairs();
    // Every row with an action is covered by some pair (the table is normative).
    for (const row of apiSurface)
      if (row.action)
        expect(all.some((pair) => pair.methods.includes(`${row.group}.${row.method}`))).toBe(true);

    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin({ inbox: memoryInbox() })],
      resolveResource: bridge.resolveResource(),
    });
    const port = portFor(bridge, f);
    await loadProjection(bridge, f.tenantId);

    // Fleet pairs are decided in the root tenant by a root member; every other pair in Acme.
    const rootMember = await f.iam.api.identities.create(f.rootCredential, {
      tenantId: f.rootTenantId,
      email: 'operator@example.test',
      name: 'Operator',
      password: 'a strong operator password',
    });
    const rootSignIn = async (): Promise<Credential> => {
      const result = await f.iam.api.auth.signIn({
        tenantId: f.rootTenantId,
        email: 'operator@example.test',
        password: 'a strong operator password',
      });
      if (!('token' in result)) throw new Error('Unexpected MFA for a root member');
      return { token: result.token };
    };
    const granted = await f.member('granted');
    const grantedSession = await f.signIn('granted');
    await f.member('nobody');
    const nobodySession = await f.signIn('nobody');

    const statementsFor = (items: Pair[]): PolicyStatement[] =>
      items.map((pair) => ({
        effect: 'allow',
        actions: [pair.action],
        resources: [`${resourceType(pair.kind)}/*`],
      }));
    const tenantPairs = all.filter((pair) => pair.kind !== 'fleet');
    const fleetPairs = all.filter((pair) => pair.kind === 'fleet');
    for (let start = 0; start < tenantPairs.length; start += 20)
      await f.grant(granted.id, {
        version: 1,
        statements: statementsFor(tenantPairs.slice(start, start + 20)),
      });
    const rootPolicy = await f.iam.api.policies.create(f.rootCredential, {
      tenantId: f.rootTenantId,
      name: 'matrix-fleet',
      document: { version: 1, statements: statementsFor(fleetPairs) },
    });
    const rootRole = await f.iam.api.roles.create(f.rootCredential, {
      tenantId: f.rootTenantId,
      name: 'matrix-fleet',
      policyIds: [rootPolicy.id],
    });
    const rootUngranted = await rootSignIn();
    const decide = async (
      credential: Credential,
      tenantId: string,
      action: string,
      kind: ComputeResourceKind,
    ) =>
      port.authorize(credential, {
        tenantId,
        action,
        resource: { type: resourceType(kind), id: idOf(f, kind) },
      });

    // Denials first: the root member holds nothing yet, `nobody` never does.
    for (const pair of fleetPairs)
      expect(await decide(rootUngranted, f.rootTenantId, pair.action, 'fleet'), pair.action).toBe(
        false,
      );
    for (const pair of tenantPairs)
      expect(
        await decide(nobodySession, f.tenantId, pair.action, pair.kind),
        `${pair.action} ${pair.kind}`,
      ).toBe(false);

    await f.iam.api.bindings.create(f.rootCredential, {
      tenantId: f.rootTenantId,
      roleId: rootRole.id,
      subjectType: 'identity',
      subjectId: rootMember.id,
    });
    const rootGranted = await rootSignIn();
    const results: string[] = [];
    for (const pair of fleetPairs)
      if (!(await decide(rootGranted, f.rootTenantId, pair.action, 'fleet')))
        results.push(`${pair.action} fleet`);
    for (const pair of tenantPairs)
      if (!(await decide(grantedSession, f.tenantId, pair.action, pair.kind)))
        results.push(`${pair.action} ${pair.kind}`);
    expect(results, 'pairs that a matching grant did not allow').toEqual([]);

    // Grants are type-specific: an action granted on one type never allows it on a type it wasn't granted on.
    const grantedPairs = new Set(tenantPairs.map((pair) => `${pair.action} ${pair.kind}`));
    const leaks: string[] = [];
    for (const pair of tenantPairs)
      for (const kind of computeResourceKinds) {
        if (kind === 'fleet' || grantedPairs.has(`${pair.action} ${kind}`)) continue;
        const catalogType = bridge.catalog.resourceTypes[resourceType(kind)]!;
        if (!catalogType.actions?.includes(pair.action)) continue;
        if (await decide(grantedSession, f.tenantId, pair.action, kind))
          leaks.push(`${pair.action} ${kind}`);
      }
    expect(leaks).toEqual([]);
    expect(all.length).toBeGreaterThan(60);
    // Remote: at least one HTTP decision per pair and phase (denied, then granted).
    if (remote) expect(httpCalls).toBeGreaterThanOrEqual(2 * all.length);
  });

  it('the wildcard finding: compute:* validates everywhere, but decides only where the plugin is installed', async () => {
    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin({ inbox: memoryInbox() })],
      resolveResource: bridge.resolveResource(),
    });
    bridge.embedded(f.iam, { rootTenantId: f.rootTenantId });
    await loadProjection(bridge, f.tenantId);
    const bare = f.host({ resolveResource: bridge.resolveResource() });
    const wildcard = await bare.api.policies.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'compute-everything',
      document: {
        version: 1,
        statements: [{ effect: 'allow', actions: ['compute:*'], resources: ['*'] }],
      },
    });
    const member = await f.member('wild');
    const session = await f.signIn('wild');
    await f.bind(member.id, [wildcard.id]);
    for (const pair of pairs().filter((item) => item.kind !== 'fleet')) {
      const request = {
        ...session,
        tenantId: f.tenantId,
        action: pair.action,
        resource: { type: resourceType(pair.kind), id: idOf(f, pair.kind) },
      };
      expect((await f.iam.authorize(request)).allowed, pair.action).toBe(true);
      expect((await bare.authorize(request)).allowed, pair.action).toBe(false);
    }
  });
});
