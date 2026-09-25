import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDeployment,
  hostFindings,
  iamWebhookRoutes,
  installIamHandlers,
  liveGateways,
  resolveHost,
  unconfiguredIam,
  type Deployment,
} from '@better-compute/cli';
import { successorsMigration, type IamEventHandlers, type IamInboxEvent } from '@better-compute/iam';
import { pglite } from '@better-compute/postgres/pglite';

// `host.iam` (PLAN.md §12.8): the host installs compute's reactions to IAM events on the bridge. `agent`
// closes an agent's tunnels on every live gateway (the e2e is tests/e2e/access.test.ts); the others drop this
// process's IAM caches. Here: config validation, the doctor finding, which gateways are asked, and defaults.

let deployment: Deployment | undefined;
afterEach(async () => {
  await deployment?.close();
  deployment = undefined;
});

async function deploy(modules: { name: string }[] = []) {
  await deployment?.close();
  deployment = createDeployment(
    {
      database: pglite(),
      iam: unconfiguredIam(),
      secret: 'better-compute-host-iam-test-secret-0123456789',
      baseURL: 'http://127.0.0.1:3000',
      rootTenantId: 'root',
      modules: modules as never,
    },
    'test',
  );
  await deployment.compute.initialize();
  return deployment;
}

const event = (action: string, subjectId?: string, metadata: IamInboxEvent['metadata'] = {}): IamInboxEvent => ({
  eventId: `e-${action}`,
  tenantId: 'ten_a',
  sequence: 1,
  occurredAt: 0,
  action,
  ...(subjectId ? { subjectId } : {}),
  metadata,
  reactions: [],
});

