import type { KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock, type EventPublisher, type SqlExecutor } from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createCsr,
  createNodeCa,
  createSecretRequest,
  generateP256KeyPair,
  localSealedSecretStore,
  nodeSpiffeId,
  openSecretResponse,
  sealedSecretsMigration,
  spkiSha256,
} from '@better-compute/pki';
import { agentFrame, gatewayFixture } from './support/gateway.js';
import { createSecretBroker } from '@better-compute/server';

// The v0.2 secret broker (PLAN.md §6 "Secrets", §13): signed by the node's current key, bound to
// its current work, one-time, short-lived, audited without the value.

const now = Date.UTC(2026, 8, 24, 12);
const clock = manualClock(now);
const TENANT = 'org_acme';
let db: SqlExecutor;
let store: ReturnType<typeof localSealedSecretStore>;
const published: { type: string; tenantId: string; data: Record<string, unknown> }[] = [];
const events: EventPublisher = {
  publish: async (_tx, event) => {
    published.push(event as never);
  },
} as EventPublisher;
let seq = 0;

beforeAll(async () => {
  db = pglite();
  await db.migrate([sealedSecretsMigration]);
  await useSimClock(db, now);
  store = localSealedSecretStore({ sql: db, keys: 'x'.repeat(32) });
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_s', $1, 'shared', 'eu', 1)`,
    [TENANT],
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_s', $1, 'site_s', 'metal-dedicated', 'exclusive', 'bcd', '{}', 1)`,
    [TENANT],
  );
});
afterAll(async () => {
  await db.close();
});

/** A node with a current certificate (and its key). */
async function node(options: { role?: string; trust?: string } = {}) {
  const id = `node_01k5w0000000000000000${(seq++).toString().padStart(5, '0')}`;
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_s', NULL, $2, 'site', 'adopted', false, false, 'connected', $3, 0, 0, 1, 1, 0, 1)`,
    [id, TENANT, options.trust ?? 'platform'],
  );
  const key = generateP256KeyPair().privateKey;
  const serial = await certify(id, key, options.role ?? 'site');
  return { id, key, serial };
}

