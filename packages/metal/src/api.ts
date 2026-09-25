import {
  ComputeError,
  defineMethod,
  describedBy,
  isId,
  isSecretRef,
  newId,
  provisionStateTable,
  recoverTarget,
  shardOf,
  type Json,
  type MethodContext,
  type MethodDefinition,
  type PowerAction,
  type ProfileDocument,
  type ProvisionState,
  type ProvisionVerb,
  type SecretRef,
  type SqlTx,
  type WipeMode,
} from '@better-compute/core';
import { builtinSteps, siteAgentFor, stepRegistry, type StepRegistry } from '@better-compute/provision';
import { encodeMessageJson } from '@better-compute/protocol';
import { batchSubject, stateChain, verbBatchScope } from './batch.js';
import {
  assertBmcNeeds,
  assertPxeMacsKnowable,
  bmcDriverUnsupported,
  servesBmcOperation,
  siteDriverKinds,
  type BmcDriverCapabilities,
} from './capabilities.js';
import { metalPayloads } from './commands.js';
import type { HardwareProfile } from './module-types.js';
import { stateProfile, unrescueProfile } from './profiles.js';
import { metalWorkKind, unrescuePhase } from './reconcile.js';
import { schemas } from './schemas.js';
import { bmcOperationJson, metalSteps } from './steps.js';
import { applyProvisionVerb, readMetalNode, resolveDriverBindings, setMetalWorkflow, type MetalNodeRow } from './store.js';

// The `metal` group of PLAN.md §9.2 (v0.2 rows). Every verb checks the move against core's
// provision state table, records it, and leaves the workflow to the metal reconciler, which the
// verb queues in the same transaction.

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const macPattern = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

function fail(message: string): never {
  throw new ComputeError('INVALID_INPUT', message);
}
function object(raw: unknown, allowed: readonly string[], name = 'The request'): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`Unknown field ${JSON.stringify(key)}`);
  return raw as Record<string, unknown>;
}
const tenant = (value: unknown) => (typeof value === 'string' && tenantPattern.test(value) ? value : fail('tenantId is invalid'));
const nodeId = (value: unknown) => (isId(value, 'node') ? value : fail('nodeId must be a node_ id'));
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`${name} must be a string of at most ${max} characters`);
  return value;
}

/** What the metal group returns: never credentials, only whether they are set. */
export interface MetalNodeView {
  nodeId: string;
  tenantId: string;
  siteId: string;
  poolId?: string;
  provisionState: ProvisionState;
  failedFrom?: string;
  maintenance: boolean;
  power: 'on' | 'off' | 'unknown';
  bmc: { driver: string; address: string; credentialsSet: boolean };
  macs: string[];
  workflowId?: string;
  lastError?: Json;
}

export function metalNodeView(row: MetalNodeRow): MetalNodeView {
  const view: MetalNodeView = {
    nodeId: row.node_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    provisionState: row.provision_state,
    maintenance: row.maintenance,
    power: row.power,
    bmc: { driver: row.bmc_driver, address: row.bmc_address, credentialsSet: row.bmc_credentials !== null },
    macs: row.macs,
  };
  if (row.pool_id) view.poolId = row.pool_id;
  if (row.failed_from) view.failedFrom = row.failed_from;
  if (row.workflow_id) view.workflowId = row.workflow_id;
  if (row.last_error !== null) view.lastError = row.last_error;
  return view;
}

export interface EnrollInput {
  tenantId: string;
  siteId: string;
  poolId: string;
  bmc: {
    address: string;
    driver: string;
    /** A secret reference, or inline credentials stored at once and never echoed. */
    credentials: SecretRef | { username: string; password: string };
    tlsSpkiSha256?: string;
  };
  macs?: string[];
  productUuid?: string;
  arch?: 'x86_64' | 'arm64';
  uefi?: boolean;
  /** Overrides the pool's `policy.hardwareProfile`. */
  hardwareProfile?: string;
}
export interface MetalNodeInput {
  tenantId: string;
  nodeId: string;
}
export interface DeployInput extends MetalNodeInput {
  profileId: string;
  profileVersion: number;
}
export interface UndeployInput extends MetalNodeInput {
  wipe?: WipeMode;
}
export interface AbortInput extends MetalNodeInput {
  reason?: string;
}
export interface PowerInput extends MetalNodeInput {
  action: PowerAction;
}

