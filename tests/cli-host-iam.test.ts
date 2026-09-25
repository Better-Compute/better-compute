import { afterEach, describe, expect, it } from 'vitest';
import {
  createDeployment,
  hostFindings,
  installIamHandlers,
  liveGateways,
  resolveHost,
  unconfiguredIam,
  type Deployment,
} from '@better-compute/cli';
import type { IamEventHandlers, IamInboxEvent } from '@better-compute/iam';
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
    const { compute } = await deploy();
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
    // Local streams close by exact session or identity only; revoke-others and updates are left to re-checks.
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
    await installed.sessions!(tx, event('auth:session:revoke', 'ses_9'));
    await installed.sessions!(tx, event('auth:session:revoke-others', 'ses_keep'));
    await installed.sessions!(tx, event('identity:revoke-sessions', 'idn_9'));
    await installed.identity!(tx, event('identity:offboard', 'idn_8'));
    await installed.identity!(tx, event('iam:identities:update', 'idn_7'));
    await installed.sessions!(tx, event('auth:session:revoke'));
    expect(closed).toEqual([
      [{ sessionId: 'ses_9' }, 'auth:session:revoke'],
      [{ identityId: 'idn_9' }, 'identity:revoke-sessions'],
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
