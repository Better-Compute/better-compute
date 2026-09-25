import { fromBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { nodeSpecColumn } from '@better-compute/gateway';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createCommandSigningAuthority,
  desiredStateFromStored,
  verifyDesiredState,
} from '@better-compute/pki';
import { DesiredStateBodySchema } from '@better-compute/protocol';
import { betterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { options } from './support/server.js';

// Signed NodeSpecs (PLAN.md §7.7, §13; v0.4 "signing of all commands and specs"): with `pki.commandSigning`,
// the NodeSpec controller signs each new generation's DesiredStateBody under the worker key and stores the
// exact bytes (nodes.spec_body, nodes.spec_signature) for the gateway to relay; the gateway itself holds no key.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function server(pki: Record<string, unknown> | undefined) {
  db = pglite();
  const compute = betterCompute({
    ...options(db, fakeIam()),
    clock: manualClock(T0),
    ...(pki ? { pki } : {}),
  } as never) as any;
  await compute.initialize();
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_s', 'org_root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
       trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ('node_s', 'site_s', 'org_root', 'unassigned', 'adopted', false, false, 'connected', 'platform',
       0, 0, 1, 1, 0, 1)`,
  );
  /** One NodeSpec pass, as the `nodespec` reconciler runs it. */
  const reconcile = async () => {
    await db!.transaction((tx) => compute.context.work.enqueue(tx, 'nodespec', 'node_s'));
    for (let pass = 0; pass < 3; pass++)
      for (const job of Object.values(compute.jobs) as { tick(): Promise<unknown> }[])
        await job.tick().catch(() => undefined);
  };
  const stored = async () =>
    (
      await db!.query<{ generation: number; spec_body: Uint8Array | null; spec_signature: Uint8Array | null }>(
        'SELECT generation, spec_body, spec_signature FROM nodes WHERE id = $1',
        ['node_s'],
      )
    ).rows[0]!;
  return { compute, reconcile, stored };
}

describe('signed NodeSpecs', () => {
  it('signs every new generation, byte-identical to what the gateway renders', async () => {
    const authority = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) });
    const s = await server({ commandSigning: authority });
    await s.reconcile();
    const row = await s.stored();
    expect(row.generation).toBeGreaterThanOrEqual(1);
    expect(row.spec_body).not.toBeNull();
    expect(row.spec_signature).not.toBeNull();
    const state = desiredStateFromStored(new Uint8Array(row.spec_body!), new Uint8Array(row.spec_signature!));
    // What a daemon runs: the chain to the command-signing root, the EKU, ES256 over the body.
    const body = verifyDesiredState(state, {
      roots: [authority.certificate],
      now: T0,
      nodeId: 'node_s',
      required: true,
    });
    // The signed generation is the row's generation, from the same UPDATE.
    expect(Number(body.generation)).toBe(Number(row.generation));
    expect(() =>
      verifyDesiredState(state, {
        roots: [createCommandSigningAuthority().certificate],
        now: T0,
        nodeId: 'node_s',
        required: true,
      }),
    ).toThrow(/rejected/);
    // The gateway's unsigned rendering of nodes.spec is the same body, so the signature covers it.
    const rendered = await db!.transaction((tx) => nodeSpecColumn.load(tx, 'node_s'));
    expect(Buffer.from(rendered!.body).equals(Buffer.from(row.spec_body!))).toBe(true);
    expect(fromBinary(DesiredStateBodySchema, rendered!.body).nodeId).toBe('node_s');
  });

  it('writes no signature without pki.commandSigning', async () => {
    const s = await server(undefined);
    await s.reconcile();
    const row = await s.stored();
    expect(row.generation).toBeGreaterThanOrEqual(1);
    expect(row.spec_body).toBeNull();
    expect(row.spec_signature).toBeNull();
  });
});