export type MetalApi = {
  metal: {
    enroll: MethodDefinition<EnrollInput, MetalNodeView>;
    manage: MethodDefinition<MetalNodeInput, MetalNodeView>;
    inspect: MethodDefinition<MetalNodeInput, MetalNodeView>;
    provide: MethodDefinition<MetalNodeInput, MetalNodeView>;
    deploy: MethodDefinition<DeployInput, MetalNodeView>;
    undeploy: MethodDefinition<UndeployInput, MetalNodeView>;
    rescue: MethodDefinition<MetalNodeInput, MetalNodeView>;
    /** Boots a rescued node back into its OS; it stays `rescue` until that worked, then `deployed`. */
    unrescue: MethodDefinition<MetalNodeInput, MetalNodeView>;
    abort: MethodDefinition<AbortInput, MetalNodeView>;
    recover: MethodDefinition<MetalNodeInput, MetalNodeView>;
    retire: MethodDefinition<MetalNodeInput, MetalNodeView>;
    /** With a quorum, the command waits for its one-leaf batch (`batchId`) to be approved (§13). */
    power: MethodDefinition<PowerInput, PowerOutput>;
    /**
     * (v1.0 §13) One verb on many nodes as one destructive-command batch: every node is decided as its
     * own call (`compute:nodes:provision` on it), then the batch is created over the destructive
     * (subject, kind) set the verb's workflows can send and every node gets the verb in one
     * transaction. With the deployment's quorum on, those commands wait for the batch's approvals.
     */
    bulk: MethodDefinition<BulkInput, BulkOutput>;
  };
};

export interface PowerOutput {
  commandId: string;
  /** The batch the power action runs under, when the deployment keeps batches; `held` until approved. */
  batchId?: string;
  held?: boolean;
}

export type BulkVerb = 'manage' | 'inspect' | 'provide' | 'undeploy' | 'rescue' | 'retire';
const bulkVerbs: Readonly<Record<BulkVerb, ProvisionVerb>> = {
  manage: 'manage',
  inspect: 'inspect',
  provide: 'provide',
  undeploy: 'release',
  rescue: 'rescue',
  retire: 'retire',
};

export interface BulkInput {
  tenantId: string;
  /** The pool every node is in; the call is decided on it, and each node on its own as well. */
  poolId: string;
  verb: BulkVerb;
  nodeIds: string[];
  wipe?: WipeMode;
  reason: string;
}

export interface BulkOutput {
  /** The batch, when the verb sends destructive commands (and the deployment keeps batches). */
  batch?: { batchId: string; held: boolean; required: number; size: number };
  nodes: MetalNodeView[];
}

const powerActions: readonly PowerAction[] = ['on', 'off', 'graceful-off', 'reset', 'graceful-restart', 'cycle', 'nmi'];
const wipeModes: readonly WipeMode[] = ['none', 'quick', 'secure-erase', 'crypto-erase'];

function nodeInput(raw: unknown, extra: readonly string[] = []): MetalNodeInput & Record<string, unknown> {
  const input = object(raw, ['tenantId', 'nodeId', ...extra]);
  return { ...input, tenantId: tenant(input.tenantId), nodeId: nodeId(input.nodeId) };
}

