import { create } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { attachFrameConn, createGateway, type Gateway } from '@better-compute/gateway';
import { spyIamPort } from '@better-compute/iam';
import {
  createCsr,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  sealJoinToken,
  verifyJoinResponse,
} from '@better-compute/pki';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { AgentRole, HardwareClaimsSchema, JoinRequestSchema } from '@better-compute/protocol';
import { betterCompute, gatewayReportHandlers, pkiJoinCrypto } from '@better-compute/server';
import { createFleetSim, fakeHardware, fakeIam, type FleetSim } from '@better-compute/testing';

// The §16 v0.1 security negative (P7): "an IamPort spy records zero IAM calls on heartbeat, inventory and command
// paths over a 10-minute simulated run". The real control plane (sim clock, its IamPort wrapped in `spyIamPort`)
// and the real gateway (manual jobs) serve FakeDaemons under the deterministic fleet simulator. Nodes join through
// JoinService, pass acceptance and get adopted; for ten simulated minutes they heartbeat, report inventory and run
// the operator's commands, and a tenant's reservation binds on one of them. Every IAM call must come from an API
// admission: the fleet (frames in and out, gateway jobs, reconcilers, joins) makes none.

const MIN = 60_000;
const START = Date.UTC(2026, 0, 1);
const TRUST_DOMAIN = 'compute.iam-negative.test';
const NODES = 4;
const tenants = {
  root: { id: 'tenant-root', token: 'biam_ses_neg_root' },
  acme: { id: 'tenant-acme', token: 'biam_ses_neg_acme' },
};

