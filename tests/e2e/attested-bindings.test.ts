import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { generateP256KeyPair, signAttestedReport } from '@better-compute/pki';
import {
  AttestedReportBodySchema,
  type AllocationBound,
  type AttestedReport,
} from '@better-compute/protocol';
import { gatewayReportHandlers, pkiAllocationBindingCheck } from '@better-compute/server';
import { createDevStack, type DevStack } from '@better-compute/testing';

// PLAN.md §16 v0.2 exit: "a gateway-forged AllocationBound is rejected" (P14, §13). A binding counts
// only when the node itself signed it: the gateway stores the attested report as received, and the
// worker verifies it against the node's certificates before the reservation turns active. Here the
// dev stack's FakeDaemons sign their reports with their node keys; a compromised gateway (it has the
// database) runs the same report handler with forged evidence: unsigned, signed by a key that is not
// the node's, and the node's genuine signature over another allocation. None of them ever makes a
// reservation active, each is published as reservation.binding-rejected, and a forged re-report of an
// active binding marks it lost instead of replacing it.

let dev: DevStack;
let api: any;
let poolId: string;
let nodeId: string;
let keys = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const reserve = (gpus: number) =>
  api.reservations.create(dev.root, {
    tenantId: dev.rootTenantId,
    poolId,
    devices: [{ class: 'gpu', count: gpus }],
    duration: '1h',
    idempotencyKey: `attested-${++keys}`,
  });
const get = (reservationId: string) => api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId });

/** The live allocation of a reservation, once placed. */
const allocationOf = (reservationId: string) =>
  until(`an allocation for ${reservationId}`, async () => {
    const { rows } = await dev.database.query<{ id: string; node_id: string }>(
      `SELECT id, node_id FROM allocations WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL`,
      [reservationId],
    );
    return rows[0];
  });

const rejections = async (allocationId: string) =>
  (
    await dev.database.query<{ data: { reason: string } }>(
      `SELECT payload->'data' AS data FROM outbox
        WHERE topic = 'reservation.binding-rejected' AND payload->'data'->>'allocationId' = $1 ORDER BY seq`,
      [allocationId],
    )
  ).rows.map((row) => row.data.reason);

const boundReport = (allocationId: string, overrides: Partial<AllocationBound> = {}) =>
  create(AttestedReportBodySchema, {
    nodeId,
    bootId: 'boot-forged',
    report: {
      case: 'allocationBound',
      value: {
        allocationId,
        generation: 1n,
        deviceIds: ['GPU-forged'],
        cdiDevices: ['bcd.dev/gpu=GPU-forged'],
        cdiSpecPath: `/etc/cdi/bcd-${allocationId}.json`,
        envFile: '/run/bcd/forged.env',
        ...overrides,
      },
    },
  });

/**
 * What a compromised gateway can do: run the report handler in its own ingest transaction with any
 * evidence it likes, for a report it parsed (or made up).
 */
async function forge(allocationId: string, envelope: Pick<AttestedReport, 'body' | 'nodeSig'>) {
  const report = boundReport(allocationId).report.value as AllocationBound;
  await dev.database.transaction((tx) =>
    gatewayReportHandlers.allocationBound(
      tx,
      {
        nodeId,
        work: dev.compute.context.work,
        attested: {
          body: envelope.body,
          kid: envelope.nodeSig?.kid ?? '',
          sig: envelope.nodeSig?.sig ?? new Uint8Array(0),
        },
      },
      report,
    ),
  );
}

beforeAll(async () => {
  dev = await createDevStack({ capacity: { attestedBindings: pkiAllocationBindingCheck() } });
  api = dev.compute.api;
  ({ poolId } = await dev.createPool({ key: 'attested' }));
  [nodeId] = (await dev.join({ poolId, count: 1, seed: 'attested' })) as [string];
  await dev.waitFor([nodeId], { timeoutMs: 60_000 });
  await api.pools.offer(dev.root, { tenantId: dev.rootTenantId, poolId, toTenantId: dev.rootTenantId, quota: { gpu: 16 } });
}, 120_000);

afterAll(async () => {
  await dev?.close();
});

