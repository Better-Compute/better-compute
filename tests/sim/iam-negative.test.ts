import { afterEach, describe, expect, it } from 'vitest';
import { spyIamPort, type IamSpy } from '@better-compute/iam';
import { createControlPlaneSim, type ControlPlaneSim } from '@better-compute/testing';

// The §16 v0.1 security negative (P7): "an IamPort spy records zero IAM calls on heartbeat, inventory and command
// paths over a 10-minute simulated run". The real control plane (sim clock, its IamPort wrapped in `spyIamPort`)
// and the real gateway (manual jobs) serve FakeDaemons under the deterministic fleet simulator. Nodes join through
// JoinService, pass acceptance and get adopted; for ten simulated minutes they heartbeat, report inventory and run
// the operator's commands, and a tenant's reservation binds on one of them. Every IAM call must come from an API
// admission: the fleet (frames in and out, gateway jobs, reconcilers, joins) makes none.

const MIN = 60_000;
const NODES = 4;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('the v0.1 IAM negative', () => {
  it('records zero IAM calls on fleet paths over a 10-minute simulated run', async () => {
    let spy: IamSpy | undefined;
    rig = await createControlPlaneSim({
      seed: 'iam-negative',
      nodes: NODES,
      iam: (fake) => (spy = spyIamPort(fake)),
      trace: (path, fn) => spy!.path(path, fn),
    });
    const { compute, tenants, database, api } = rig;
    const root = { token: tenants.root.token };
    const acme = { token: tenants.acme.token };
    const start = rig.sim.scheduler.now();

    // Ten simulated minutes: heartbeats, inventory, acceptance, adoption; the operator runs a command on every
    // adopted node each minute, and a tenant reserves a node's GPUs at minute three.
    let reservationId: string | undefined;
    const commandIds: string[] = [];
    for (let minute = 1; minute <= 10; minute++) {
      await rig.run(MIN);
      const { rows } = await database.query<{ id: string }>(
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
            poolId: rig!.poolId,
            devices: [{ class: 'gpu', count: 8 }],
            duration: '1h',
            idempotencyKey: 'neg-reservation',
          } as never),
        );
        reservationId = reservation.id;
      }
    }

    // The fleet did its work: every node adopted and heard from, the commands ran, the reservation is active.
    const adopted = await database.query<{ id: string; last_seen: Date | string | null }>(
      `SELECT n.id, s.last_seen FROM nodes n JOIN node_sessions s ON s.node_id = n.id
        WHERE n.provision_state = 'adopted'`,
    );
    expect(adopted.rows).toHaveLength(NODES);
    for (const row of adopted.rows)
      expect(new Date(row.last_seen!).getTime()).toBeGreaterThan(start + 8 * MIN);
    const settled = await database.query<{ state: string; count: number }>(
      `SELECT state, count(*)::int AS count FROM commands WHERE id = ANY($1::text[]) GROUP BY state`,
      [commandIds],
    );
    expect(commandIds.length).toBeGreaterThan(NODES * 5);
    expect(settled.rows.find((row) => row.state === 'succeeded')?.count).toBeGreaterThanOrEqual(
      commandIds.length - NODES,
    );
    const reservation = await database.query<{ state: string }>(
      'SELECT state FROM reservations WHERE id = $1',
      [reservationId],
    );
    expect(reservation.rows[0]?.state).toBe('active');
    const inventory = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM devices',
    );
    expect(inventory.rows[0]!.count).toBeGreaterThanOrEqual(NODES * 8);

    // The negative: IAM saw the operator's and the tenant's admissions, and nothing else. An IAM call from a
    // handler that lost its async context would be untagged, and fails here as well.
    expect(spy!.summary().api).toBeGreaterThan(0);
    const offPath = spy!.calls.filter((call) => call.path !== 'api');
    expect(
      offPath.map(
        (call) => `${call.paths.join('>') || '(none)'}: ${call.method} ${call.action ?? ''}`,
      ),
    ).toEqual([]);
    for (const path of ['fleet', 'gateway', 'reconcilers', 'join'])
      expect(spy!.callsOn(path, { nested: true }).filter((call) => call.path !== 'api')).toEqual(
        [],
      );
    expect(await rig.invariants()).toEqual([]);
  }, 600_000);
});
