import type { SqlTx } from '@better-compute/core';

// One valid input per §9.2 method, for tests/generated/authz-matrix.test.ts. scripts/authz-matrix.mjs
// reads the keys of `authzSamples` from this file and reports registered v0.1 methods without one,
// so add a sample with every new method. Inputs name ids from `MatrixIds`, which
// tests/support/authz-matrix.ts seeds (visible to `tenant` through the projection).

export interface MatrixIds {
  /** The organization the samples act in (acme). */
  tenant: string;
  root: string;
  siteId: string;
  poolId: string;
  nodeId: string;
  projectId: string;
  /** An active reservation of `tenant` in `poolId` (owned by the matrix user). */
  reservationId: string;
}

export interface AuthzSample {
  /** A valid input; the envelope must decide on the row's action and resource with it. */
  input(ids: MatrixIds): Record<string, unknown>;
  /** Who makes the declared call: acme's user (default), or the root admin for fleet-wide rows. */
  as?: 'user' | 'root';
  /** More rows the method needs before its decision (the shared ones are always there). */
  seed?(sql: SqlTx, ids: MatrixIds): Promise<void>;
}

const zeros = '0'.repeat(26);
const node = (ids: MatrixIds) => ({ tenantId: ids.tenant, nodeId: ids.nodeId });
const pool = (ids: MatrixIds) => ({ tenantId: ids.tenant, poolId: ids.poolId });
const reservation = (ids: MatrixIds) => ({
  tenantId: ids.tenant,
  reservationId: ids.reservationId,
});
/** Puts the seeded reservation back to active for the next item method (release ends it). */
const activeReservation = async (sql: SqlTx, ids: MatrixIds) => {
  await sql.query(
    `UPDATE reservations SET state = 'active', lease_expires_at = NULL,
       during = tstzrange(compute_now(), compute_now() + interval '1 hour') WHERE id = $1`,
    [ids.reservationId],
  );
  await sql.query(
    "UPDATE authz_projection SET pending = NULL WHERE type = 'reservation' AND id = $1",
    [ids.reservationId],
  );
};

export const authzSamples: Record<string, AuthzSample> = {
  'system.whoami': { input: () => ({}) },
  'system.version': { input: () => ({}) },
  'system.selfCheck': { input: () => ({}), as: 'root' },

  'projects.create': {
    input: (ids) => ({ tenantId: ids.tenant, name: 'matrix', idempotencyKey: 'matrix-project' }),
  },
  'projects.get': { input: (ids) => ({ tenantId: ids.tenant, projectId: ids.projectId }) },
  'projects.list': { input: (ids) => ({ tenantId: ids.tenant }) },

  'sites.list': { input: (ids) => ({ tenantId: ids.tenant }) },
  'sites.get': { input: (ids) => ({ tenantId: ids.tenant, siteId: ids.siteId }) },
  'sites.create': {
    input: (ids) => ({
      tenantId: ids.root,
      kind: 'shared',
      region: 'eu-west-1',
      idempotencyKey: 'matrix-site',
    }),
    as: 'root',
  },

  'joinTokens.create': {
    input: (ids) => ({
      tenantId: ids.tenant,
      poolId: ids.poolId,
      ttlSeconds: 600,
      idempotencyKey: 'matrix-token',
    }),
  },
  'joinTokens.list': { input: (ids) => ({ tenantId: ids.tenant, poolId: ids.poolId }) },
  'joinTokens.revoke': {
    input: (ids) => ({ tenantId: ids.tenant, poolId: ids.poolId, tokenId: `jt_${zeros}` }),
  },

  'nodes.list': { input: (ids) => ({ tenantId: ids.tenant }) },
  'nodes.get': { input: node },
  'nodes.events': { input: node },
  'nodes.cordon': { input: node },
  'nodes.uncordon': { input: node },
  'nodes.drain': { input: node },
  'nodes.label': { input: (ids) => ({ ...node(ids), set: { rack: 'r1' } }) },
  'nodes.taint': { input: (ids) => ({ ...node(ids), add: ['matrix'] }) },
  'nodes.adopt': { input: node },
  'nodes.revokeIdentity': { input: node },

  'inventory.get': { input: node },

  'commands.run': {
    input: (ids) => ({ ...node(ids), kind: 'diag.nvml', idempotencyKey: 'matrix-command' }),
  },
  'commands.get': { input: (ids) => ({ ...node(ids), commandId: `cmd_${zeros}` }) },
  'commands.list': { input: node },

  'usage.list': { input: (ids) => ({ tenantId: ids.tenant }) },
  'events.list': { input: (ids) => ({ tenantId: ids.tenant }) },

  // The built-in capacity module's groups.
  'pools.list': { input: (ids) => ({ tenantId: ids.tenant }) },
  'pools.get': { input: pool },
  'pools.create': {
    input: (ids) => ({
      tenantId: ids.tenant,
      siteId: ids.siteId,
      class: 'metal-host',
      gpuModel: 'H100',
      idempotencyKey: 'matrix-pool',
    }),
  },
  'pools.capacity': { input: pool },
  'pools.offer': {
    input: (ids) => ({ ...pool(ids), toTenantId: 'tenant-matrix-partner', quota: { gpu: 1 } }),
  },
  'pools.unoffer': { input: (ids) => ({ ...pool(ids), toTenantId: 'tenant-matrix-partner' }) },
  'capacity.summary': { input: (ids) => ({ tenantId: ids.tenant }) },
  'reservations.create': {
    input: (ids) => ({
      ...pool(ids),
      devices: [{ class: 'gpu', count: 1 }],
      duration: '1h',
      idempotencyKey: 'matrix-reservation',
    }),
  },
  'reservations.get': { input: reservation, seed: activeReservation },
  // `scope: 'all'` takes the per-item path of the list recipe (`mine` is the owner filter alone).
  'reservations.list': {
    input: (ids) => ({ tenantId: ids.tenant, scope: 'all' }),
    seed: activeReservation,
  },
  'reservations.release': { input: reservation, seed: activeReservation },
  'reservations.extend': {
    input: (ids) => ({ ...reservation(ids), by: '1h', idempotencyKey: 'matrix-extend' }),
    seed: activeReservation,
  },
  'reservations.renew': { input: reservation, seed: activeReservation },
  'quotas.get': { input: (ids) => ({ tenantId: ids.tenant }) },
};