describe('attested bindings end to end (v0.2 exit)', () => {
  it("activates a reservation on the node's own signed AllocationBound, with the signed binding", async () => {
    const created = await reserve(2);
    const active = await until('the reservation to bind', async () => {
      const current = await get(created.id);
      return current.state === 'active' ? current : undefined;
    });
    const allocation = await allocationOf(created.id);
    const { rows } = await dev.database.query<{ binding: Record<string, unknown>; signed: boolean }>(
      'SELECT binding, bound_sig IS NOT NULL AS signed FROM allocations WHERE id = $1',
      [allocation.id],
    );
    expect(rows[0]).toMatchObject({ signed: true, binding: { attested: true } });
    expect(active.binding.cdiDevices).toEqual((rows[0]!.binding as { cdiDevices: string[] }).cdiDevices);
    expect(await rejections(allocation.id)).toEqual([]);

    // A forged re-report of that binding never replaces it: the binding is marked lost instead.
    await forge(allocation.id, { body: toBinary(AttestedReportBodySchema, boundReport(allocation.id)) });
    await until('the forged re-report to be rejected', async () => (await rejections(allocation.id)).length === 1);
    await until('the reservation to show the lost binding', async () => {
      const current = await get(created.id);
      return (current.conditions ?? []).some((c: { reason?: string }) => c.reason === 'BindingLost') ? current : undefined;
    });
    const { rows: after } = await dev.database.query<{ binding: Record<string, unknown> }>(
      'SELECT binding FROM allocations WHERE id = $1',
      [allocation.id],
    );
    // What the gateway wrote is marked lost and rejected, never taken as the attested binding.
    expect(after[0]!.binding).toMatchObject({ lost: true, rejected: 'unsigned report' });
    expect(after[0]!.binding).not.toHaveProperty('attested');
    await api.reservations.release(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
  }, 90_000);

  it('never activates on a gateway-forged AllocationBound: unsigned, foreign key, or the node signing another allocation', async () => {
    const daemon = dev.daemons.get(nodeId)!;
    // The node cannot write its CDI spec for now, so it reports nothing: only forgeries arrive.
    daemon.knobs.cdiWriteFailures = 1_000_000;
    const created = await reserve(1);
    const allocation = await allocationOf(created.id);

    // The node was told (its NodeSpec carries the assignment): now a report is expected.
    await until('the reservation to wait for its binding', async () => (await get(created.id)).state === 'binding');

    // 1. Unsigned (a v0.1-style report the gateway could make up).
    await forge(allocation.id, { body: toBinary(AttestedReportBodySchema, boundReport(allocation.id)) });
    await until('the unsigned report to be rejected', async () => (await rejections(allocation.id)).length >= 1);

    // 2. Signed, but by a key that is not one of the node's certificates.
    const attacker = generateP256KeyPair();
    await forge(allocation.id, signAttestedReport(attacker.privateKey, boundReport(allocation.id)));
    await until('the foreign signature to be rejected', async () => (await rejections(allocation.id)).length >= 2);

    // 3. The node's genuine signature, over another allocation (replayed or swapped by the gateway).
    const nodeKey = daemon.nodeKey!;
    expect(nodeKey).toBeDefined();
    await forge(allocation.id, signAttestedReport(nodeKey, boundReport('alloc_somewhere_else')));
    await until('the swapped report to be rejected', async () => (await rejections(allocation.id)).length >= 3);

    const reasons = await rejections(allocation.id);
    expect(reasons[0]).toBe('unsigned report');
    expect(reasons.slice(1).every((reason) => reason.length > 0)).toBe(true);
    // Nothing counted: the reservation is not active, nothing is bound (and so nothing is billed).
    expect((await get(created.id)).state).not.toBe('active');
    const { rows } = await dev.database.query<{ bound_at: Date | null }>('SELECT bound_at FROM allocations WHERE id = $1', [
      allocation.id,
    ]);
    expect(rows[0]!.bound_at).toBeNull();

    daemon.knobs.cdiWriteFailures = 0;
    await api.reservations.release(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
  }, 90_000);
});
