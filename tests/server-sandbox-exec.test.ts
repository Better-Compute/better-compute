import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiMethod,
  manualClock,
  type Caller,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createExecTicketIssuer,
  createReplayCache,
  createSshCertificateAuthority,
  formatSshPublicKey,
  parseSshCertificate,
  verifyExecTicket,
} from '@better-compute/pki';
import { tunnelsModule, type SandboxExec } from '../packages/server/src/tunnels/index.js';

// sandboxes.exec (PLAN.md §3.7): tunnels contributes it to vps's sandboxes group. One decision
// returns an ssh exec ticket for the sandbox's instance (stamped with act and sbx for gateway
// re-authorization) and a short certificate from the sandbox CA for `<account>@<instanceId>`.

// The SSH CA bounds lifetimes on its own clock: the test runs at the real time.
const T0 = Math.floor(Date.now() / 1000) * 1000;
const NODE = 'node_01jz00000000000000000000na';
const INSTANCE = 'inst_01jz00000000000000000000ia';
const SANDBOX = 'sbx_01jz00000000000000000000sa';
let db: SqlExecutor;
let events: { type: string; subject: string; data: Record<string, unknown> }[] = [];
const issuer = createExecTicketIssuer({ issuer: 'https://compute.test' });
const ca = createSshCertificateAuthority();
const module = tunnelsModule({ issuer, sandboxSsh: ca, limits: { tunnelsPerMinute: 1000 } });

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 'ses_1',
  sessionKind: 'user',
  mfa: false,
  sessionExpiresAt: T0 + 5 * 60_000,
};
const publicKey = formatSshPublicKey(generateKeyPairSync('ed25519').publicKey);

function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn) => fn(tx),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  } as SqlExecutor;
}

type Definition = {
  validate(raw: unknown): unknown;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
};
const execOf = (m: ReturnType<typeof tunnelsModule>) =>
  (m.api!({} as ModuleContext) as unknown as { sandboxes: { exec: Definition } }).sandboxes.exec;
const exec = async (raw: unknown, who: Caller = alice, m = module) => {
  const definition = execOf(m);
  const input = definition.validate(raw);
  return db.transaction(
    async (tx) =>
      (await definition.handler(
        {
          sql: within(tx),
          clock: manualClock(T0),
          caller: who,
          requestId: 'r',
          events: {
            async publish(
              _tx: SqlTx,
              event: { type: string; subject: string; data: Record<string, unknown> },
            ) {
              events.push(event);
            },
          },
        } as unknown as MethodContext,
        input,
      )) as SandboxExec,
  );
};