function validateEnroll(raw: unknown): EnrollInput {
  const input = object(raw, ['tenantId', 'siteId', 'poolId', 'bmc', 'macs', 'productUuid', 'arch', 'uefi', 'hardwareProfile']);
  const bmc = object(input.bmc, ['address', 'driver', 'credentials', 'tlsSpkiSha256'], 'bmc');
  let credentials: EnrollInput['bmc']['credentials'];
  if (typeof bmc.credentials === 'string') {
    if (!isSecretRef(bmc.credentials)) fail('bmc.credentials must be a secret:// reference or { username, password }');
    credentials = bmc.credentials;
  } else {
    const inline = object(bmc.credentials, ['username', 'password'], 'bmc.credentials');
    credentials = { username: text(inline.username, 'bmc.credentials.username', 128), password: text(inline.password, 'bmc.credentials.password', 1024) };
  }
  const out: EnrollInput = {
    tenantId: tenant(input.tenantId),
    siteId: text(input.siteId, 'siteId', 128),
    poolId: isId(input.poolId, 'pool') || typeof input.poolId === 'string' ? text(input.poolId, 'poolId', 128) : fail('poolId is required'),
    bmc: {
      address: text(bmc.address, 'bmc.address', 512),
      // A string only: String(undefined) would pass the pattern as "undefined".
      driver:
        typeof bmc.driver === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(bmc.driver)
          ? bmc.driver
          : fail('bmc.driver must be a driver id such as redfish'),
      credentials,
    },
  };
  if (bmc.tlsSpkiSha256 !== undefined) {
    if (typeof bmc.tlsSpkiSha256 !== 'string') fail('bmc.tlsSpkiSha256 must be 64 hex digits');
    const pin = bmc.tlsSpkiSha256.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pin)) fail('bmc.tlsSpkiSha256 must be 64 hex digits');
    out.bmc.tlsSpkiSha256 = pin;
  }
  if (input.macs !== undefined) {
    if (!Array.isArray(input.macs) || input.macs.length > 16) fail('macs must be a list of at most 16 MACs');
    out.macs = input.macs.map((mac) => {
      if (typeof mac !== 'string') fail(`${JSON.stringify(mac)} is not a MAC address`);
      const normalized = mac.toLowerCase().replace(/-/g, ':');
      return macPattern.test(normalized) ? normalized : fail(`${mac} is not a MAC address`);
    });
  }
  if (input.productUuid !== undefined) out.productUuid = text(input.productUuid, 'productUuid', 64).toLowerCase();
  if (input.arch !== undefined) out.arch = input.arch === 'x86_64' || input.arch === 'arm64' ? input.arch : fail("arch must be 'x86_64' or 'arm64'");
  if (input.uefi !== undefined) out.uefi = typeof input.uefi === 'boolean' ? input.uefi : fail('uefi must be true or false');
  if (input.hardwareProfile !== undefined) out.hardwareProfile = text(input.hardwareProfile, 'hardwareProfile', 64);
  return out;
}

/** What a verb's workflows are checked against: the module's hardware profiles and BMC drivers. */
interface Capabilities {
  hardwareProfiles: Readonly<Record<string, HardwareProfile>>;
  bmcDrivers?: BmcDriverCapabilities;
}

/**
 * Refuses (`UNSUPPORTED`, bmc-driver-unsupported) a node now in `node.provision_state` whose chain of
 * workflows, from that state on, needs a BMC operation its driver lacks (capabilities.ts).
 */
async function assertChainServed(tx: SqlTx, node: MetalNodeRow, caps: Capabilities, extra: readonly ProfileDocument[] = []): Promise<void> {
  const profiles = stateChain(node.provision_state).flatMap((state) => stateProfile(state, node.pool_agent, { tenantRoot: node.tenant_root }) ?? []);
  if (profiles.length === 0 && extra.length === 0) return;
  assertBmcNeeds([...extra, ...profiles], node, { ...caps, reportedKinds: await siteDriverKinds(tx, node.site_id, node.bmc_driver) });
}