/** Every statement first moves compute_now() to the simulated time (never backwards). */
function pinned(db: SqlExecutor, now: () => number): SqlExecutor {
  let last = -1;
  const sync = async () => {
    const time = now();
    if (time > last) {
      last = time;
      await setSimClock(db, time);
    }
  };
  return {
    dialect: db.dialect,
    kind: db.kind,
    async query(text, params) {
      await sync();
      return db.query(text, params);
    },
    async transaction(fn, options) {
      await sync();
      return db.transaction(fn, options);
    },
    migrate: (extra) => db.migrate(extra),
    close: () => db.close(),
  } as SqlExecutor;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

describe('the v0.1 IAM negative', () => {
  it('records zero IAM calls on fleet paths over a 10-minute simulated run', async () => {
    let sim: FleetSim | undefined;
    const now = () => sim?.scheduler.now() ?? START;
    const clock = { now };
    const raw = pglite();
    const database = pinned(raw, now);

    const iam = fakeIam({
      callers: Object.fromEntries(
        Object.entries(tenants).map(([name, tenant]) => [
          tenant.token,
          {
            identityId: `identity-${name}`,
            identityKind: 'user' as const,
            tenantId: tenant.id,
            sessionId: `session-${name}`,
            sessionKind: 'user' as const,
            mfa: name === 'root',
          },
        ]),
      ),
    });
    iam.allow({ token: tenants.root.token });
    for (const action of [
      'compute:pools:read',
      'compute:reservations:create',
      'compute:reservations:read',
    ])
      iam.allow({ token: tenants.acme.token, action });
    const spy = spyIamPort(iam, { clock });

    const nodeCa = createNodeCa({ clock, trustDomain: TRUST_DOMAIN });
    const signingKey = createSigningKey({ clock });
    const encryption = generateP256KeyPair();
    const compute = betterCompute({
      database,
      iam: spy,
      secret: 'better-compute-iam-negative-secret-0123456789',
      baseURL: 'https://compute.iam-negative.test',
      rootTenantId: tenants.root.id,
      clock,
      pki: {
        join: pkiJoinCrypto({
          trustDomain: TRUST_DOMAIN,
          nodeCa,
          signingKey,
          encryptionKey: encryption.privateKey,
        }),
      },
    });
    await compute.initialize();
    await useSimClock(raw, START);
    cleanups.push(() => raw.close());
    cleanups.push(() => compute.stop());

    // The operator's setup: API admissions, which do call IAM.
    const api = <T>(fn: () => Promise<T>) => spy.path('api', fn);
    const root = { token: tenants.root.token };
    const acme = { token: tenants.acme.token };
    const site = await api(() =>
      compute.api.sites.create(root, {
        tenantId: tenants.root.id,
        kind: 'shared',
        region: 'sim',
        idempotencyKey: 'neg-site',
      }),
    );
    const pool = await api(() =>
      compute.api.pools.create(root, {
        tenantId: tenants.root.id,
        siteId: site.id,
        class: 'metal-host',
        gpuModel: 'H100',
        policy: { acceptance: [{ kind: 'diag.nvml' }] },
        idempotencyKey: 'neg-pool',
      } as never),
    );
    await api(() =>
      compute.api.pools.offer(root, {
        tenantId: tenants.root.id,
        poolId: pool.id,
        toTenantId: tenants.acme.id,
        quota: { gpu: 64 },
      } as never),
    );
    const minted = await api(() =>
      compute.api.joinTokens.create(root, {
        tenantId: tenants.root.id,
        poolId: pool.id,
        maxUses: NODES,
        ttlSeconds: 3600,
        idempotencyKey: 'neg-token',
      }),
    );

    // Joins: JoinService through GatewayServices, a fleet path (P7: no IAM).
    const nodes: { nodeId: string; hardware: ReturnType<typeof fakeHardware> }[] = [];
    await spy.path('join', async () => {
      for (let index = 0; index < NODES; index++) {
        const hardware = fakeHardware({ seed: `neg-${index}` });
        const csr = createCsr(generateP256KeyPair().privateKey);
        const sealed = sealJoinToken(minted.token!, encryption.publicKey, { csr, issuedAt: now() });
        const response = await compute.gatewayServices.join(
          create(JoinRequestSchema, {
            sealedToken: new TextEncoder().encode(sealed),
            csr,
            claims: create(HardwareClaimsSchema, hardware.claims),
            daemonVersion: '0.1.0',
            role: AgentRole.NODE,
          }),
        );
        const { nodeId } = verifyJoinResponse(response, {
          signer: { publicKey: signingKey.publicKey },
          csr,
          nodeCaRoots: [nodeCa.certificate],
          now: now(),
        });
        nodes.push({ nodeId, hardware });
      }
    });

    // The real gateway, stepped by the simulator; the control plane's reconcilers run on the same ticks.
    let gateway: Gateway | undefined;
    sim = createFleetSim({
      seed: 'iam-negative',
      start: START,
      nodes: nodes.map(({ nodeId, hardware }) => ({ nodeId, hardware })),
      logFrames: false,
      gateway: () => ({
        async accept(conn, peer) {
          gateway ??= await (async () => {
            const created = createGateway({
              id: 'gw_neg_1',
              region: 'sim',
              database,
              clock,
              manual: true,
              services: compute.gatewayServices,
              work: compute.context.work,
              events: compute.context.events,
              reports: gatewayReportHandlers,
            });
            await created.start();
            return created;
          })();
          attachFrameConn(gateway, { nodeId: peer.nodeId, role: 'node' }, conn as never);
        },
        async tick() {
          if (gateway)
            await spy.path('gateway', async () => {
              for (const job of ['lease', 'dispatch', 'status', 'liveness', 'specs'] as const)
                await gateway!.jobs[job].tick();
            });
          await spy.path('reconcilers', async () => {
            for (const job of Object.values(compute.jobs)) await job.tick();
          });
        },
      }),
    });
    cleanups.push(async () => {
      await gateway?.stop();
    });
    const fleet = (ms: number) => spy.path('fleet', () => sim!.run(ms));
    await spy.path('fleet', () => sim!.start());

    // Ten simulated minutes: heartbeats, inventory, acceptance, adoption; the operator runs a command on every
    // node each minute, and a tenant reserves a node's GPUs at minute three.
    let reservationId: string | undefined;
    const commandIds: string[] = [];
    for (let minute = 1; minute <= 10; minute++) {
      await fleet(MIN);
      const { rows } = await raw.query<{ id: string }>(
        `SELECT id FROM nodes WHERE provision_state = 'adopted' AND observed_generation >= 1 ORDER BY id`,
      );
      for (const { id } of rows) {
        const command = await api(() =>
          compute.api.commands.run(root, {
            tenantId: tenants.root.id,
            nodeId: id,
            kind: 'inventory.refresh',
            payload: { sections: ['gpus'] },
            idempotencyKey: `neg-refresh-${minute}-${id}`,
          }),
        );
        commandIds.push(command.id);
      }
      if (minute === 3) {
        const reservation = await api(() =>
          compute.api.reservations.create(acme, {
            tenantId: tenants.acme.id,
            poolId: pool.id,
            devices: [{ class: 'gpu', count: 8 }],
            duration: '1h',
            idempotencyKey: 'neg-reservation',
          } as never),
        );
        reservationId = reservation.id;
      }
    }

    // The fleet did its work: every node adopted and heard from, the commands ran, the reservation is active.
    const adopted = await raw.query<{ id: string; last_seen: Date | string | null }>(
      `SELECT n.id, s.last_seen FROM nodes n JOIN node_sessions s ON s.node_id = n.id
        WHERE n.provision_state = 'adopted'`,
    );
    expect(adopted.rows).toHaveLength(NODES);
    for (const row of adopted.rows)
      expect(new Date(row.last_seen!).getTime()).toBeGreaterThan(START + 8 * MIN);
    const settled = await raw.query<{ state: string; count: number }>(
      `SELECT state, count(*)::int AS count FROM commands WHERE id = ANY($1::text[]) GROUP BY state`,
      [commandIds],
    );
    expect(commandIds.length).toBeGreaterThan(NODES * 5);
    expect(settled.rows.find((row) => row.state === 'succeeded')?.count).toBeGreaterThanOrEqual(
      commandIds.length - NODES,
    );
    const reservation = await raw.query<{ state: string }>(
      'SELECT state FROM reservations WHERE id = $1',
      [reservationId],
    );
    expect(reservation.rows[0]?.state).toBe('active');
    const inventory = await raw.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM devices',
    );
    expect(inventory.rows[0]!.count).toBeGreaterThanOrEqual(NODES * 8);

    // The negative: IAM saw the operator's and the tenant's admissions, and nothing else.
    const summary = spy.summary();
    expect(summary.api).toBeGreaterThan(0);
    const offPath = spy.calls.filter((call) => call.path !== 'api');
    expect(
      offPath.map(
        (call) => `${call.paths.join('>') || '(none)'}: ${call.method} ${call.action ?? ''}`,
      ),
    ).toEqual([]);
    for (const path of ['fleet', 'gateway', 'reconcilers', 'join'])
      expect(spy.callsOn(path, { nested: true }).filter((call) => call.path !== 'api')).toEqual([]);
  }, 600_000);
});