async function certify(nodeId: string, key: KeyObject, role = 'site', identityGen = 1) {
  const ca = createNodeCa({ clock: manualClock(now - 3_600_000) });
  const issued = await ca.sign(createCsr(key), {
    usage: 'client',
    role: role as 'node',
    ttlSeconds: 86_400,
    uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_s', nodeId })],
  });
  await db.query(
    `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      issued.serial,
      nodeId,
      role,
      identityGen,
      spkiSha256(key),
      issued.certificate,
      new Date(issued.notBefore),
      new Date(issued.notAfter),
    ],
  );
  return issued.serial;
}

/** A command of workflow step `wf:<wf>:<step>` for `nodeId` whose payload carries `text`. */
async function command(nodeId: string, key: string, text: string, state = 'pending') {
  const id = `cmd_${(seq++).toString().padStart(26, '0')}`;
  await db.query(
    `INSERT INTO commands (id, node_id, seq, kind, body, state, not_before, not_after, retry_safe,
       self_terminating, attested, idempotency_key)
     VALUES ($1, $2, $3, 'bmc.operation', $4, $5, compute_now(), compute_now() + interval '1 hour',
       false, false, false, $6)`,
    [
      id,
      nodeId,
      seq,
      new TextEncoder().encode(`\x0a\x10payload{"credentialsRef":"${text}"}`),
      state,
      // A per-command `:<key>` suffix keeps (node, idempotency_key) unique, as step keys do.
      `${key}:k${seq}`,
    ],
  );
}

function broker(extra: Partial<Parameters<typeof createSecretBroker>[0]> = {}) {
  return createSecretBroker({
    database: db,
    clock,
    events,
    stores: [store],
    rootTenantId: 'org_root',
    ...extra,
  });
}

function ask(
  n: { key: KeyObject },
  ref: string,
  fields: { workflowId?: string; stepId?: string; allocationId?: string } = {
    workflowId: 'wf_1',
    stepId: 'bmc',
  },
) {
  return createSecretRequest({ nodeKey: n.key, ref, ...fields });
}

describe('secret broker through a real gateway session', () => {
  it('relays only ciphertext: the bound node opens the value, a relay by another session gets nothing', async () => {
    const f = await gatewayFixture();
    try {
      await f.db.migrate([sealedSecretsMigration]);
      const vault = localSealedSecretStore({ sql: f.db, keys: 'y'.repeat(32) });
      f.services.services.secret = createSecretBroker({
        database: f.db,
        clock: f.clock,
        events: { publish: async () => {} } as unknown as EventPublisher,
        stores: [vault],
      }).secret;
      const agent = await f.addNode();
      const key = generateP256KeyPair().privateKey;
      const ca = createNodeCa({ clock: manualClock(f.clock.now() - 60_000) });
      const issued = await ca.sign(createCsr(key), {
        usage: 'client',
        role: 'site',
        ttlSeconds: 86_400,
        uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_s', nodeId: agent })],
      });
      await f.db.query(
        `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
         VALUES ($1, $2, 'site', 1, $3, $4, $5, $6)`,
        [
          issued.serial,
          agent,
          spkiSha256(key),
          issued.certificate,
          new Date(issued.notBefore),
          new Date(issued.notAfter),
        ],
      );
      const ref = await vault.put(TENANT, 'ipmi-admin-pw');
      await f.db.query(
        `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating,
           attested, idempotency_key)
         VALUES ('cmd_bmc', $1, 1, 'bmc.operation', $2, 'pending', compute_now() + interval '1 hour', false, false,
           false, 'wf:wf_9:power')`,
        [agent, new TextEncoder().encode(`{"credentialsRef":"${ref}"}`)],
      );
      const { request, ephemeralKey } = createSecretRequest({
        nodeKey: key,
        ref,
        workflowId: 'wf_9',
        stepId: 'power',
      });

      const { stream, handle } = await f.connect(agent);
      await handle.receive(agentFrame({ case: 'secretRequest', value: request }));
      await expect.poll(() => stream.of('secret').length).toBe(1);
      const answer = stream.of('secret')[0]!;
      expect(answer.jwe).not.toContain('ipmi-admin-pw');
      expect(
        openSecretResponse(answer, ephemeralKey, {
          ref,
          requestId: request.requestId,
          now: f.clock.now(),
        }),
      ).toBe('ipmi-admin-pw');

      // The same signed request replayed through another node's session.
      const other = await f.addNode();
      const relay = await f.connect(other);
      await relay.handle.receive(agentFrame({ case: 'secretRequest', value: request }));
      await expect.poll(() => relay.stream.of('secret').length).toBe(1);
      expect(relay.stream.of('secret')[0]).toMatchObject({ error: 'access-denied', jwe: '' });
    } finally {
      await f.close();
    }
  });
});

describe('secret broker', () => {
  it('releases a value bound to the node’s live step, once, sealed to its one-time key, audited without it', async () => {
    const agent = await node();
    const ref = await store.put(TENANT, 'hunter2-bmc-password');
    await command(agent.id, 'wf:wf_1:bmc#1', ref);
    const b = broker();
    const { request, ephemeralKey } = ask(agent, ref);
    const response = await b.secret(request, { peerNodeId: agent.id, gatewayId: 'gw_1' });
    expect(response.error).toBe('');
    expect(
      openSecretResponse(response, ephemeralKey, { ref, requestId: request.requestId, now }),
    ).toBe('hunter2-bmc-password');
    // Five minutes later the agent itself refuses the JWE.
    expect(() =>
      openSecretResponse(response, ephemeralKey, {
        ref,
        requestId: request.requestId,
        now: now + 301_000,
      }),
    ).toThrow(/expired/);

    const audit = await db.query<{
      tenant_id: string;
      resource_id: string;
      details: Record<string, unknown>;
    }>(`SELECT tenant_id, resource_id, details FROM audit_events WHERE action = 'secret.released'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      tenant_id: TENANT,
      resource_id: ref,
      details: {
        nodeId: agent.id,
        requestId: request.requestId,
        workflowId: 'wf_1',
        stepId: 'bmc',
        gatewayId: 'gw_1',
      },
    });
    expect(JSON.stringify(audit.rows)).not.toContain('hunter2');

    // A relayed copy of the same request.
    const replay = await b.secret(request, { peerNodeId: agent.id });
    expect(replay.error).toBe('access-denied');
    expect(JSON.stringify(published)).not.toContain('hunter2');
  });

  it('refuses anything not bound to that node’s live work', async () => {
    const agent = await node();
    const other = await node();
    const ref = await store.put(TENANT, 'secret-a');
    const b = broker();
    const outcome = async (
      setup: () => Promise<void>,
      fields?: { workflowId?: string; stepId?: string; allocationId?: string },
      peer = agent.id,
    ) => {
      await setup();
      const { request } = ask(agent, ref, fields);
      return (await b.secret(request, { peerNodeId: peer })).error;
    };
    expect(await outcome(async () => {})).toBe('not-bound'); // no command at all
    expect(await outcome(() => command(agent.id, 'wf:wf_1:bmc', ref, 'succeeded'))).toBe(
      'not-bound',
    );
    expect(await outcome(() => command(other.id, 'wf:wf_1:bmc', ref))).toBe('not-bound');
    expect(await outcome(() => command(agent.id, 'wf:wf_1:bmc', 'secret://org_acme/other'))).toBe(
      'not-bound',
    );
    expect(await outcome(() => command(agent.id, 'wf:wf_1:bmcx', ref))).toBe('not-bound'); // prefix trap
    expect(await outcome(async () => {}, { workflowId: 'wf_2', stepId: 'bmc' })).toBe('not-bound');
    // Signed by agent, relayed as if from another node's session.
    await command(agent.id, 'wf:wf_1:bmc', ref);
    expect(await outcome(async () => {}, undefined, other.id)).toBe('access-denied');
    expect(await outcome(async () => {}, undefined, '')).toBe('access-denied');
    // And now the bound one goes through.
    expect(await outcome(async () => {})).toBe('');
  });

  it('only answers the node’s current, unrevoked key; never a node-tenant certificate', async () => {
    const b = broker();
    const ref = await store.put(TENANT, 'secret-b');
    const try_ = async (n: { id: string; key: KeyObject }) => {
      await command(n.id, 'wf:wf_1:bmc', ref);
      return (await b.secret(ask(n, ref).request, { peerNodeId: n.id })).error;
    };
    const revoked = await node();
    await db.query('UPDATE node_certs SET revoked_at = compute_now() WHERE serial = $1', [
      revoked.serial,
    ]);
    expect(await try_(revoked)).toBe('access-denied');

    const superseded = await node();
    await db.query('UPDATE nodes SET identity_gen = 2 WHERE id = $1', [superseded.id]);
    expect(await try_(superseded)).toBe('access-denied');

    const expired = await node();
    await db.query(
      `UPDATE node_certs SET not_after = compute_now() - interval '1 minute' WHERE serial = $1`,
      [expired.serial],
    );
    expect(await try_(expired)).toBe('access-denied'); // no offline grace for secrets

    const lessee = await node({ role: 'node-tenant', trust: 'tenant-controlled' });
    expect(await try_(lessee)).toBe('access-denied');

    const stranger = { id: (await node()).id, key: generateP256KeyPair().privateKey }; // not its key
    expect(await try_(stranger)).toBe('access-denied');
  });

  it('releases allocation-bound refs for live allocations on the node only', async () => {
    const host = await node();
    const ref = await store.put(TENANT, 'user-data');
    const allocation = async (id: string, released = false) =>
      db.query(
        `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, released_at, version)
         VALUES ($1, $2, 'pool_s', $3, 'instance', 'inst_1', tstzrange(compute_now(), NULL), $4, 1)`,
        [id, TENANT, host.id, released ? new Date(now) : null],
      );
    await allocation('alloc_live');
    await allocation('alloc_gone', true);
    const seen: unknown[] = [];
    const b = broker({
      allocationRefs: async (_tx, input) => {
        seen.push(input);
        return input.ownerId === 'inst_1' && input.ref === ref;
      },
    });
    const get = async (allocationId: string) =>
      (await b.secret(ask(host, ref, { allocationId }).request, { peerNodeId: host.id })).error;
    expect(await get('alloc_live')).toBe('');
    expect(await get('alloc_gone')).toBe('not-bound');
    expect(await get('alloc_nope')).toBe('not-bound');
    expect(seen).toEqual([
      { allocationId: 'alloc_live', ownerKind: 'instance', ownerId: 'inst_1', ref },
    ]);
  });

  it('releases an instance’s user data only when the secret is the instance’s own tenant’s', async () => {
    const host = await node();
    // vps's table, reduced to what the broker reads (this suite does not register vps()).
    await db.query(
      'CREATE TABLE IF NOT EXISTS instances (id text PRIMARY KEY, tenant_id text NOT NULL, user_data text)',
    );
    const own = await store.put(TENANT, 'cloud-config of acme');
    const foreign = await store.put('org_other', 'cloud-config of other');
    let allocations = 0;
    const instance = async (userData: string) => {
      const id = `inst_${++allocations}`;
      await db.query('INSERT INTO instances (id, tenant_id, user_data) VALUES ($1, $2, $3)', [
        id,
        TENANT,
        userData,
      ]);
      await db.query(
        `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
         VALUES ($1, $2, 'pool_s', $3, 'instance', $4, tstzrange(compute_now(), NULL), 1)`,
        [`alloc_i${allocations}`, TENANT, host.id, id],
      );
      return `alloc_i${allocations}`;
    };
    const b = broker();
    const get = async (ref: string, allocationId: string) =>
      (await b.secret(ask(host, ref, { allocationId }).request, { peerNodeId: host.id })).error;
    expect(await get(own, await instance(own))).toBe('');
    // An acme instance naming another tenant's secret as its user data gets nothing.
    expect(await get(foreign, await instance(foreign))).toBe('not-bound');

    // A suspended or deleted tenant's secrets stay sealed, before teardown reaches its instances.
    await db.query(
      `CREATE TABLE IF NOT EXISTS compute_tenant_states (tenant_id text PRIMARY KEY, state text NOT NULL)`,
    );
    const bound = await instance(own);
    try {
      for (const state of ['suspended', 'deleted']) {
        await db.query(
          `INSERT INTO compute_tenant_states (tenant_id, state) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET state = EXCLUDED.state`,
          [TENANT, state],
        );
        expect(await get(own, bound), state).toBe('access-denied');
      }
    } finally {
      await db.query('DELETE FROM compute_tenant_states WHERE tenant_id = $1', [TENANT]);
    }
    expect(await get(own, bound)).toBe('');
  });

  it('releases a host unit’s credential (k8s-join.tokenRef) named by the node’s current spec only', async () => {
    const agent = await node();
    const token = await store.put(TENANT, 'abcdef.0123456789abcdef');
    const foreign = await store.put('org_other', 'abcdef.foreign-token-xx');
    const setSpec = (units: { unit: string; configJson: string }[] | null) =>
      db.query('UPDATE nodes SET spec = $2::jsonb WHERE id = $1', [
        agent.id,
        units === null ? null : JSON.stringify({ host: { units } }),
      ]);
    const join = (ref: string) => ({
      unit: 'k8s-join',
      configJson: JSON.stringify({ server: 'https://k8s.example:6443', caCertSha256: 'a'.repeat(64), tokenRef: ref }),
    });
    const b = broker();
    // The daemon names the unit and field it fetches for: workflow host:<unit>, step <field>.
    const hostUnit = { workflowId: 'host:k8s-join', stepId: 'tokenRef' };
    const get = async (ref: string, fields: Parameters<typeof ask>[2] = hostUnit) =>
      (await b.secret(ask(agent, ref, fields).request, { peerNodeId: agent.id })).error;

    expect(await get(token)).toBe('not-bound'); // no spec
    await setSpec([join(token)]);
    const { request, ephemeralKey } = ask(agent, token, hostUnit);
    const response = await b.secret(request, { peerNodeId: agent.id });
    expect(response.error).toBe('');
    expect(openSecretResponse(response, ephemeralKey, { ref: token, requestId: request.requestId, now })).toBe(
      'abcdef.0123456789abcdef',
    );
    const audit = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_events WHERE action = 'secret.released' AND resource_id = $1`,
      [token],
    );
    expect(audit.rows[0]?.details).toMatchObject({ nodeId: agent.id, hostUnit: 'k8s-join' });

    // Only the allowed (unit, field) pair, named as such.
    expect(await get(token, { workflowId: 'wf_1', stepId: 'bmc' })).toBe('not-bound');
    expect(await get(token, { workflowId: 'host:k8s-join', stepId: 'server' })).toBe('not-bound');
    await setSpec([{ unit: 'sysctl', configJson: JSON.stringify({ tokenRef: token }) }]);
    expect(await get(token)).toBe('not-bound');
    expect(await get(token, { workflowId: 'host:sysctl', stepId: 'tokenRef' })).toBe('not-bound');
    // Another tenant's secret named in the spec stays sealed.
    await setSpec([join(foreign)]);
    expect(await get(foreign)).toBe('not-bound');
    // The spec moved on (a policy edit): the old ref is no longer released.
    const next = await store.put(TENANT, 'abcdef.next-token-xxxxxx');
    await setSpec([join(next)]);
    expect(await get(token)).toBe('not-bound');
    expect(await get(next)).toBe('');
    // A revoked key reads nothing, and the rule can be turned off.
    expect(
      (await broker({ hostUnitRefs: [] }).secret(ask(agent, next, hostUnit).request, { peerNodeId: agent.id })).error,
    ).toBe('not-bound');
    await db.query('UPDATE node_certs SET revoked_at = compute_now() WHERE serial = $1', [agent.serial]);
    expect(await get(next)).toBe('access-denied');
  });

  it('answers not-found / unavailable without detail, and bounds refusal events', async () => {
    const agent = await node();
    const missing = 'secret://org_acme/nope';
    await command(agent.id, 'wf:wf_1:bmc', missing);
    const vault = 'vault://kv/bmc';
    await command(agent.id, 'wf:wf_1:bmc', vault);
    published.length = 0;
    const b = broker({ refusalEventsPerMinute: 5 });
    expect((await b.secret(ask(agent, missing).request, { peerNodeId: agent.id })).error).toBe(
      'not-found',
    );
    expect((await b.secret(ask(agent, vault).request, { peerNodeId: agent.id })).error).toBe(
      'unavailable',
    );
    for (let i = 0; i < 20; i++)
      await b.secret(ask(agent, 'secret://org_acme/x').request, { peerNodeId: 'node_bogus' });
    const refused = published.filter((event) => event.type === 'security.secret.refused');
    // not-found + unavailable + 5 of the 20 'unknown-node' refusals.
    expect(refused).toHaveLength(7);
    expect(refused.slice(0, 2).map((event) => event.tenantId)).toEqual([TENANT, TENANT]);
    expect(refused.slice(2).every((event) => event.tenantId === 'org_root')).toBe(true);
  });
});