async function enroll(context: MethodContext, caps: Capabilities, input: EnrollInput): Promise<MetalNodeView> {
  const { hardwareProfiles } = caps;
  // Inline credentials go to the secret broker before anything else, so they never reach a row.
  let credentials: SecretRef;
  if (typeof input.bmc.credentials === 'string') credentials = input.bmc.credentials;
  else {
    if (!context.secrets)
      throw new ComputeError('INVALID_CONFIG', 'No secret broker is configured; pass bmc.credentials as a secret:// reference');
    credentials = await context.secrets.put(input.tenantId, JSON.stringify(input.bmc.credentials));
  }
  return context.sql.transaction(async (tx) => {
    const pools = await tx.query<{
      site_id: string;
      owner_tenant_id: string;
      agent: 'bcd' | 'none' | null;
      policy: ({ hardwareProfile?: string } & Record<string, unknown>) | null;
    }>('SELECT site_id, owner_tenant_id, agent, policy FROM pools WHERE id = $1', [input.poolId]);
    const pool = pools.rows[0];
    if (!pool || pool.owner_tenant_id !== input.tenantId) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} does not exist`);
    if (pool.site_id !== input.siteId) throw new ComputeError('INVALID_INPUT', `Pool ${input.poolId} is not in site ${input.siteId}`);
    const profile = input.hardwareProfile ?? pool.policy?.hardwareProfile;
    // Enrollment runs on to ready (enrolling → inspecting → commissioning): the BMC driver must serve all
    // of it, and a machine the ramdisk boots needs PXE MACs its driver can report or the caller gives.
    const planned = {
      bmc_driver: input.bmc.driver,
      macs: input.macs ?? [],
      pool_agent: pool.agent,
      hardware_profile: profile ?? null,
      pool_policy: pool.policy,
    };
    const checks = { ...caps, reportedKinds: await siteDriverKinds(tx, input.siteId, input.bmc.driver) };
    assertPxeMacsKnowable(planned, checks);
    assertBmcNeeds(stateChain('enrolling').flatMap((state) => stateProfile(state, pool.agent) ?? []), planned, checks);
    const drivers = resolveDriverBindings(hardwareProfiles, profile, { driver: input.bmc.driver, address: input.bmc.address, credentials });
    const id = newId('node');
    await tx.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version, adapter, drivers, power)
       VALUES ($1, $2, $3, $4, 'unassigned', 'enrolling', false, false, 'disconnected', 'platform', 1, 0, 1, 0, $5, 1,
         'bcd/v1', $6::jsonb, 'unknown')`,
      [id, input.siteId, input.poolId, input.tenantId, shardOf(id), JSON.stringify(drivers)],
    );
    await tx.query(
      `INSERT INTO metal_nodes (node_id, tenant_id, bmc_driver, bmc_address, bmc_credentials, bmc_tls_spki_sha256, macs,
         product_uuid, arch, uefi, hardware_profile)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        input.tenantId,
        input.bmc.driver,
        input.bmc.address,
        credentials,
        input.bmc.tlsSpkiSha256 ?? null,
        input.macs ?? [],
        input.productUuid ?? null,
        input.arch ?? 'x86_64',
        input.uefi ?? true,
        profile ?? null,
      ],
    );
    await context.authz?.upsert(tx, {
      type: 'node',
      id,
      tenantId: input.tenantId,
      attributes: { provisionState: 'enrolling', poolId: input.poolId, siteId: input.siteId },
      parentType: 'pool',
      parentId: input.poolId,
    });
    await context.work.enqueue(tx, metalWorkKind, id);
    await context.events.publish(tx, {
      type: 'node.enrolled',
      tenantId: input.tenantId,
      subject: `node/${id}`,
      data: { nodeId: id, poolId: input.poolId, siteId: input.siteId },
    });
    return metalNodeView(await readMetalNode(tx, id));
  });
}

/** Applies one verb to a node the tenant owns, then queues the reconciler. */
async function verb(
  context: MethodContext,
  input: MetalNodeInput,
  provisionVerb: ProvisionVerb,
  before?: (tx: import('@better-compute/core').SqlTx, node: MetalNodeRow) => Promise<{ to?: ProvisionState; profiles?: ProfileDocument[] } | void>,
  caps?: Capabilities,
): Promise<MetalNodeView> {
  return context.sql.transaction(async (tx) => {
    const node = await readMetalNode(tx, input.nodeId, { tenantId: input.tenantId, lock: true });
    const { profiles, ...extra } = (await before?.(tx, node)) ?? {};
    const from = node.provision_state;
    const to = await applyProvisionVerb(tx, node, provisionVerb, extra);
    // The workflows this verb starts must be ones the node's BMC driver can serve (rolled back if not).
    if (caps) await assertChainServed(tx, node, caps, profiles);
    await setMetalWorkflow(tx, node.node_id, null, null);
    await context.authz?.upsert(tx, {
      type: 'node',
      id: node.node_id,
      tenantId: node.tenant_id,
      attributes: { provisionState: to, ...(node.pool_id ? { poolId: node.pool_id } : {}), siteId: node.site_id },
      ...(node.pool_id ? { parentType: 'pool', parentId: node.pool_id } : {}),
    });
    await context.work.enqueue(tx, metalWorkKind, node.node_id);
    await context.events.publish(tx, {
      type: `node.provision.${to}`,
      tenantId: node.tenant_id,
      subject: `node/${node.node_id}`,
      data: { nodeId: node.node_id, from, verb: provisionVerb },
    });
    return metalNodeView(await readMetalNode(tx, node.node_id));
  });
}

/** The metal group over the module's hardware profiles. */
export function metalApi(hardwareProfiles: Readonly<Record<string, HardwareProfile>>, bmcDrivers?: BmcDriverCapabilities): MetalApi {
  const caps: Capabilities = { hardwareProfiles, ...(bmcDrivers ? { bmcDrivers } : {}) };
  const onNode = (input: { nodeId: string }) => ({ type: 'node', id: input.nodeId });
  // The steps metal's state profiles use, for the kinds a bulk verb's workflows can send.
  let steps: StepRegistry | undefined;
  const scopeSteps = () => (steps ??= stepRegistry([...metalSteps({ hardwareProfiles }), ...builtinSteps]));
  const simple = (provisionVerb: ProvisionVerb) =>
    defineMethod<MetalNodeInput, MetalNodeView>({
      action: 'compute:nodes:provision',
      kind: 'mutation',
      resource: onNode,
      validate: describedBy(schemas.node, (raw) => nodeInput(raw)),
      handler: (context, input) => verb(context, input, provisionVerb, undefined, caps),
    });

  return {
    metal: {
      enroll: defineMethod<EnrollInput, MetalNodeView>({
        action: 'compute:nodes:provision',
        kind: 'mutation',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        validate: describedBy(schemas.enroll, validateEnroll),
        handler: (context, input) => enroll(context, caps, input),
      }),
      manage: simple('manage'),
      inspect: simple('inspect'),
      provide: simple('provide'),
      deploy: defineMethod<DeployInput, MetalNodeView>({
        action: 'compute:nodes:provision',
        kind: 'mutation',
        resource: onNode,
        validate: describedBy(schemas.deploy, (raw): DeployInput => {
          const input = nodeInput(raw, ['profileId', 'profileVersion']);
          const version = input.profileVersion;
          if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) fail('profileVersion must be a positive integer');
          return { tenantId: input.tenantId, nodeId: input.nodeId, profileId: text(input.profileId, 'profileId', 128), profileVersion: version };
        }),
        handler: (context, input) =>
          verb(
            context,
            input,
            'deploy',
            async (tx, node) => {
              await tx.query('UPDATE metal_nodes SET deploy_profile_id = $2, deploy_profile_version = $3 WHERE node_id = $1', [
                node.node_id,
                input.profileId,
                input.profileVersion,
              ]);
              // A stored profile (the tenant's, or a public one) is checked against the BMC driver now; a
              // module-shipped one when its workflow starts (the reconciler).
              const { rows } = await tx.query<{ document: ProfileDocument }>(
                `SELECT document FROM profiles
                  WHERE id = $1 AND profile_version = $2 AND deleted_at IS NULL AND (tenant_id = $3 OR visibility = 'public')
                  ORDER BY (tenant_id = $3) DESC LIMIT 1`,
                [input.profileId, input.profileVersion, node.tenant_id],
              );
              return rows[0] ? { profiles: [rows[0].document] } : {};
            },
            caps,
          ),
      }),
      undeploy: defineMethod<UndeployInput, MetalNodeView>({
        action: 'compute:nodes:provision',
        kind: 'mutation',
        resource: onNode,
        validate: describedBy(schemas.undeploy, (raw): UndeployInput => {
          const input = nodeInput(raw, ['wipe']);
          const out: UndeployInput = { tenantId: input.tenantId, nodeId: input.nodeId };
          if (input.wipe !== undefined) out.wipe = wipeModes.includes(input.wipe as WipeMode) ? (input.wipe as WipeMode) : fail(`wipe must be one of ${wipeModes.join(', ')}`);
          return out;
        }),
        handler: (context, input) =>
          verb(
            context,
            input,
            'release',
            async (tx, node) => {
              await tx.query('UPDATE metal_nodes SET release_wipe = $2 WHERE node_id = $1', [node.node_id, input.wipe ?? 'quick']);
            },
            caps,
          ),
      }),
      rescue: simple('rescue'),
      unrescue: defineMethod<MetalNodeInput, MetalNodeView>({
        action: 'compute:nodes:provision',
        kind: 'mutation',
        resource: onNode,
        validate: describedBy(schemas.node, (raw) => nodeInput(raw)),
        handler: (context, input) =>
          context.sql.transaction(async (tx) => {
            const node = await readMetalNode(tx, input.nodeId, { tenantId: input.tenantId, lock: true });
            // Checked against the state table now, applied by the reconciler once the OS is back.
            if (!provisionStateTable.transitions[node.provision_state]?.unrescue)
              throw new ComputeError('INVALID_STATE', `A ${node.provision_state} node cannot unrescue`);
            if (node.phase === unrescuePhase && node.workflow_id) return metalNodeView(node);
            assertBmcNeeds([unrescueProfile], node, { ...caps, reportedKinds: await siteDriverKinds(tx, node.site_id, node.bmc_driver) });
            if (node.workflow_id) {
              const { rows } = await tx.query<{ state: string }>('SELECT state FROM workflows WHERE id = $1', [node.workflow_id]);
              if (rows[0] && ['pending', 'running', 'paused'].includes(rows[0].state))
                throw new ComputeError('CONFLICT', `Node ${node.node_id} is still booting its rescue ramdisk`);
            }
            if (!context.workflows) throw new ComputeError('INVALID_CONFIG', 'metal() needs the provision module: ModuleContext.workflows is not set');
            const { id } = await context.workflows.start(tx, {
              tenantId: node.tenant_id,
              profileId: unrescueProfile.id,
              profileVersion: unrescueProfile.version,
              nodeId: node.node_id,
              owner: metalWorkKind,
            } as Parameters<NonNullable<MethodContext['workflows']>['start']>[1]);
            await setMetalWorkflow(tx, node.node_id, unrescuePhase, id);
            await context.work.enqueue(tx, metalWorkKind, node.node_id);
            await context.events.publish(tx, {
              type: 'node.provision.unrescuing',
              tenantId: node.tenant_id,
              subject: `node/${node.node_id}`,
              data: { nodeId: node.node_id, workflowId: id },
            });
            return metalNodeView(await readMetalNode(tx, node.node_id));
          }),
      }),
      abort: defineMethod<AbortInput, MetalNodeView>({
        action: 'compute:nodes:provision',
        kind: 'mutation',
        resource: onNode,
        validate: describedBy(schemas.abort, (raw): AbortInput => {
          const input = nodeInput(raw, ['reason']);
          const out: AbortInput = { tenantId: input.tenantId, nodeId: input.nodeId };
          if (input.reason !== undefined) out.reason = text(input.reason, 'reason', 512);
          return out;
        }),
        handler: (context, input) =>
          verb(context, input, 'abort', async (tx, node) => {
            if (node.workflow_id && context.workflows) await context.workflows.abort(tx, node.workflow_id);
            await tx.query('UPDATE metal_nodes SET last_error = $2::jsonb WHERE node_id = $1', [
              node.node_id,
              JSON.stringify({ code: 'ABORTED', message: input.reason ?? 'aborted by an operator' }),
            ]);
          }),
      }),
      recover: defineMethod<MetalNodeInput, MetalNodeView>({
        action: 'compute:nodes:provision',
        kind: 'mutation',
        resource: onNode,
        validate: describedBy(schemas.node, (raw) => nodeInput(raw)),
        handler: (context, input) =>
          verb(
            context,
            input,
            'recover',
            async (_tx, node) => {
              if (node.provision_state !== 'failed' || !node.failed_from)
                throw new ComputeError('INVALID_STATE', `Node ${node.node_id} is ${node.provision_state}, not failed`);
              return { to: recoverTarget(node.failed_from) };
            },
            caps,
          ),
      }),
      retire: simple('retire'),
      power: defineMethod<PowerInput, PowerOutput>({
        action: 'compute:nodes:power',
        kind: 'mutation',
        resource: onNode,
        validate: describedBy(schemas.power, (raw): PowerInput => {
          const input = nodeInput(raw, ['action']);
          if (!powerActions.includes(input.action as PowerAction)) fail(`action must be one of ${powerActions.join(', ')}`);
          return { tenantId: input.tenantId, nodeId: input.nodeId, action: input.action as PowerAction };
        }),
        handler: (context, input) =>
          context.sql.transaction(async (tx) => {
            const node = await readMetalNode(tx, input.nodeId, { tenantId: input.tenantId });
            if (!node.bmc_credentials) throw new ComputeError('INVALID_STATE', `Node ${node.node_id} has no BMC credentials`);
            if (servesBmcOperation(node.bmc_driver, 'power.setPower', caps.bmcDrivers, await siteDriverKinds(tx, node.site_id, node.bmc_driver)) === false)
              throw bmcDriverUnsupported(node.bmc_driver, [{ profile: 'metal.power', step: 'power.setPower', operations: ['power.setPower'] }]);
            if (['deploying', 'releasing', 'commissioning', 'inspecting'].includes(node.provision_state))
              throw new ComputeError('INVALID_STATE', `Node ${node.node_id} is ${node.provision_state}; a workflow controls its power`);
            const agent = await siteAgentFor(tx, node.node_id);
            if (!agent) throw new ComputeError('INVALID_STATE', `No site agent serves site ${node.site_id}`);
            const { rows } = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
            // Destructive (§13): a batch of one leaf, this machine's BMC through this agent, bound to
            // exactly this payload (the approvers see the power action). One encoding for both.
            const payload = encodeMessageJson(metalPayloads.bmcOperation.typeName, bmcOperationJson(node, 'power.setPower', { action: input.action }));
            const batch = context.commands.createBatch
              ? await context.commands.createBatch(tx, {
                  tenantId: node.tenant_id,
                  scope: [
                    {
                      subject: batchSubject('bmc.power', { nodeId: node.node_id, bmcAddress: node.bmc_address }, agent),
                      kind: 'bmc.power',
                      payload: { typeUrl: `type.googleapis.com/${metalPayloads.bmcOperation.typeName}`, value: payload },
                    },
                  ],
                  reason: `power ${input.action} ${node.node_id}`,
                })
              : undefined;
            const command = await context.commands.enqueue(tx, {
              nodeId: agent,
              kind: 'bmc.power',
              payload,
              idempotencyKey: `metal:power:${context.requestId}`,
              notAfter: rows[0]!.now.getTime() + 5 * 60_000,
              ...(batch ? { batchId: batch.batchId } : {}),
            });
            return { commandId: command.id, ...(batch ? { batchId: batch.batchId, held: batch.held } : {}) };
          }),
      }),
      bulk: defineMethod<BulkInput, BulkOutput>({
        action: 'compute:nodes:provision',
        kind: 'mutation',
        resource: (input) => ({ type: 'pool', id: input.poolId }),
        transaction: 'manual',
        validate: describedBy(schemas.bulk, (raw): BulkInput => {
          const input = object(raw, ['tenantId', 'poolId', 'verb', 'nodeIds', 'wipe', 'reason']);
          const verb = Object.hasOwn(bulkVerbs, input.verb as string) ? (input.verb as BulkVerb) : fail(`verb must be one of ${Object.keys(bulkVerbs).join(', ')}`);
          if (!Array.isArray(input.nodeIds) || input.nodeIds.length === 0 || input.nodeIds.length > 10_000)
            fail('nodeIds must list 1 to 10000 nodes');
          const nodeIds = input.nodeIds.map(nodeId);
          if (new Set(nodeIds).size !== nodeIds.length) fail('nodeIds lists a node twice');
          const out: BulkInput = {
            tenantId: tenant(input.tenantId),
            poolId: text(input.poolId, 'poolId', 128),
            verb,
            nodeIds,
            reason: text(input.reason, 'reason', 512),
          };
          if (input.wipe !== undefined) {
            if (verb !== 'undeploy') fail('wipe is only for undeploy');
            out.wipe = wipeModes.includes(input.wipe as WipeMode) ? (input.wipe as WipeMode) : fail(`wipe must be one of ${wipeModes.join(', ')}`);
          }
          return out;
        }),
        async handler(context, input) {
          if (!context.check || !context.invoke) throw new ComputeError('INVALID_STATE', 'metal.bulk runs as a composite method of the envelope');
          const path = `metal/${input.verb}` as const;
          const calls = input.nodeIds.map((id) => ({ tenantId: input.tenantId, nodeId: id, ...(input.wipe ? { wipe: input.wipe } : {}) }));
          // Each node is its own decision, as if called one by one (no transaction open: IAM is never awaited in one).
          for (const call of calls) await context.check(path, call);
          return context.sql.transaction(async (tx) => {
            const rows = [];
            for (const id of input.nodeIds) {
              const row = await readMetalNode(tx, id, { tenantId: input.tenantId, lock: true });
              if (row.pool_id !== input.poolId) throw new ComputeError('INVALID_INPUT', `Node ${id} is not in pool ${input.poolId}`);
              rows.push(row);
            }
            const scope = await verbBatchScope(tx, context.registry, scopeSteps(), rows, bulkVerbs[input.verb]);
            let batch: BulkOutput['batch'];
            if (scope.length > 0 && context.commands.createBatch) {
              batch = await context.commands.createBatch(tx, { tenantId: input.tenantId, scope, reason: input.reason });
              await tx.query('UPDATE metal_nodes SET batch_id = $2 WHERE node_id = ANY($1::text[])', [input.nodeIds, batch.batchId]);
            }
            const nodes: MetalNodeView[] = [];
            for (const call of calls) nodes.push(await context.invoke!<MetalNodeView>(tx, path, call));
            return { ...(batch ? { batch } : {}), nodes };
          });
        },
      }),
    },
  };
}