describe('host.iam', () => {
  it('needs the bridge', async () => {
    const context = { compute: {} as never, options: {} as never, env: {}, cwd: '.' };
    await expect(resolveHost({ iam: {} }, context)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(resolveHost({ iam: { bridge: {} } }, context)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    const bridge = { setHandlers() {} };
    await expect(resolveHost({ iam: { bridge } }, context)).resolves.toEqual({ iam: { bridge } });
  });

  it('doctor warns when the IAM bridge is registered but its events have no reactions', async () => {
    const { compute, options } = await deploy([{ name: 'iam' }]);
    const checks = (host: object) => hostFindings(compute, options, host).map((finding) => finding.check);
    expect(checks({})).toContain('host.iam');
    expect(checks({ iam: { bridge: { setHandlers() {} } } })).not.toContain('host.iam');
    const plain = await deploy();
    expect(hostFindings(plain.compute, plain.options, {}).map((finding) => finding.check)).not.toContain(
      'host.iam',
    );
  });

  it('a deactivated role binding revokes the holder’s break-glass SSH certificates', async () => {
    const { compute } = await deploy([{ name: 'iam', migrations: [successorsMigration] } as never]);
    const sql = compute.context.sql;
    await sql.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_b', 'ten_a', 'shared', 'eu', 1)`,
    );
    await sql.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ('node_b', 'site_b', 'ten_a', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    );
    const cert = (serial: string, identityId: string, expiresIn: string) =>
      sql.query(
        `INSERT INTO ssh_certificates (serial, node_id, tenant_id, identity_id, principal, key_id, expires_at)
         VALUES ($1, 'node_b', 'ten_a', $2, 'root@node_b', $3, compute_now() + $4::interval)`,
        [serial, identityId, `key-${serial}`, expiresIn],
      );
    await cert('1', 'idn_holder', '15 minutes');
    await cert('2', 'idn_holder', '-1 minute');
    await cert('3', 'idn_other', '15 minutes');
    await cert('4', 'idn_admin', '15 minutes');
    // Issued in a child tenant through the inherited binding.
    await sql.query(
      `INSERT INTO ssh_certificates (serial, node_id, tenant_id, identity_id, principal, key_id, expires_at)
       VALUES ('5', 'node_b', 'ten_child', 'idn_holder', 'root@node_b', 'key-5', compute_now() + interval '15 minutes')`,
    );
    let installed: IamEventHandlers = {};
    const errors: unknown[] = [];
    installIamHandlers(compute, {
      bridge: { setHandlers: (handlers) => (installed = handlers) },
      onError: (error) => errors.push(error),
    });
    const tx = sql as never;
    // A revocation that does not name its holder never falls back to the administrator.
    await installed.binding!(tx, {
      ...event('binding:deactivate', 'bnd_1', { revoked: true }),
      actorId: 'idn_admin',
    });
    expect(errors).toHaveLength(1);
    // A pending activation cancelled by its requester never granted anything.
    await installed.binding!(tx, {
      ...event('binding:deactivate', 'bnd_1', { cancelled: true }),
      actorId: 'idn_holder',
    });
    // An administrator revokes the holder's activation.
    await installed.binding!(tx, {
      ...event('binding:deactivate', 'bnd_1', { identityId: 'idn_holder', revoked: true }),
      actorId: 'idn_admin',
    });
    const { rows } = await sql.query<{ serial: string; revoked: boolean }>(
      'SELECT serial, revoked_at IS NOT NULL AS revoked FROM ssh_certificates ORDER BY serial',
    );
    expect(rows).toEqual([
      { serial: '1', revoked: true },
      { serial: '2', revoked: false },
      { serial: '3', revoked: false },
      { serial: '4', revoked: false },
      { serial: '5', revoked: true },
    ]);
    // The node's spec is recomputed (its KRL) and the revocation is an event.
    const work = await sql.query<{ key: string }>(`SELECT key FROM work_queue WHERE kind = 'nodespec'`);
    expect(work.rows.map((row) => row.key)).toContain('node_b');
    const events = await sql.query<{ topic: string }>(
      `SELECT topic FROM outbox WHERE topic = 'node.ssh-cert.revoked'`,
    );
    expect(events.rows).toHaveLength(2);
  });

  it('offboarding an identity or revoking its sessions revokes its SSH certificates in every tenant', async () => {
    const { compute } = await deploy([{ name: 'iam', migrations: [successorsMigration] } as never]);
    const sql = compute.context.sql;
    await sql.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_b', 'ten_a', 'shared', 'eu', 1)`,
    );
    await sql.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ('node_b', 'site_b', 'ten_a', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    );
    const cert = (serial: string, tenantId: string, identityId: string) =>
      sql.query(
        `INSERT INTO ssh_certificates (serial, node_id, tenant_id, identity_id, principal, key_id, expires_at)
         VALUES ($1, 'node_b', $2, $3, 'root@node_b', $4, compute_now() + interval '15 minutes')`,
        [serial, tenantId, identityId, `key-${serial}`],
      );
    await cert('11', 'ten_a', 'idn_leaver');
    await cert('12', 'ten_sub', 'idn_leaver');
    await cert('13', 'ten_a', 'idn_signed_out');
    await cert('14', 'ten_a', 'idn_renamed');
    await cert('15', 'ten_a', 'idn_bystander');
    let installed: IamEventHandlers = {};
    installIamHandlers(compute, { bridge: { setHandlers: (handlers) => (installed = handlers) } });
    const tx = sql as never;
    await installed.identity!(tx, event('identity:offboard', 'idn_leaver'));
    await installed.sessions!(tx, event('identity:revoke-sessions', 'idn_signed_out'));
    // A rename keeps access; a tenant-wide sign-out names no identity.
    await installed.identity!(tx, event('iam:identities:update', 'idn_renamed'));
    await installed.sessions!(tx, event('tenant:revoke-sessions', 'ten_a'));
    const { rows } = await sql.query<{ serial: string; revoked: boolean; reason: string | null }>(
      'SELECT serial, revoked_at IS NOT NULL AS revoked, revoke_reason AS reason FROM ssh_certificates ORDER BY serial',
    );
    expect(rows).toEqual([
      { serial: '11', revoked: true, reason: 'identity:offboard' },
      // Another tenant's record says only that access was withdrawn, not why (an offboarding elsewhere).
      { serial: '12', revoked: true, reason: 'access-withdrawn' },
      { serial: '13', revoked: true, reason: 'identity:revoke-sessions' },
      { serial: '14', revoked: false, reason: null },
      { serial: '15', revoked: false, reason: null },
    ]);
    // Each revocation is an event in the certificate's own tenant.
    const events = await sql.query<{ tenant_id: string }>(
      `SELECT payload->>'tenantId' AS tenant_id FROM outbox WHERE topic = 'node.ssh-cert.revoked' ORDER BY 1`,
    );
    expect(events.rows.map((row) => row.tenant_id)).toEqual(['ten_a', 'ten_a', 'ten_sub']);
  });

  it('mirrors IAM tenant suspensions and deletions by default, down the subtree with readTenants', async () => {
    const { compute } = await deploy([{ name: 'iam', migrations: [successorsMigration] } as never]);
    const sql = compute.context.sql;
    const states = async () =>
      (
        await sql.query<{ tenant_id: string; state: string }>(
          'SELECT tenant_id, state FROM compute_tenant_states ORDER BY tenant_id',
        )
      ).rows;
    let installed: IamEventHandlers = {};
    installIamHandlers(compute, { bridge: { setHandlers: (handlers) => (installed = handlers) } });
    const tx = sql as never;
    // The handler runs in the inbox transaction and asks IAM nothing (§8.1): the tenancy reconciler re-reads.
    const reconcile = () => compute.jobs['tenancy']!.tick();
    // Without readTenants: only the deletion of the event's own tenant (never another one it names); an update
    // is not read.
    await installed.tenant!(tx, event('iam:tenants:delete', 'ten_other'));
    await installed.tenant!(tx, event('iam:tenants:delete', 'ten_a'));
    await installed.tenant!(tx, event('iam:tenants:update', 'ten_a'));
    await reconcile();
    expect(await states()).toEqual([{ tenant_id: 'ten_a', state: 'deleted' }]);
    // With it: the suspension of a parent reaches its children.
    const asked: string[] = [];
    installIamHandlers(compute, {
      bridge: { setHandlers: (handlers) => (installed = handlers) },
      readTenants: async (tenantId) => {
        asked.push(tenantId);
        return [
          { tenantId, status: 'suspended' },
          { tenantId: 'ten_child', status: 'suspended' },
        ];
      },
    });
    await installed.tenant!(tx, event('iam:tenants:update', 'ten_parent'));
    expect(asked).toEqual([]);
    await reconcile();
    expect(asked).toEqual(['ten_parent']);
    expect(await states()).toEqual([
      { tenant_id: 'ten_a', state: 'deleted' },
      { tenant_id: 'ten_child', state: 'suspended' },
      { tenant_id: 'ten_parent', state: 'suspended' },
    ]);
    const context = { compute: {} as never, options: {} as never, env: {}, cwd: '.' };
    await expect(
      resolveHost({ iam: { bridge: { setHandlers() {} }, readTenants: 'x' } }, context),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: /readTenants/ });
  });

  it('mounts the remote-IAM webhook intake into the inbox (host.iam.webhook)', async () => {
    const { compute } = await deploy();
    expect(iamWebhookRoutes(compute, { bridge: { setHandlers() {} } })).toEqual([]);
    const secret = 'whsec_remote_iam_webhook_test_0123456789';
    const [route] = iamWebhookRoutes(compute, { bridge: { setHandlers() {} }, webhook: { secret } });
    expect(route).toMatchObject({ path: '/iam/events', method: 'POST' });
    const body = JSON.stringify({
      id: 'aud_01',
      tenantId: 'ten_a',
      type: 'delegation:revoke',
      outcome: 'allow',
      timestamp: Date.now(),
      actorId: 'idn_1',
      resourceId: 'dlg_1',
    });
    const post = (signature: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return route!.handler(
        new Request('https://compute.example.com/iam/events', {
          method: 'POST',
          headers: {
            'x-better-iam-timestamp': timestamp,
            'x-better-iam-signature':
              signature || `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
          },
          body,
        }),
      );
    };
    expect((await post(`v1=${'0'.repeat(64)}`)).status).toBe(401);
    const accepted = await post('');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: 1 });
    const { rows } = await compute.context.sql.query<{ action: string }>(
      `SELECT action FROM iam_inbox WHERE event_id = 'aud_01'`,
    );
    expect(rows).toEqual([{ action: 'delegation:revoke' }]);
  });

  it('doctor warns about remote IAM without admission refresh', async () => {
    const { compute, options } = await deploy([{ name: 'iam' }]);
    const checks = (iam: object) =>
      hostFindings(compute, { ...options, iam } as never, {}).map((finding) => finding.check);
    expect(checks({})).toContain('iam.refresh');
    expect(checks({ refreshResource: async () => undefined })).not.toContain('iam.refresh');
  });

  it('asks only gateways that heartbeated recently, over the transport it can authenticate', async () => {
    const { compute } = await deploy();
    const sql = compute.context.sql;
    const add = (id: string, url: string, ageSeconds: number) =>
      sql.query(
        `INSERT INTO gateways (id, region, internal_url, software_version, max_streams, heartbeat_at)
         VALUES ($1, 'eu-1', $2, 'test', 100, compute_now() - make_interval(secs => $3))`,
        [id, url, ageSeconds],
      );
    await add('gw-live', 'http://127.0.0.1:1', 5);
    await add('gw-stale', 'http://127.0.0.1:2', 600);
    await add('gw-tls', 'https://gw-tls.internal:9443', 5);
    const h2c = liveGateways({ sql });
    expect(await h2c.list()).toHaveLength(1);
    // The same client comes back while the gateway stays listed.
    const [first] = await h2c.list();
    expect((await h2c.list())[0]).toBe(first);
    h2c.close();
    const tls = liveGateways({ sql, tls: { ca: 'x' } });
    expect(await tls.list()).toHaveLength(1);
    tls.close();
    const lenient = liveGateways({ sql, staleMs: 3_600_000 });
    expect(await lenient.list()).toHaveLength(2);
    lenient.close();
  });

  it('installs defaults that drop the caches, and keeps your own handlers', async () => {
    // The iam module's table (successors) is there wherever a bridge is: the reactions read it.
    const { compute } = await deploy([{ name: 'iam', migrations: [successorsMigration] } as never]);
    const calls: string[] = [];
    const spied = {
      dropIdentity: (id: string) => calls.push(`dropIdentity:${id}`),
      dropSession: (id: string) => calls.push(`dropSession:${id}`),
      dropDecisions: () => calls.push('dropDecisions'),
      clear: () => calls.push('clear'),
      stats: () => ({ authentications: 0, decisions: 0 }),
    };
    Object.defineProperty(compute, 'caches', { value: spied, configurable: true });
    let installed: IamEventHandlers = {};
    const budget = async () => void calls.push('budget');
    const handle = installIamHandlers(compute, {
      bridge: { setHandlers: (handlers) => (installed = handlers) },
      handlers: { budget },
    });
    const tx = compute.context.sql as never;
    await installed.identity!(tx, event('identity:offboard', 'idn_1'));
    await installed.sessions!(tx, event('auth:session:revoke', 'ses_1'));
    await installed.authz!(tx, event('iam:policies:update', 'pol_1'));
    await installed.agent!(tx, event('delegation:revoke', 'dlg_1', { agentId: 'agt_1' }));
    await installed.agent!(tx, event('agent:suspend', 'agt_2'));
    expect(installed.budget).toBe(budget);
    expect(calls).toEqual([
      'dropIdentity:idn_1',
      'clear',
      'dropDecisions',
      'dropIdentity:agt_1',
      'dropIdentity:agt_2',
    ]);
    // better-iam names the identity in every session revocation: its local streams close; updates keep them.
    const closed: [object, string][] = [];
    const registry = {
      closeWhere(filter: object, reason: string) {
        closed.push([filter, reason]);
        return 1;
      },
    };
    installIamHandlers(compute, {
      bridge: { setHandlers: (handlers) => (installed = handlers) },
      streams: [registry],
    });
    await installed.sessions!(tx, event('auth:session:revoke', 'idn_1'));
    await installed.sessions!(tx, event('auth:session:revoke-others', 'idn_2'));
    await installed.sessions!(tx, event('identity:revoke-sessions', 'idn_3'));
    await installed.sessions!(tx, event('tenant:revoke-sessions', 'ten_a'));
    await installed.identity!(tx, event('identity:offboard', 'idn_8'));
    await installed.identity!(tx, event('iam:identities:update', 'idn_7'));
    await installed.sessions!(tx, event('auth:session:revoke'));
    expect(closed).toEqual([
      [{ identityId: 'idn_1' }, 'auth:session:revoke'],
      [{ identityId: 'idn_2' }, 'auth:session:revoke-others'],
      [{ identityId: 'idn_3' }, 'identity:revoke-sessions'],
      [{ identityId: 'idn_8' }, 'identity:offboard'],
    ]);
    // Your own agent handler replaces the default one.
    const agent = async () => void calls.push('mine');
    installIamHandlers(compute, {
      bridge: { setHandlers: (handlers) => (installed = handlers) },
      handlers: { agent },
    });
    expect(installed.agent).toBe(agent);
    handle.close();
  });
});