beforeAll(async () => {
  db = pglite();
  await db.migrate([]);
  // The vps tables, reduced to what sandboxes.exec reads.
  await db.query(`CREATE TABLE instances (id text PRIMARY KEY, tenant_id text NOT NULL, node_id text,
                    state text NOT NULL, draft bool NOT NULL DEFAULT false, restore_from jsonb,
                    host_certified bool NOT NULL DEFAULT false, host_cert_valid_before timestamptz)`);
  await db.query(`CREATE TABLE sandboxes (id text PRIMARY KEY, tenant_id text NOT NULL, instance_id text NOT NULL,
                    draft bool NOT NULL DEFAULT false, deleting_at timestamptz, expires_at timestamptz)`);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                        trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_01jz00000000000000000000aa', 'root', 'host', 'adopted', false, false, 'connected', 'platform',
             1, 1, 1, 1, 0, 1)`,
    [NODE],
  );
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  events = [];
  for (const table of ['sandboxes', 'instances', 'node_sessions'])
    await db.query(`DELETE FROM ${table}`);
  await db.query(
    `INSERT INTO node_sessions (node_id, session_epoch, gateway_id, capabilities)
     VALUES ($1, 1, 'gw-a', ARRAY['tunnel.instance-dial'])`,
    [NODE],
  );
  await db.query(
    `INSERT INTO instances (id, tenant_id, node_id, state) VALUES ($1, 'acme', $2, 'running')`,
    [INSTANCE, NODE],
  );
  await db.query(`INSERT INTO sandboxes (id, tenant_id, instance_id) VALUES ($1, 'acme', $2)`, [
    SANDBOX,
    INSTANCE,
  ]);
});

describe('sandboxes.exec', () => {
  it('is the §9.2 row, contributed by tunnels', () => {
    expect(apiMethod('sandboxes', 'exec')).toMatchObject({
      module: 'tunnels',
      action: 'compute:sandboxes:exec',
      resource: 'sandbox',
    });
    expect(execOf(module)).toMatchObject({ action: 'compute:sandboxes:exec', kind: 'mutation' });
  });

  it("issues an ssh ticket for the sandbox's instance and a certificate only that instance accepts", async () => {
    const issued = await exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey });
    expect(issued).toMatchObject({
      sandboxId: SANDBOX,
      instanceId: INSTANCE,
      nodeId: NODE,
      principal: `sandbox@${INSTANCE}`,
      account: 'sandbox',
      // The default 10 minutes, cut to the caller's session.
      validBefore: T0 + 5 * 60_000,
    });
    expect(issued.path).toBe(`tunnels/${issued.ticket}`);
    const claims = verifyExecTicket(issued.ticket, {
      jwks: issuer.jwksJson(),
      nodeId: NODE,
      now: Date.now(),
      jtiCache: createReplayCache(),
    });
    expect(claims).toMatchObject({
      op: 'ssh',
      sub: 'usr_alice',
      ses: 'ses_1',
      tnt: 'acme',
      inst: INSTANCE,
      sbx: SANDBOX,
      act: 'compute:sandboxes:exec',
      sid: issued.tunnelId,
    });
    const certificate = parseSshCertificate(issued.certificate);
    expect(certificate.principals).toEqual([`sandbox@${INSTANCE}`]);
    expect(certificate.keyId).toBe(issued.keyId);
    expect(events.map((event) => event.type)).toEqual(['tunnel.issued', 'sandbox.exec.issued']);
    expect(events[1]).toMatchObject({
      subject: `sandbox/${SANDBOX}`,
      data: { instanceId: INSTANCE, serial: issued.serial, identityId: 'usr_alice' },
    });
  });

  it('refuses without a CA, without a session, for bad keys, and for sandboxes not ready', async () => {
    const plain = tunnelsModule({ issuer });
    await expect(
      exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey }, alice, plain),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const { sessionId: _session, ...apiKey } = alice;
    await expect(
      exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey }, apiKey as Caller),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'session-required' } });
    await expect(
      exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey: 'ssh-rsa AAAA nope' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(exec({ tenantId: 'globex', sandboxId: SANDBOX, publicKey })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await db.query(`UPDATE instances SET state = 'paused'`);
    await expect(exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await db.query(`UPDATE instances SET state = 'running'`);
    await db.query(`UPDATE sandboxes SET deleting_at = now()`);
    await expect(exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await db.query(`UPDATE sandboxes SET deleting_at = NULL`);
    // Only a daemon that dials the instance's own address, never host loopback.
    await db.query(`UPDATE node_sessions SET capabilities = '{}'`);
    await expect(exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      details: { capability: 'tunnel.instance-dial' },
    });
    expect(events).toEqual([]);
  });

  it('tells the client which host name to pin, and whether the guest can be pinned', async () => {
    expect(await exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey })).toMatchObject({
      hostPrincipal: INSTANCE,
      hostCertified: false,
      hostCertificate: 'none',
    });
    await db.query(`UPDATE instances SET host_certified = true, host_cert_valid_before = $1`, [
      new Date(T0 + 3_600_000).toISOString(),
    ]);
    expect(await exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey })).toMatchObject({
      hostPrincipal: INSTANCE,
      hostCertified: true,
      hostCertificate: 'valid',
    });
    // An expired host certificate cannot be pinned: say so rather than fail the client's check.
    await db.query(`UPDATE instances SET host_cert_valid_before = $1`, [
      new Date(T0 - 1_000).toISOString(),
    ]);
    expect(await exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey })).toMatchObject({
      hostCertified: false,
      hostCertificate: 'expired',
    });
  });

  it('never outlives the sandbox, and refuses one about to expire', async () => {
    await db.query(`UPDATE sandboxes SET expires_at = $1::timestamptz`, [
      new Date(T0 + 3 * 60_000).toISOString(),
    ]);
    const issued = await exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey });
    expect(issued.validBefore).toBe(T0 + 3 * 60_000);
    await db.query(`UPDATE sandboxes SET expires_at = $1::timestamptz`, [
      new Date(T0 + 30_000).toISOString(),
    ]);
    await expect(exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'sandbox-expiring' },
    });
  });

  it('signs for the principal a memory-restored guest still accepts', async () => {
    const ORIGINAL = 'inst_01jz00000000000000000000ib';
    await db.query(`UPDATE instances SET restore_from = $1::jsonb`, [
      JSON.stringify({ snapshotId: 'snap_x', principalInstanceId: ORIGINAL }),
    ]);
    const issued = await exec({ tenantId: 'acme', sandboxId: SANDBOX, publicKey });
    expect(issued.principal).toBe(`sandbox@${ORIGINAL}`);
    // The resumed guest also keeps the original's host certificate.
    expect(issued).toMatchObject({ hostPrincipal: ORIGINAL, hostCertified: false });
    expect(parseSshCertificate(issued.certificate).principals).toEqual([`sandbox@${ORIGINAL}`]);
    // The ticket still names the instance it dials.
    expect(issued.instanceId).toBe(INSTANCE);
  });

  it('validates its configuration and input', () => {
    expect(() =>
      tunnelsModule({
        issuer,
        sandboxSsh: { ...ca, publicKey: `${ca.publicKey}\nssh-ed25519 AAAA x` },
      }),
    ).toThrow(/single printable line/);
    expect(() => tunnelsModule({ issuer, sandboxSsh: ca, sandboxAccount: 'Root!' })).toThrow(
      /sandboxAccount/,
    );
    const definition = execOf(module);
    expect(() =>
      definition.validate({ tenantId: 'acme', sandboxId: SANDBOX, publicKey, ttlSeconds: 3600 }),
    ).toThrow();
    expect(() =>
      definition.validate({ tenantId: 'acme', sandboxId: INSTANCE, publicKey }),
    ).toThrow();
  });
});
