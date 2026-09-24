import {
  ComputeError,
  provisionFailableStates,
  provisionStateTable,
  transition,
  type Json,
  type NodeDriverBindings,
  type ProvisionFailableState,
  type ProvisionState,
  type ProvisionVerb,
  type SqlTx,
} from '@better-compute/core';
import type { HardwareProfile } from './module-types.js';

// Metal's view of a node: the `nodes` row (provision state, failed-from, maintenance, power) plus
// its `metal_nodes` row (BMC, boot, current workflow).

export interface MetalNodeRow {
  node_id: string;
  tenant_id: string;
  site_id: string;
  pool_id: string | null;
  provision_state: ProvisionState;
  failed_from: ProvisionFailableState | null;
  maintenance: boolean;
  power: 'on' | 'off' | 'unknown';
  role: string;
  node_version: number;
  bmc_driver: string;
  bmc_address: string;
  bmc_credentials: string | null;
  bmc_tls_spki_sha256: string | null;
  macs: string[];
  product_uuid: string | null;
  arch: 'x86_64' | 'arm64';
  uefi: boolean;
  hardware_profile: string | null;
  phase: string | null;
  workflow_id: string | null;
  deploy_profile_id: string | null;
  deploy_profile_version: number | null;
  release_wipe: 'none' | 'quick' | 'secure-erase' | 'crypto-erase';
  last_error: Json | null;
}

const select = `SELECT m.node_id, m.tenant_id, n.site_id, n.pool_id, n.provision_state, n.failed_from, n.maintenance,
    n.power, n.role, n.version AS node_version, m.bmc_driver, m.bmc_address, m.bmc_credentials,
    m.bmc_tls_spki_sha256, m.macs, m.product_uuid, m.arch, m.uefi, m.hardware_profile, m.phase, m.workflow_id,
    m.deploy_profile_id, m.deploy_profile_version, m.release_wipe, m.last_error
  FROM metal_nodes m JOIN nodes n ON n.id = m.node_id`;

function normalize(row: MetalNodeRow): MetalNodeRow {
  return {
    ...row,
    node_version: Number(row.node_version),
    deploy_profile_version: row.deploy_profile_version === null ? null : Number(row.deploy_profile_version),
  };
}

/** Reads (and with `lock`, locks both rows of) a metal node; `tenantId` scopes it when given. */
export async function readMetalNode(
  tx: SqlTx,
  nodeId: string,
  options: { tenantId?: string; lock?: boolean } = {},
): Promise<MetalNodeRow> {
  const { rows } = await tx.query<MetalNodeRow>(
    `${select} WHERE m.node_id = $1 AND ($2::text IS NULL OR m.tenant_id = $2)${options.lock ? ' FOR UPDATE OF m, n' : ''}`,
    [nodeId, options.tenantId ?? null],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Metal node ${nodeId} does not exist`);
  return normalize(rows[0]);
}

/**
 * Applies a provision verb (§11.1) to a locked node. A failure (`fail`, `abort`) records
 * `failed_from` and turns maintenance on; `recover` goes to the failed state's recover target and
 * clears `failed_from`. Illegal moves are `INVALID_STATE`.
 */
export async function applyProvisionVerb(
  tx: SqlTx,
  node: MetalNodeRow,
  verb: ProvisionVerb,
  options: { to?: ProvisionState; role?: string; error?: Json } = {},
): Promise<ProvisionState> {
  const to = transition(provisionStateTable, node.provision_state, verb, options.to);
  const failing = to === 'failed';
  if (failing && !(provisionFailableStates as readonly string[]).includes(node.provision_state))
    throw new ComputeError('INVALID_STATE', `A ${node.provision_state} node cannot fail`);
  const failedFrom = failing ? node.provision_state : verb === 'recover' ? null : node.failed_from;
  const updated = await tx.query(
    `UPDATE nodes SET provision_state = $2, failed_from = $3, maintenance = maintenance OR $4,
       role = COALESCE($5, role), version = version + 1
     WHERE id = $1 AND version = $6`,
    [node.node_id, to, failedFrom, failing, options.role ?? null, node.node_version],
  );
  if (updated.rowCount === 0) throw new ComputeError('CONFLICT', `Node ${node.node_id} changed concurrently`);
  await tx.query(
    `UPDATE metal_nodes SET last_error = CASE WHEN $2::jsonb IS NOT NULL THEN $2::jsonb WHEN $3 THEN NULL ELSE last_error END,
       updated_at = compute_now(), version = version + 1 WHERE node_id = $1`,
    [node.node_id, options.error === undefined ? null : JSON.stringify(options.error), verb === 'recover'],
  );
  Object.assign(node, {
    provision_state: to,
    failed_from: failedFrom as ProvisionFailableState | null,
    maintenance: node.maintenance || failing,
    node_version: node.node_version + 1,
    ...(options.role ? { role: options.role } : {}),
  });
  return to;
}

/** Records which workflow serves which provision state (or clears it). */
export async function setMetalWorkflow(tx: SqlTx, nodeId: string, phase: string | null, workflowId: string | null): Promise<void> {
  await tx.query(
    'UPDATE metal_nodes SET phase = $2, workflow_id = $3, updated_at = compute_now(), version = version + 1 WHERE node_id = $1',
    [nodeId, phase, workflowId],
  );
}

/**
 * The driver bindings of a node (§5.4): the pool's hardware profile (`policy.hardwareProfile`,
 * looked up in `hardwareProfiles`), overridden per concern by the node's own bindings. The BMC
 * binds `power`, `management` and `virtual-media` unless the profile says otherwise.
 */
export function resolveDriverBindings(
  hardwareProfiles: Readonly<Record<string, HardwareProfile>>,
  profileName: string | undefined,
  bmc: { driver: string; address: string; credentials?: string },
  overrides: NodeDriverBindings = {},
): NodeDriverBindings {
  const profile = profileName ? hardwareProfiles[profileName] : undefined;
  if (profileName && !profile) throw new ComputeError('INVALID_INPUT', `Unknown hardware profile ${profileName}`);
  const bmcBinding = {
    driver: bmc.driver,
    config: { address: bmc.address, ...(bmc.credentials ? { credentials: bmc.credentials } : {}) },
  };
  return {
    power: bmcBinding,
    management: bmcBinding,
    'virtual-media': bmcBinding,
    ...(profile?.drivers ?? {}),
    ...overrides,
  };
}
