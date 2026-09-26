/**
 * Fleet data for the admin panel: types on the REAL better-compute API shapes (nodes.list/get,
 * inventory devices, instances, sandboxes, volumes, snapshots, rollouts, commandBatches, fleet.status,
 * metal.discovered, workflows, events) plus a deterministic simulated fleet.
 *
 * `simulateFleet(now, seed)` is pure: the same (now, seed) yields the same snapshot on the server and in
 * the browser (no Math.random, no Date.now). The fleet's structure depends on the seed only; telemetry,
 * the rolling sandbox population, rollout progress and the event stream are functions of `now`, so a
 * page that re-simulates every few seconds looks live.
 *
 * The live adapter maps API responses onto the same types. Fields no API method returns yet are
 * optional and say where they come from (GPU telemetry is OTLP metrics, not inventory).
 *
 * The fleet is built on the shared topology (lib/data/topology.ts: sites, pools, node ids, tenants) and its
 * node health and GPU bookings follow `poolPulse` (lib/data/platform.ts), so the Overview, the capacity
 * pages and these pages count the same machines.
 */

import { DAY, HOUR, MINUTE, drift, hash, noise, rng } from './core';
import { gpuHolders } from './capacity';
import { nodeHealth, type NodeHealth } from './fleet-health';
import { poolPulse, type Severity } from './platform';
import { poolNodeId, poolNodePlacement, pools as topologyPools, sites as topologySites, tenants, type Pool, type Site } from './topology';

// --- API shapes (mirrors of packages/*; keep in step) ------------------------------------------------

export type ProvisionState =
  | 'adopting'
  | 'adopted'
  | 'enrolling'
  | 'inspecting'
  | 'commissioning'
  | 'ready'
  | 'deploying'
  | 'deployed'
  | 'releasing'
  | 'rescue'
  | 'failed'
  | 'retiring'
  | 'retired';
export const provisionStates: readonly ProvisionState[] = [
  'adopting',
  'adopted',
  'enrolling',
  'inspecting',
  'commissioning',
  'ready',
  'deploying',
  'deployed',
  'releasing',
  'rescue',
  'failed',
  'retiring',
  'retired',
];
export type Connectivity = 'connected' | 'disconnected' | 'unreachable' | 'lost';
export const connectivityStates: readonly Connectivity[] = ['connected', 'disconnected', 'unreachable', 'lost'];
export type NodeRole = 'unassigned' | 'host' | 'dedicated' | 'site';
export type NodeTrust = 'platform' | 'tenant-owned' | 'tenant-controlled';
export type PowerState = 'on' | 'off' | 'unknown';

/** core/domain.ts Condition (capacity.ts exports the same shape under this name, so it is not re-exported). */
interface Condition {
  type: string;
  status: 'true' | 'false' | 'unknown';
  reason?: string;
  message?: string;
  since: number;
}
export type LabelSource = 'inventory' | 'operator' | 'system';
export interface Label {
  key: string;
  value: string;
  source: LabelSource;
}

/** server/api/nodes.ts NodeInfo. */
export interface NodeInfo {
  id: string;
  siteId: string;
  poolId?: string;
  ownerTenantId: string;
  role: NodeRole;
  provisionState: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  connectivity: Connectivity;
  trust: NodeTrust;
  noScheduleReasons: string[];
  hardwareKeyTrusted: boolean;
  generation: number;
  observedGeneration: number;
  identityGeneration: number;
  version: number;
}
/** server/api/nodes.ts NodeDetail. */
export interface NodeDetail extends NodeInfo {
  labels: Label[];
  conditions: Condition[];
  session?: { epoch: number; gatewayId?: string; connectedAt?: number; disconnectedAt?: number; lastSeen?: number };
}

export type DeviceClass = 'gpu' | 'gpu.mig' | 'gpu.slot' | 'nic.vf' | 'disk' | 'node';
/** core/domain.ts Device (GPU attributes from inventory/devices.ts gpuAttributes). */
export interface Device {
  id: string;
  nodeId: string;
  parentId?: string;
  class: DeviceClass;
  bookable: boolean;
  healthy: boolean;
  attributes: Record<string, string | number | boolean>;
}

export type InstanceState =
  | 'pending'
  | 'scheduling'
  | 'provisioning'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'rebooting'
  | 'resizing'
  | 'deleting'
  | 'deleted'
  | 'error'
  | 'lost'
  | 'paused';
export type InstanceDesiredState = 'running' | 'stopped' | 'deleted' | 'paused';
export interface Operation {
  id: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  error?: { code: string; message: string };
}
/** core/domain.ts Instance. */
export interface Instance {
  id: string;
  tenantId: string;
  poolId: string;
  projectId?: string;
  flavor: string;
  imageId: string;
  sshKeys: string[];
  state: InstanceState;
  desiredState: InstanceDesiredState;
  nodeId?: string;
  allocationId?: string;
  externalId?: string;
  addresses: string[];
  ownerIdentityId: string;
  idempotencyKey: string;
  conditions: Condition[];
  operation?: Operation;
  version: number;
}

export type SandboxState = 'starting' | 'ready' | 'failed' | 'deleting' | 'deleted';
/** vps/sandboxes.ts Sandbox. */
export interface Sandbox {
  id: string;
  tenantId: string;
  templateId: string;
  poolId: string;
  instanceId: string;
  state: SandboxState;
  instanceState: InstanceState;
  addresses: string[];
  nodeId?: string;
  ttlSeconds: number;
  expiresAt: number;
  warm: boolean;
  ownerIdentityId: string;
  idempotencyKey: string;
  createdAt: number;
  readyAt?: number;
  expiredAt?: number;
  fromSnapshot?: string;
  identityRebound?: boolean;
  snapshots?: SandboxSnapshot[];
}
export type SandboxNetwork = 'egress' | 'private' | 'none';
export interface TemplateVolume {
  volumeId: string;
  mountPath: string;
  readOnly: boolean;
}
/** vps/sandboxes.ts SandboxTemplate. */
export interface SandboxTemplate {
  id: string;
  tenantId: string;
  name: string;
  poolId: string;
  flavor: string;
  imageId: string;
  runtime: string;
  userData?: string;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  warm: { min: number; max: number };
  env: Record<string, string>;
  network: SandboxNetwork;
  volumes: TemplateVolume[];
  version: number;
}
export type SnapshotState = 'pending' | 'ready' | 'failed' | 'deleted';
/** vps/snapshots.ts SandboxSnapshot. */
export interface SandboxSnapshot {
  id: string;
  tenantId: string;
  sandboxId: string;
  templateId: string;
  state: SnapshotState;
  includeMemory: boolean;
  keep: boolean;
  runtime: string;
  sha256?: string;
  sizeBytes?: number;
  cpuModel?: string;
  reason?: string;
  ownerIdentityId: string;
  createdAt: number;
  readyAt?: number;
}
export type VolumeState = 'ready' | 'deleting' | 'deleted';
/** vps/volumes.ts SandboxVolume. */
export interface SandboxVolume {
  id: string;
  tenantId: string;
  poolId: string;
  name: string;
  sizeGiB: number;
  serial: string;
  nodeId?: string;
  state: VolumeState;
  createdAt: number;
  deletedAt?: number;
}

export type RolloutState = 'running' | 'paused' | 'completed' | 'aborted';
export type RolloutNodeState =
  | 'pending'
  | 'upgrading'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'rolling-back'
  | 'rolled-back';
export const rolloutNodeStates: readonly RolloutNodeState[] = [
  'succeeded',
  'upgrading',
  'pending',
  'failed',
  'rolling-back',
  'rolled-back',
  'skipped',
];
/** rollout/rollout.ts Rollout (gates inlined). */
export interface Rollout {
  id: string;
  tenantId: string;
  version: string;
  state: RolloutState;
  poolIds?: string[];
  waves: number[];
  maxFailureRatio: number;
  soakSeconds: number;
  upgradeTimeoutSeconds: number;
  wave: number;
  waveStartedAt: number;
  waveDoneAt?: number;
  rollback: boolean;
  reason?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  nodes: Record<RolloutNodeState, number>;
}
export interface RolloutNode {
  nodeId: string;
  poolId: string;
  wave: number;
  state: RolloutNodeState;
  fromVersion?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export type BatchState = 'pending' | 'approved' | 'expired' | 'cancelled';
/** server/quorum/quorum.ts CommandBatchView. */
export interface CommandBatchView {
  batchId: string;
  tenantId: string;
  reason: string;
  state: BatchState;
  scopeRoot: string;
  trustDomain?: string;
  scopeSize: number;
  requiredApprovals: number;
  notAfter: number;
  approvals: { kid: string; at: number; approvedBy?: string }[];
  commands: Record<string, number>;
  createdAt: number;
  approvedAt?: number;
  createdBy?: string;
  createdByAgent?: string;
  delegationId?: string;
}
export interface BatchMember {
  commandId: string;
  nodeId: string;
  subject: string;
  kind: string;
  state: string;
  reason?: string;
  awaitingApproval?: true;
}

/** fleet/plan.ts FleetChange. */
export interface FleetChange {
  kind: 'site' | 'providerAccount' | 'pool' | 'ownerQuota' | 'offer' | 'flavor' | 'sandboxTemplate';
  name: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  fields?: string[];
  blocked?: string;
  note?: string;
}
/** fleet/drift.ts FleetStatus. */
export interface FleetStatus {
  tenantId: string;
  applied?: { planHash: string; appliedBy: string; appliedAt: number; prune: boolean; checkedAt?: number };
  drift?: {
    changes: FleetChange[];
    summary: Record<FleetChange['action'], number>;
    blocked: boolean;
    planHash: string;
  };
}

/** metal/discovery.ts DiscoveredMachineView (plus the site it was seen at). */
export interface DiscoveredMachine {
  siteId: string;
  mac: string;
  productUuid?: string;
  arch?: string;
  firstSeen?: string;
  lastSeen?: string;
  count: number;
  relays: string[];
  agentNodeIds: string[];
  nodeId?: string;
  candidateFor?: string;
}

export type WorkflowState = 'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type StepState = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
/** provision/api.ts WorkflowView, trimmed to what the panel shows. */
export interface WorkflowView {
  id: string;
  tenantId: string;
  nodeId?: string;
  instanceId?: string;
  profileId: string;
  profileVersion: number;
  state: WorkflowState;
  stepId?: string;
  version: number;
  outcome?: 'failed' | 'cancelled';
  createdAt: number;
  finishedAt?: number;
  steps: {
    id: string;
    index: number;
    action: string;
    driver?: string;
    runsOn: 'control-plane' | 'site' | 'node' | 'ramdisk';
    state: StepState;
    attempt: number;
    phase: 'main' | 'on-failure' | 'cleanup';
    startedAt?: number;
    finishedAt?: number;
  }[];
}

/** core/domain.ts ComputeEvent. */
export interface ComputeEvent<D = Record<string, unknown>> {
  id: string;
  type: string;
  tenantId: string;
  subject: string;
  time: string;
  sequence: string;
  data: D;
}

// --- Admin view models -------------------------------------------------------------------------------

/** Live GPU readings: OTLP metrics from bcd (daemon/internal/nvml), not inventory. */
export interface GpuTelemetry {
  utilization: number;
  /** Fraction of VRAM in use. */
  memoryUsed: number;
  temperatureC: number;
  powerW: number;
  powerLimitW: number;
}
export interface FleetGpu extends Device {
  index: number;
  uuid: string;
  model: string;
  vramGiB: number;
  migEnabled: boolean;
  eccUncorrectable: number;
  /** The last XID the daemon reported, when there is one. */
  xid?: { code: number; at: number };
  /** Who holds it: capacity allocations (reservation, tenant). */
  allocation?: { reservationId: string; tenantId: string; since: number };
  telemetry?: GpuTelemetry;
}


export interface FleetNode extends NodeDetail {
  hostname: string;
  /** `FRA1-R03`, from the topology's placement. */
  rack: string;
  /** The top rack unit it occupies (topology placement) and its height in U. */
  unit: number;
  heightU: number;
  poolKind: Pool['kind'];
  /** The same bucket poolPulse counts it in. */
  health: NodeHealth;
  power: PowerState;
  daemonVersion: string;
  gpuModel?: string;
  gpus: FleetGpu[];
  cpu: { model: string; vcpus: number; utilization?: number };
  memoryGiB: number;
  memoryUtilization?: number;
  instanceCount: number;
  sandboxCount: number;
  bmc?: { driver: 'redfish' | 'ipmi'; address: string };
}

/** A condition worth an operator's attention, with how bad it is. */
export interface FleetIncident {
  id: string;
  nodeId: string;
  hostname: string;
  siteId: string;
  poolId?: string;
  condition: Condition;
  severity: Severity;
  action?: 'quarantine-gpu' | 'drain-reboot' | 'drain-gpu-reset' | 'rma';
}

export interface FleetSnapshot {
  seed: string;
  now: number;
  simulated: boolean;
  tenantId: string;
  sites: Site[];
  pools: Pool[];
  nodes: FleetNode[];
  instances: Instance[];
  sandboxes: Sandbox[];
  templates: SandboxTemplate[];
  volumes: SandboxVolume[];
  snapshots: SandboxSnapshot[];
  rollouts: (Rollout & { nodeList: RolloutNode[] })[];
  batches: (CommandBatchView & { members: BatchMember[] })[];
  drift: FleetStatus;
  discovered: DiscoveredMachine[];
  workflows: WorkflowView[];
  incidents: FleetIncident[];
}

// --- Condition knowledge (inventory/conditions.ts, inventory/health.ts, gateway/health.ts) --------------

const conditionInfo: Record<string, { severity: Severity; action?: FleetIncident['action']; label: string }> = {
  Xid48: { severity: 'critical', action: 'quarantine-gpu', label: 'Double-bit ECC error (XID 48)' },
  Xid79: { severity: 'critical', action: 'drain-reboot', label: 'GPU fell off the bus (XID 79)' },
  Xid95: { severity: 'critical', action: 'drain-reboot', label: 'Uncontained ECC error (XID 95)' },
  RowRemapPending: { severity: 'warning', action: 'drain-gpu-reset', label: 'Row remap pending' },
  RowRemapFailed: { severity: 'critical', action: 'rma', label: 'Row remap failed' },
  EccUncorrectable: { severity: 'critical', action: 'quarantine-gpu', label: 'Uncorrectable ECC errors' },
  NvlinkDegraded: { severity: 'warning', label: 'NVLink degraded' },
  PcieReplayHigh: { severity: 'warning', label: 'PCIe replay rate high' },
  GpuCountMismatch: { severity: 'critical', label: 'GPU count differs from the pool' },
  GpuModelUnknown: { severity: 'warning', label: 'Unknown GPU model' },
  DiskPressure: { severity: 'warning', label: 'Disk pressure' },
  MemoryPressure: { severity: 'warning', label: 'Memory pressure' },
  CpuPressure: { severity: 'info', label: 'CPU pressure' },
  DriverMismatch: { severity: 'warning', label: 'Driver differs from the pool' },
  DaemonOutdated: { severity: 'info', label: 'bcd behind the current release' },
  CertExpiring: { severity: 'warning', label: 'Node certificate expiring' },
  ClockSkew: { severity: 'warning', label: 'Clock skew' },
  DuplicateIdentity: { severity: 'critical', label: 'Duplicate identity' },
  NodeUnreachable: { severity: 'critical', label: 'Node unreachable' },
  AcceptanceFailed: { severity: 'critical', label: 'Acceptance failed' },
  FabricManagerDown: { severity: 'critical', label: 'Fabric Manager down' },
  RebootRequired: { severity: 'info', label: 'Reboot required' },
  MPSDown: { severity: 'warning', label: 'MPS daemon down' },
};

export function describeCondition(type: string): { severity: Severity; label: string; action?: FleetIncident['action'] } {
  const known = conditionInfo[type];
  if (known) return known;
  const xid = /^Xid(\d+)$/.exec(type);
  if (xid) return { severity: 'warning', label: `GPU XID ${xid[1]}` };
  return { severity: 'info', label: type.replace(/([a-z])([A-Z])/g, '$1 $2') };
}

const severityRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Every true condition of every node, worst first, newest first within a severity. */
export function fleetIncidents(nodes: readonly FleetNode[]): FleetIncident[] {
  const out: FleetIncident[] = [];
  for (const node of nodes)
    for (const condition of node.conditions) {
      if (condition.status !== 'true') continue;
      const info = describeCondition(condition.type);
      out.push({
        id: `${node.id}:${condition.type}`,
        nodeId: node.id,
        hostname: node.hostname,
        siteId: node.siteId,
        ...(node.poolId ? { poolId: node.poolId } : {}),
        condition,
        severity: info.severity,
        ...(info.action ? { action: info.action } : {}),
      });
    }
  return out.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.condition.since - a.condition.since);
}

/** A node's worst true condition, if any. */
export function nodeSeverity(node: FleetNode): Severity | undefined {
  let worst: Severity | undefined;
  for (const condition of node.conditions) {
    if (condition.status !== 'true') continue;
    const severity = describeCondition(condition.type).severity;
    if (severity === 'critical') return 'critical';
    if (severity === 'warning') worst = 'warning';
    else worst ??= 'info';
  }
  return worst;
}

/** Schedulable = adopted/deployed, connected, not cordoned, no maintenance, no NoSchedule reasons. */
export function isSchedulable(node: NodeInfo): boolean {
  return (
    (node.provisionState === 'adopted' || node.provisionState === 'deployed') &&
    node.connectivity === 'connected' &&
    !node.cordoned &&
    !node.maintenance &&
    node.noScheduleReasons.length === 0
  );
}

// --- Deterministic helpers ------------------------------------------------------------------------------

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** A stable id with a prefix: `rsv_7k2q…`. */
function sid(prefix: string, key: string, length = 12): string {
  const next = rng(hash(key));
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * 32)];
  return `${prefix}_${out}`;
}
function choose<T>(items: readonly T[], r: number): T {
  return items[Math.min(items.length - 1, Math.floor(r * items.length))]!;
}
/** Stable order of items by a key: the first N of it are "the N affected". */
function ranked<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => noise(key(a)) - noise(key(b)));
}

export const CURRENT_BCD = '1.4.2';
const ROOT_TENANT = 'ten_root';
const CUSTOMER_TENANTS = tenants.filter((tenant) => tenant.id !== ROOT_TENANT).map((tenant) => tenant.id);
const DRIVER = '570.133.20';

const gpuSpec: Record<string, { arch: string; powerW: number; product: string }> = {
  H100: { arch: 'Hopper', powerW: 700, product: 'NVIDIA H100 80GB HBM3' },
  'H100 MIG': { arch: 'Hopper', powerW: 700, product: 'NVIDIA H100 80GB HBM3' },
  H200: { arch: 'Hopper', powerW: 700, product: 'NVIDIA H200 141GB HBM3e' },
  B200: { arch: 'Blackwell', powerW: 1000, product: 'NVIDIA B200 180GB HBM3e' },
  A100: { arch: 'Ampere', powerW: 400, product: 'NVIDIA A100-SXM4-80GB' },
  L40S: { arch: 'Ada Lovelace', powerW: 350, product: 'NVIDIA L40S' },
};

// --- Structure (seed only, memoized) ---------------------------------------------------------------------

interface Structure {
  seed: string;
  nodes: FleetNode[];
  templates: SandboxTemplate[];
  volumes: Omit<SandboxVolume, 'createdAt'>[];
}
const structures = new Map<string, Structure>();

function buildStructure(seed: string): Structure {
  const nodes: FleetNode[] = [];
  for (const pool of topologyPools) {
    const site = topologySites.find((each) => each.id === pool.siteId)!;
    const metal = site.provider === 'metal';
    for (let index = 0; index < pool.nodes; index++) {
      const id = poolNodeId(pool, index);
      const key = `${seed}:${id}`;
      const r = rng(hash(key));
      const { rack, unit } = poolNodePlacement(pool, index);
      const heightU = pool.kind === 'gpu' ? 4 : 2;
      const daemonVersion = r() < 0.16 ? choose(['1.4.1', '1.4.0', '1.3.9'], r()) : CURRENT_BCD;
      const generation = 3 + Math.floor(r() * 40);
      const trust: NodeTrust = site.provider === 'kubernetes' ? 'tenant-owned' : 'platform';
      const gpuModel = pool.kind === 'gpu' ? pool.short : undefined;
      const spec = gpuModel ? gpuSpec[gpuModel] : undefined;
      const gpus: FleetGpu[] = [];
      for (let g = 0; g < pool.gpusPerNode && pool.kind === 'gpu'; g++) {
        const gpuKey = `${key}:gpu:${g}`;
        gpus.push({
          id: sid('dev', gpuKey, 14),
          nodeId: id,
          class: pool.short.includes('MIG') ? 'gpu.mig' : 'gpu',
          bookable: true,
          healthy: true,
          index: g,
          uuid: `GPU-${sid('x', gpuKey, 8).slice(2)}-${sid('x', `${gpuKey}:b`, 4).slice(2)}-${sid('x', `${gpuKey}:c`, 12).slice(2)}`,
          model: gpuModel!,
          vramGiB: pool.gpuMemoryGiB ?? 80,
          migEnabled: pool.short.includes('MIG'),
          eccUncorrectable: 0,
          attributes: {
            gpuModel: gpuModel!.replace(' MIG', ''),
            gpuProduct: spec?.product ?? pool.model,
            vramGiB: pool.gpuMemoryGiB ?? 80,
            index: g,
            pciBusId: `0000:${(0x18 + g * 0x10).toString(16).padStart(2, '0')}:00.0`,
            numaNode: g < pool.gpusPerNode / 2 ? 0 : 1,
            architecture: spec?.arch ?? 'Hopper',
            driverVersion: DRIVER,
            migCapable: gpuModel !== 'L40S',
            ...(pool.short.includes('MIG') ? { migProfile: '1g.10gb' } : {}),
          },
        });
      }
      const labels: Label[] = [
        { key: 'topology.rack', value: rack, source: 'operator' },
        { key: 'cpu.arch', value: 'x86_64', source: 'inventory' },
        { key: 'cpu.model', value: pool.kind === 'gpu' ? 'EPYC 9654' : pool.short, source: 'inventory' },
        { key: 'bc.dev/bcd-version', value: daemonVersion, source: 'system' },
        ...(gpuModel ? [{ key: 'bc.dev/gpu.model', value: gpuModel.replace(' MIG', ''), source: 'system' as const }] : []),
        ...(site.provider === 'kubernetes' ? [{ key: 'bc.dev/kubernetes', value: 'k8s-join', source: 'system' as const }] : []),
        ...(pool.kind === 'sandbox' ? [{ key: 'bc.dev/runtime', value: 'cloud-hypervisor', source: 'system' as const }] : []),
        ...(pool.kind === 'cpu' ? [{ key: 'bc.dev/runtime', value: 'libvirt-kvm', source: 'system' as const }] : []),
        ...(r() < 0.2 ? [{ key: 'team', value: choose(['training', 'inference', 'platform'], r()), source: 'operator' as const }] : []),
      ];
      nodes.push({
        id,
        siteId: pool.siteId,
        poolId: pool.id,
        ownerTenantId: trust === 'tenant-owned' ? 'ten_kestrel' : ROOT_TENANT,
        role: pool.kind === 'gpu' ? 'dedicated' : 'host',
        provisionState: metal ? 'deployed' : 'adopted',
        maintenance: false,
        cordoned: false,
        connectivity: 'connected',
        trust,
        noScheduleReasons: [],
        hardwareKeyTrusted: r() > 0.08,
        generation,
        observedGeneration: generation,
        identityGeneration: 1 + Math.floor(r() * 2),
        version: 10 + Math.floor(r() * 400),
        labels,
        conditions: [],
        hostname: id.replace(/^n-/, ''),
        rack,
        unit,
        heightU,
        poolKind: pool.kind,
        health: 'ready',
        power: 'on',
        daemonVersion,
        ...(gpuModel ? { gpuModel } : {}),
        gpus,
        cpu: { model: pool.kind === 'gpu' ? 'AMD EPYC 9654 96-Core' : pool.model, vcpus: pool.vcpusPerNode },
        memoryGiB: pool.memoryGiBPerNode,
        instanceCount: 0,
        sandboxCount: 0,
        ...(metal
          ? { bmc: { driver: r() < 0.8 ? ('redfish' as const) : ('ipmi' as const), address: `10.${20 + topologySites.indexOf(site)}.${Math.floor(index / 8)}.${10 + (index % 8)}` } }
          : {}),
      });
    }
  }

  const templates: SandboxTemplate[] = [
    { name: 'python-agent', pool: 'pool_sbx_ams2', flavor: 'c2.m4', image: 'ubuntu-24.04-py312', runtime: 'cloud-hypervisor', ttl: 1800, max: 14_400, warm: { min: 8, max: 32 }, network: 'egress' as const },
    { name: 'browser-agent', pool: 'pool_sbx_ams2', flavor: 'c4.m8', image: 'chromium-headless', runtime: 'cloud-hypervisor', ttl: 900, max: 7_200, warm: { min: 4, max: 16 }, network: 'egress' as const },
    { name: 'code-review', pool: 'pool_sbx_iad1', flavor: 'c8.m16', image: 'ubuntu-24.04-dev', runtime: 'cloud-hypervisor', ttl: 3600, max: 28_800, warm: { min: 2, max: 8 }, network: 'private' as const },
    { name: 'gpu-notebook', pool: 'pool_l40s_fra1', flavor: 'g1.l40s', image: 'cuda-12.8-jupyter', runtime: 'libvirt-kvm', ttl: 7200, max: 86_400, warm: { min: 0, max: 4 }, network: 'egress' as const },
    { name: 'airgapped-eval', pool: 'pool_sbx_iad1', flavor: 'c4.m8', image: 'eval-harness-3', runtime: 'cloud-hypervisor', ttl: 1200, max: 3_600, warm: { min: 1, max: 4 }, network: 'none' as const },
  ].map((plan, index) => ({
    id: sid('sbt', `${seed}:tpl:${plan.name}`, 10),
    tenantId: ROOT_TENANT,
    name: plan.name,
    poolId: plan.pool,
    flavor: plan.flavor,
    imageId: sid('img', `${seed}:img:${plan.image}`, 10),
    runtime: plan.runtime,
    defaultTtlSeconds: plan.ttl,
    maxTtlSeconds: plan.max,
    warm: plan.warm,
    env: { AGENT_MODE: 'batch' },
    network: plan.network,
    volumes: [],
    version: 1 + index * 2,
  }));

  const sandboxHosts = nodes.filter((node) => node.poolKind === 'sandbox');
  const volumes = Array.from({ length: 36 }, (_, index) => {
    const key = `${seed}:vol:${index}`;
    const r = rng(hash(key));
    const node = choose(sandboxHosts, r());
    return {
      id: sid('vol', key, 12),
      tenantId: choose(CUSTOMER_TENANTS, r()),
      poolId: node.poolId!,
      name: `${choose(['agent-memory', 'pip-cache', 'datasets', 'scratch', 'model-weights', 'browser-profile'], r())}-${index}`,
      sizeGiB: choose([10, 20, 50, 100, 200, 500], r()),
      serial: `bcv-${sid('x', key, 16).slice(2)}`,
      ...(r() < 0.85 ? { nodeId: node.id } : {}),
      state: (r() < 0.94 ? 'ready' : 'deleting') as VolumeState,
    };
  });
  templates[0]!.volumes = [{ volumeId: volumes[0]!.id, mountPath: '/mnt/memory', readOnly: false }];
  return { seed, nodes, templates, volumes };
}

function structureFor(seed: string): Structure {
  let structure = structures.get(seed);
  if (!structure) {
    structure = buildStructure(seed);
    structures.set(seed, structure);
  }
  return structure;
}

// --- Health and bookings from poolPulse --------------------------------------------------------------------

/** Degraded nodes carry one of these, by pool kind (GPU faults only on GPU pools). */
const DEGRADED_GPU = ['Xid79', 'NvlinkDegraded', 'RowRemapPending', 'EccUncorrectable', 'Xid48', 'PcieReplayHigh', 'DiskPressure', 'ClockSkew', 'FabricManagerDown', 'DriverMismatch'];
const DEGRADED_HOST = ['MemoryPressure', 'DiskPressure', 'ClockSkew', 'CertExpiring', 'CpuPressure'];
/** Always-on low-grade noise across the fleet: a few nodes per slot, rolling every few hours. */
const BACKGROUND: { type: string; count: number }[] = [
  { type: 'CertExpiring', count: 3 },
  { type: 'RebootRequired', count: 4 },
];

function incidentMessage(type: string, node: FleetNode, r: number): string {
  const gpu = node.gpus.length ? Math.floor(r * node.gpus.length) : 0;
  switch (type) {
    case 'Xid79':
      return `GPU ${gpu} has fallen off the bus; drain and reboot`;
    case 'Xid48':
      return `GPU ${gpu}: double-bit ECC error; GPU quarantined`;
    case 'RowRemapPending':
      return `GPU ${gpu}: row remap pending; reset needed`;
    case 'EccUncorrectable':
      return `GPU ${gpu}: uncorrectable volatile ECC errors`;
    case 'NvlinkDegraded':
      return `GPU ${gpu}: NVLink ${Math.floor(r * 18)} down`;
    case 'PcieReplayHigh':
      return `GPU ${gpu}: PCIe replay counter ${Math.round(200 + r * 900)}/min`;
    case 'FabricManagerDown':
      return 'nvidia-fabricmanager is not running; NVSwitch fabric unavailable';
    case 'DiskPressure':
      return `/var/lib/bcd ${Math.round(88 + r * 10)}% full`;
    case 'MemoryPressure':
      return `${Math.round(90 + r * 8)}% of host memory committed to guests`;
    case 'CpuPressure':
      return `Run queue ${Math.round(2 + r * 3)}× vCPU count for 10 min`;
    case 'ClockSkew':
      return `Clock ${Math.round(2 + r * 8)} s off the gateway`;
    case 'CertExpiring':
      return `Node certificate expires in ${Math.round(2 + r * 20)} h; renewal pending`;
    case 'DriverMismatch':
      return `Driver 565.57.01; the pool expects ${DRIVER}`;
    case 'RebootRequired':
      return 'Kernel 6.8.0-51 installed; running 6.8.0-49';
    default:
      return describeCondition(type).label;
  }
}

const gpuFault = (type: string) => /^Xid|RowRemap|Ecc|Pcie|Nvlink/.test(type);

function applyOverlay(structure: Structure, now: number): FleetNode[] {
  const { seed } = structure;
  const out: FleetNode[] = [];
  const background = new Map<string, Condition[]>();
  for (const slot of BACKGROUND)
    for (let n = 0; n < slot.count; n++) {
      const slotKey = `${seed}:bg:${slot.type}:${n}`;
      const period = (3 + noise(slotKey) * 5) * HOUR;
      const phase = noise(`${slotKey}:phase`) * period;
      const generation = Math.floor((now + phase) / period);
      const node = choose(structure.nodes, noise(slotKey, generation));
      const list = background.get(node.id) ?? [];
      list.push({ type: slot.type, status: 'true', reason: describeCondition(slot.type).label, message: incidentMessage(slot.type, node, noise(slotKey, generation + 1)), since: generation * period - phase });
      background.set(node.id, list);
    }

  const t = now / (20 * 1000); // telemetry steps every 20 s
  const holders = gpuHolders(now);
  for (const pool of topologyPools) {
    const pulse = poolPulse(pool, now);
    const members = structure.nodes.filter((node) => node.poolId === pool.id);
    const faultBucket = Math.floor(now / (20 * MINUTE));
    // One health decision per node, shared with capacity and the Overview (fleet-health.ts).
    const info = new Map(members.map((node) => [node.id, nodeHealth(node.id, now, node.unit)!]));
    const site = topologySites.find((each) => each.id === pool.siteId)!;
    const metal = site.provider === 'metal';

    // Host pools: allocated vCPUs spread over live hosts in a stable order that drifts every 6 h. GPU pools read
    // capacity's per-GPU holders instead (below), so a GPU cell names the reservation /reservations shows.
    const perNode = pool.kind === 'gpu' ? pool.gpusPerNode : pool.vcpusPerNode;
    const bookedUnits = new Map<string, number>();
    if (pool.kind !== 'gpu') {
      const bookable = ranked(
        members.filter((node) => ['ready', 'degraded'].includes(info.get(node.id)!.health)),
        (node) => `${node.id}:book:${Math.floor(now / (6 * HOUR))}`,
      );
      let toBook = pulse.allocated;
      for (const node of bookable) {
        const take = Math.min(perNode, toBook);
        bookedUnits.set(node.id, take);
        toBook -= take;
        if (toBook <= 0) break;
      }
    }

    for (const base of members) {
      const r = rng(hash(`${base.id}:${faultBucket}`));
      const { health, hold, cordoned } = info.get(base.id)!;
      const conditions: Condition[] = [...(background.get(base.id) ?? [])];
      let connectivity: Connectivity = 'connected';
      let provisionState: ProvisionState = base.provisionState;
      let maintenance = false;
      let power: PowerState = 'on';
      const faultSince = faultBucket * 20 * MINUTE - Math.floor(r() * 30) * MINUTE;
      if (health === 'offline') {
        connectivity = choose(['unreachable', 'unreachable', 'disconnected', 'lost'] as const, r());
        conditions.push({ type: 'NodeUnreachable', status: 'true', reason: 'NoSession', message: 'No gateway session for longer than 40 s + grace', since: faultSince });
        if (connectivity === 'lost') power = 'unknown';
      } else if (health === 'degraded') {
        const type = choose(pool.kind === 'gpu' ? DEGRADED_GPU : DEGRADED_HOST, r());
        conditions.push({ type, status: 'true', reason: describeCondition(type).label, message: incidentMessage(type, base, r()), since: faultSince });
      } else if (health === 'provisioning') {
        if (metal) {
          provisionState = choose(['commissioning', 'deploying', 'inspecting', 'enrolling', 'commissioning', 'deploying'] as const, r());
          if (provisionState === 'enrolling' || provisionState === 'inspecting') connectivity = 'disconnected';
          if (provisionState === 'enrolling') power = 'off';
        } else provisionState = 'adopting';
      }
      // Held states last across fault buckets: failed and rescue park with maintenance on.
      if (hold === 'failed') {
        provisionState = 'failed';
        maintenance = true;
        conditions.push({ type: 'AcceptanceFailed', status: 'true', reason: 'DiagFailed', message: 'diag.nvml: dcgmi diag -r 2 reported 1 failure', since: now - (2 + noise(`${base.id}:af`) * 30) * HOUR });
      } else if (hold === 'rescue') {
        provisionState = 'rescue';
        maintenance = true;
      } else if (hold === 'retiring') provisionState = 'retiring';
      if (base.daemonVersion !== CURRENT_BCD)
        conditions.push({ type: 'DaemonOutdated', status: 'true', reason: `bcd ${base.daemonVersion}`, message: `Release ${CURRENT_BCD} is current`, since: now - 2 * DAY });

      const live = connectivity === 'connected' && (provisionState === 'deployed' || provisionState === 'adopted');
      const fault = conditions.find((condition) => gpuFault(condition.type));
      const badGpu = fault ? Number(/GPU (\d+)/.exec(fault.message ?? '')?.[1] ?? -1) : -1;
      const booked = live ? (bookedUnits.get(base.id) ?? 0) : 0;
      const gpus = base.gpus.map((gpu) => {
        const unhealthy = gpu.index === badGpu;
        const holder = unhealthy ? undefined : holders.get(`${base.id}/gpu${gpu.index}`);
        const isBooked = Boolean(holder);
        const utilization = !live || unhealthy ? 0 : isBooked ? Math.min(1, 0.52 + 0.48 * drift(`${gpu.id}:u`, now, 90_000)) : 0.01 * noise(`${gpu.id}:i`, Math.floor(t));
        const powerLimitW = gpuSpec[gpu.model]?.powerW ?? 400;
        const next: FleetGpu = {
          ...gpu,
          healthy: !unhealthy,
          bookable: !unhealthy,
          eccUncorrectable: unhealthy && fault?.type === 'EccUncorrectable' ? 2 + Math.floor(noise(gpu.id) * 6) : 0,
          ...(unhealthy && fault && /^Xid\d+$/.test(fault.type) ? { xid: { code: Number(fault.type.slice(3)), at: fault.since } } : {}),
          ...(holder ? { allocation: { reservationId: holder.reservationId, tenantId: holder.tenantId, since: holder.since } } : {}),
          ...(live
            ? {
                telemetry: {
                  utilization,
                  memoryUsed: isBooked ? 0.4 + 0.55 * drift(`${gpu.id}:m`, now, 10 * MINUTE) : 0.005,
                  temperatureC: Math.round(31 + utilization * 44 + drift(`${gpu.id}:temp`, now, 60_000) * 6),
                  powerW: Math.round(powerLimitW * (0.1 + utilization * 0.84)),
                  powerLimitW,
                },
              }
            : {}),
        };
        return next;
      });
      const noScheduleReasons = [
        ...(cordoned ? ['cordoned'] : []),
        ...(maintenance ? ['maintenance'] : []),
        ...conditions.filter((condition) => describeCondition(condition.type).severity === 'critical').map((condition) => condition.type),
        ...(noise(`${base.id}:taint`) < 0.015 ? ['taint:maintenance-window'] : []),
      ];
      const hostShare = pool.kind === 'gpu' ? 0 : booked / perNode;
      const lastSeen = connectivity === 'connected' ? now - Math.floor(noise(base.id, Math.floor(now / 5000)) * 5_000) : faultSince;
      out.push({
        ...base,
        provisionState,
        maintenance,
        cordoned,
        connectivity,
        power,
        health,
        conditions,
        noScheduleReasons,
        observedGeneration: noise(`${base.id}:lag`, Math.floor(now / (10 * MINUTE))) < 0.03 ? base.generation - 1 : base.generation,
        gpus,
        cpu: { ...base.cpu, ...(live ? { utilization: pool.kind === 'gpu' ? 0.06 + 0.3 * drift(`${base.id}:cpu`, now, 2 * MINUTE) : Math.min(0.98, hostShare * (0.55 + 0.4 * drift(`${base.id}:cpu`, now, 2 * MINUTE))) } : {}) },
        ...(live ? { memoryUtilization: pool.kind === 'gpu' ? 0.2 + 0.5 * drift(`${base.id}:mem`, now, 20 * MINUTE) : Math.min(0.97, 0.1 + hostShare * 0.85) } : {}),
        session:
          connectivity === 'connected'
            ? { epoch: 1 + Math.floor(noise(`${base.id}:ep`) * 30), gatewayId: `gw-${pool.siteId}-${1 + Math.floor(noise(`${base.id}:gw`) * 3)}`, connectedAt: now - (1 + noise(`${base.id}:ca`) * 300) * HOUR, lastSeen }
            : { epoch: 1 + Math.floor(noise(`${base.id}:ep`) * 30), disconnectedAt: lastSeen, lastSeen },
      });
    }
  }
  return out;
}

// --- Workloads: instances and a rolling sandbox population ----------------------------------------------

function simulateInstances(structure: Structure, nodes: FleetNode[], now: number): Instance[] {
  const hosts = nodes.filter((node) => node.poolKind === 'cpu');
  const states: InstanceState[] = ['running', 'running', 'running', 'running', 'running', 'running', 'stopped', 'running', 'provisioning', 'starting', 'error', 'running'];
  return Array.from({ length: 220 }, (_, index) => {
    const key = `${structure.seed}:inst:${index}`;
    const r = rng(hash(key));
    const host = choose(hosts, r());
    const tenantId = choose(CUSTOMER_TENANTS, r());
    let state = choose(states, r());
    // Short-lived states resolve: a provisioning instance is running a few minutes later.
    if ((state === 'provisioning' || state === 'starting') && drift(`${key}:boot`, now, 4 * MINUTE) > 0.5) state = 'running';
    if (host.connectivity === 'lost' || host.connectivity === 'unreachable') state = 'lost';
    return {
      id: sid('inst', key, 14),
      tenantId,
      poolId: host.poolId!,
      projectId: sid('prj', `${tenantId}:p${Math.floor(r() * 3)}`, 8),
      flavor: choose(['c2.m4', 'c4.m8', 'c8.m16', 'c16.m64', 'c32.m128'], r()),
      imageId: sid('img', `${structure.seed}:img:${choose(['ubuntu-24.04', 'debian-13', 'rocky-10', 'talos-1.11'], r())}`, 10),
      sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5…'],
      state,
      desiredState: state === 'stopped' ? 'stopped' : 'running',
      nodeId: host.id,
      allocationId: sid('alc', key, 12),
      addresses: [`10.${40 + Math.floor(r() * 8)}.${Math.floor(r() * 250)}.${2 + Math.floor(r() * 250)}`],
      ownerIdentityId: sid('idn', `${tenantId}:owner:${Math.floor(r() * 6)}`, 10),
      idempotencyKey: `inst-${index}`,
      conditions:
        state === 'error'
          ? [{ type: 'RuntimeError', status: 'true', reason: 'VmmExited', message: 'libvirt: domain exited with status 1 (tap device busy)', since: now - 25 * MINUTE }]
          : state === 'lost'
            ? [{ type: 'NodeUnreachable', status: 'true', reason: 'HostLost', message: `Host ${host.hostname} is ${host.connectivity}`, since: now - 12 * MINUTE }]
            : [],
      version: 1 + Math.floor(r() * 30),
    };
  });
}

const SANDBOX_SLOTS = 180;
function simulateSandboxes(structure: Structure, nodes: FleetNode[], now: number) {
  const sandboxes: Sandbox[] = [];
  const snapshots: SandboxSnapshot[] = [];
  const hostsByPool = new Map<string, FleetNode[]>();
  for (const node of nodes) {
    if (node.connectivity !== 'connected') continue;
    const list = hostsByPool.get(node.poolId!) ?? [];
    list.push(node);
    hostsByPool.set(node.poolId!, list);
  }
  for (let slot = 0; slot < SANDBOX_SLOTS; slot++) {
    const slotKey = `${structure.seed}:sbx:${slot}`;
    const template = structure.templates[Math.floor(noise(`${slotKey}:tpl`) ** 1.6 * structure.templates.length)]!;
    const ttl = template.defaultTtlSeconds * (0.5 + noise(`${slotKey}:ttl`));
    const period = ttl * 1000 * 1.15; // lives ~ttl, then the slot is re-used after a gap
    const phase = noise(`${slotKey}:phase`) * period;
    const generation = Math.floor((now + phase) / period);
    const createdAt = generation * period - phase;
    const age = now - createdAt;
    const key = `${slotKey}:${generation}`;
    const r = rng(hash(key));
    const warm = r() < 0.7;
    const bootMs = warm ? 400 + r() * 900 : 9_000 + r() * 20_000;
    const expiresAt = createdAt + ttl * 1000;
    const failed = r() < 0.025;
    let state: SandboxState = age < bootMs ? 'starting' : failed ? 'failed' : 'ready';
    if (now > expiresAt) state = now < expiresAt + 20_000 ? 'deleting' : 'deleted';
    if (state === 'deleted') continue;
    const hosts = hostsByPool.get(template.poolId) ?? [];
    const host = hosts.length ? choose(hosts, r()) : undefined;
    const tenantId = choose(CUSTOMER_TENANTS, r());
    const id = sid('sbx', key, 14);
    const sandbox: Sandbox = {
      id,
      tenantId,
      templateId: template.id,
      poolId: template.poolId,
      instanceId: sid('inst', `${key}:inst`, 14),
      state,
      instanceState: state === 'starting' ? (warm ? 'paused' : 'starting') : state === 'ready' ? 'running' : state === 'failed' ? 'error' : 'deleting',
      addresses: [`10.64.${Math.floor(r() * 250)}.${2 + Math.floor(r() * 250)}`],
      ...(host ? { nodeId: host.id } : {}),
      ttlSeconds: Math.round(ttl),
      expiresAt,
      warm,
      ownerIdentityId: sid('agt', `${tenantId}:agent:${Math.floor(r() * 12)}`, 10),
      idempotencyKey: `sbx-${slot}-${generation}`,
      createdAt,
      ...(state !== 'starting' && !failed ? { readyAt: createdAt + bootMs } : {}),
    };
    if (r() < 0.14) {
      const snapshotAt = createdAt + (age * r()) / 2;
      const ready = now - snapshotAt > 8_000;
      const snapshot: SandboxSnapshot = {
        id: sid('snap', key, 12),
        tenantId,
        sandboxId: id,
        templateId: template.id,
        state: ready ? 'ready' : 'pending',
        includeMemory: r() < 0.5,
        keep: r() < 0.3,
        runtime: template.runtime,
        sizeBytes: Math.round((0.4 + r() * 6) * 1024 ** 3),
        cpuModel: 'EPYC 9474F',
        ownerIdentityId: sandbox.ownerIdentityId,
        createdAt: snapshotAt,
        ...(ready ? { readyAt: snapshotAt + 8_000 } : {}),
      };
      snapshots.push(snapshot);
      sandbox.snapshots = [snapshot];
    }
    sandboxes.push(sandbox);
  }
  return { sandboxes, snapshots };
}

// --- Rollouts, batches, drift, discovery, workflows ------------------------------------------------------

const countStates = (list: readonly RolloutNode[]) => {
  const out = Object.fromEntries(rolloutNodeStates.map((state) => [state, 0])) as Record<RolloutNodeState, number>;
  for (const node of list) out[node.state] += 1;
  return out;
};

function simulateRollouts(structure: Structure, nodes: FleetNode[], now: number): FleetSnapshot['rollouts'] {
  const waves = [1, 5, 25, 100];
  const soak = 10 * MINUTE;
  // The running rollout loops every 3 h so the demo always shows one in flight.
  const cycle = 3 * HOUR;
  const cycleNo = Math.floor(now / cycle);
  const started = cycleNo * cycle - 20 * MINUTE;
  const elapsed = now - started;
  const eligible = nodes.filter((node) => node.connectivity !== 'lost' && node.provisionState !== 'retiring');
  const order = ranked(eligible, (node) => `${node.id}:rollout`);
  const waveOf = (index: number) => waves.findIndex((pct) => index < Math.ceil((pct / 100) * order.length));
  const waveLength = 25 * MINUTE;
  const wave = Math.min(waves.length - 1, Math.floor(elapsed / waveLength));
  const paused = noise(`${structure.seed}:ro:pause`, cycleNo) < 0.3 && wave === 2;
  const nodeList: RolloutNode[] = order.map((node, index) => {
    const nodeWave = waveOf(index);
    const nodeStart = started + nodeWave * waveLength + noise(`${node.id}:rs`) * (waveLength - soak) * 0.8;
    const took = (2 + noise(`${node.id}:rt`) * 4) * MINUTE;
    const fails = noise(`${node.id}:rf`, cycleNo) < 0.012;
    let state: RolloutNodeState = 'pending';
    if (nodeWave < wave || (nodeWave === wave && now >= nodeStart)) {
      state = now >= nodeStart + took ? (fails ? 'failed' : 'succeeded') : 'upgrading';
      if (paused && nodeWave === wave && state === 'upgrading') state = 'pending';
    }
    if (node.connectivity !== 'connected' && state === 'pending') state = 'skipped';
    return {
      nodeId: node.id,
      poolId: node.poolId!,
      wave: nodeWave,
      state,
      fromVersion: node.daemonVersion,
      ...(state !== 'pending' && state !== 'skipped' ? { startedAt: nodeStart } : {}),
      ...(state === 'succeeded' || state === 'failed' ? { finishedAt: nodeStart + took } : {}),
      ...(state === 'failed' ? { error: 'health gate: bcd did not send Hello within 300 s of the swap' } : {}),
    };
  });
  const running = {
    id: sid('rol', `${structure.seed}:ro:${cycleNo}`, 10),
    tenantId: ROOT_TENANT,
    version: '1.4.3',
    state: (paused ? 'paused' : 'running') as RolloutState,
    waves,
    maxFailureRatio: 0.02,
    soakSeconds: soak / 1000,
    upgradeTimeoutSeconds: 300,
    wave,
    waveStartedAt: started + wave * waveLength,
    rollback: false,
    ...(paused ? { reason: 'Paused by operator: watching XID rate on H200 inference' } : {}),
    createdBy: 'ops@legionedge.ai',
    createdAt: started,
    updatedAt: now,
    nodes: countStates(nodeList),
    nodeList,
  };
  const history = (version: string, state: RolloutState, ageDays: number, reason?: string) => {
    const list = order.map<RolloutNode>((node, index) => ({
      nodeId: node.id,
      poolId: node.poolId!,
      wave: waveOf(index),
      state: state === 'aborted' ? (waveOf(index) <= 1 ? (noise(`${node.id}:${version}`) < 0.2 ? 'rolled-back' : 'succeeded') : 'pending') : 'succeeded',
      fromVersion: '1.3.9',
    }));
    return {
      id: sid('rol', `${structure.seed}:ro:${version}`, 10),
      tenantId: ROOT_TENANT,
      version,
      state,
      waves,
      maxFailureRatio: 0.02,
      soakSeconds: 600,
      upgradeTimeoutSeconds: 300,
      wave: state === 'aborted' ? 1 : 3,
      waveStartedAt: now - ageDays * DAY,
      waveDoneAt: now - ageDays * DAY + 2 * HOUR,
      rollback: state === 'aborted',
      ...(reason ? { reason } : {}),
      createdBy: 'ops@legionedge.ai',
      createdAt: now - ageDays * DAY - 2 * HOUR,
      updatedAt: now - ageDays * DAY,
      nodes: countStates(list),
      nodeList: list,
    };
  };
  return [
    running,
    history('1.4.2', 'completed', 2),
    history('1.4.2-rc.1', 'aborted', 4, 'Failure ratio 3.1% over the 2% gate in wave 2 (cgroup v1 hosts)'),
    history('1.4.1', 'completed', 9),
  ];
}

const APPROVERS = ['ana', 'kai', 'lee', 'max'];

function simulateBatches(structure: Structure, nodes: FleetNode[], now: number): FleetSnapshot['batches'] {
  const metal = nodes.filter((node) => node.bmc);
  const bucket = Math.floor(now / (6 * HOUR));
  const make = (index: number, reason: string, kind: string, state: BatchState, approvals: number, required: number, createdAgo: number, size: number, agent?: string) => {
    const key = `${structure.seed}:batch:${index}:${bucket}`;
    const createdAt = bucket * 6 * HOUR + (now - bucket * 6 * HOUR > createdAgo ? now - bucket * 6 * HOUR - createdAgo : 0);
    const members: BatchMember[] = Array.from({ length: size }, (_, i) => {
      const node = choose(metal, noise(`${key}:${i}`));
      return {
        commandId: sid('cmd', `${key}:${i}`, 12),
        nodeId: node.id,
        subject: `bmc:site-agent-${node.siteId}/${node.bmc!.address}`,
        kind,
        state: state === 'approved' ? (i < size - 1 ? 'succeeded' : 'running') : state === 'pending' ? 'queued' : 'cancelled',
        ...(state === 'pending' ? { awaitingApproval: true as const } : {}),
      };
    });
    const commands: Record<string, number> = {};
    for (const member of members) commands[member.state] = (commands[member.state] ?? 0) + 1;
    return {
      batchId: sid('bat', key, 12),
      tenantId: ROOT_TENANT,
      reason,
      state,
      scopeRoot: `sha256:${sid('x', `${key}:root`, 40).slice(2)}`,
      trustDomain: 'compute.legionedge.ai',
      scopeSize: size,
      requiredApprovals: required,
      notAfter: createdAt + 4 * HOUR,
      approvals: Array.from({ length: approvals }, (_, i) => ({ kid: `approver-${APPROVERS[i]}`, at: createdAt + (i + 1) * 6 * MINUTE, approvedBy: `${APPROVERS[i]}@legionedge.ai` })),
      commands,
      createdAt,
      ...(state === 'approved' ? { approvedAt: createdAt + approvals * 6 * MINUTE } : {}),
      ...(agent ? { createdByAgent: agent, delegationId: sid('dlg', key, 10) } : { createdBy: 'ops@legionedge.ai' }),
      members,
    };
  };
  return [
    make(0, 'Power-cycle FRA1-R03 after the PDU firmware update', 'metal.power', 'pending', 1, 2, 18 * MINUTE, 8),
    make(1, 'Reflash BMC firmware 1.12.4 on Ashburn H200 hosts', 'bmc.firmware', 'pending', 0, 2, 5 * MINUTE, 32, 'agent:fleet-remediator'),
    make(2, 'Secure-erase released A100 nodes before retirement', 'metal.wipe', 'approved', 2, 2, 3 * HOUR, 6),
    make(3, 'Rotate BMC credentials, Amsterdam 2', 'bmc.rotate', 'expired', 1, 2, 5 * HOUR, 24),
  ];
}

function simulateDrift(structure: Structure, now: number): FleetStatus {
  const drifted = drift(`${structure.seed}:drift`, now, 2 * HOUR) > 0.35;
  const changes: FleetChange[] = drifted
    ? [
        { kind: 'pool', name: 'H200 inference', action: 'update', fields: ['policy.prewarmImages', 'policy.lostAfter'] },
        { kind: 'flavor', name: 'g2.h200x2', action: 'create' },
        { kind: 'sandboxTemplate', name: 'browser-agent', action: 'update', fields: ['warm.max'] },
        { kind: 'offer', name: 'L40S render → Meridian Bio', action: 'delete', blocked: '3 active reservations hold this offer', note: 'prune is off' },
        { kind: 'ownerQuota', name: 'Kestrel AI / gpu.B200', action: 'update', fields: ['max'] },
      ]
    : [];
  const summary: Record<FleetChange['action'], number> = { create: 0, update: 0, delete: 0, unchanged: 42 };
  for (const change of changes) summary[change.action] += 1;
  return {
    tenantId: ROOT_TENANT,
    applied: {
      planHash: `sha256:${sid('x', `${structure.seed}:plan`, 24).slice(2)}`,
      appliedBy: 'ci@legionedge.ai',
      appliedAt: now - 26 * HOUR,
      prune: false,
      checkedAt: now - Math.floor(noise('drift-check', Math.floor(now / MINUTE)) * 50_000),
    },
    ...(drifted
      ? { drift: { changes, summary, blocked: changes.some((change) => change.blocked), planHash: `sha256:${sid('x', `${structure.seed}:plan2`, 24).slice(2)}` } }
      : {}),
  };
}

function simulateDiscovered(structure: Structure, nodes: FleetNode[], now: number): DiscoveredMachine[] {
  const metalSites = topologySites.filter((site) => site.provider === 'metal');
  const enrolling = nodes.filter((node) => node.provisionState === 'enrolling');
  return Array.from({ length: 7 }, (_, index) => {
    const key = `${structure.seed}:pxe:${index}`;
    const r = rng(hash(key));
    const mac = Array.from({ length: 6 }, (_, i) => (i === 0 ? 0x3c : Math.floor(r() * 256)).toString(16).padStart(2, '0')).join(':');
    const firstSeen = now - (10 + r() * 600) * MINUTE;
    const candidate = enrolling[index];
    const site = candidate ? topologySites.find((each) => each.id === candidate.siteId)! : choose(metalSites, r());
    return {
      siteId: site.id,
      mac,
      productUuid: `${sid('x', `${key}:u1`, 8).slice(2)}-4a1c-9f2e-${sid('x', `${key}:u2`, 12).slice(2)}`,
      arch: 'x86_64',
      firstSeen: new Date(firstSeen).toISOString(),
      lastSeen: new Date(now - r() * 90_000).toISOString(),
      count: 2 + Math.floor(r() * 40),
      relays: [`10.${20 + topologySites.indexOf(site)}.${index}.1`],
      agentNodeIds: [`site-agent-${site.id}`],
      ...(candidate ? { candidateFor: candidate.id } : {}),
    };
  });
}

type StepPlan = [action: string, driver: string | undefined, runsOn: WorkflowView['steps'][number]['runsOn']];
const PROFILES: Record<string, { profile: string; steps: StepPlan[] }> = {
  commissioning: { profile: 'commission-gpu', steps: [['bmc.boot', 'redfish', 'site'], ['ramdisk.boot', 'ipxe', 'ramdisk'], ['disk.wipe', 'bcd', 'ramdisk'], ['firmware.check', 'bcd', 'ramdisk'], ['diag.nvml', 'dcgm', 'ramdisk'], ['burn-in', 'dcgm', 'ramdisk']] },
  deploying: { profile: 'deploy-ubuntu-24.04', steps: [['bmc.boot', 'redfish', 'site'], ['image.write', 'bcd', 'ramdisk'], ['cloud-init.seed', 'bcd', 'ramdisk'], ['reboot', 'redfish', 'site'], ['join', 'bcd', 'node'], ['host.units', 'bcd', 'node']] },
  inspecting: { profile: 'inspect', steps: [['bmc.boot', 'redfish', 'site'], ['ramdisk.boot', 'ipxe', 'ramdisk'], ['inventory.collect', 'bcd', 'ramdisk']] },
  failed: { profile: 'commission-gpu', steps: [['bmc.boot', 'redfish', 'site'], ['ramdisk.boot', 'ipxe', 'ramdisk'], ['disk.wipe', 'bcd', 'ramdisk'], ['diag.nvml', 'dcgm', 'ramdisk']] },
  enrolling: { profile: 'enroll', steps: [['bmc.verify', 'redfish', 'site'], ['inspect.macs', 'redfish', 'site']] },
  retiring: { profile: 'retire', steps: [['drain', undefined, 'control-plane'], ['disk.wipe', 'bcd', 'ramdisk'], ['bmc.power-off', 'redfish', 'site']] },
  adopting: { profile: 'adopt', steps: [['acceptance.diag', 'bcd', 'node'], ['host.units', 'bcd', 'node']] },
};

function simulateWorkflows(nodes: FleetNode[], now: number): WorkflowView[] {
  return nodes
    .filter((node) => PROFILES[node.provisionState])
    .map((node) => {
      const plan = PROFILES[node.provisionState]!;
      const key = `${node.id}:wf:${node.provisionState}`;
      const createdAt = now - (5 + noise(key, Math.floor(now / HOUR)) * 50) * MINUTE;
      const failed = node.provisionState === 'failed';
      const stepMs = 60 * MINUTE / plan.steps.length;
      const progress = failed ? plan.steps.length - 1 : Math.min(plan.steps.length - 1, Math.floor((now - createdAt) / stepMs));
      const steps = plan.steps.map(([action, driver, runsOn], index) => ({
        id: `s${index}`,
        index,
        action,
        ...(driver ? { driver } : {}),
        runsOn,
        state: (index < progress ? 'succeeded' : index === progress ? (failed ? 'failed' : action === 'reboot' || action === 'join' ? 'waiting' : 'running') : 'pending') as StepState,
        attempt: index === progress && failed ? 3 : 1,
        phase: 'main' as const,
        ...(index <= progress ? { startedAt: createdAt + index * stepMs } : {}),
        ...(index < progress ? { finishedAt: createdAt + (index + 1) * stepMs - 20_000 } : {}),
      }));
      return {
        id: sid('wf', key, 12),
        tenantId: ROOT_TENANT,
        nodeId: node.id,
        profileId: plan.profile,
        profileVersion: 3,
        state: (failed ? 'failed' : 'running') as WorkflowState,
        stepId: `s${progress}`,
        version: progress + 1,
        ...(failed ? { outcome: 'failed' as const, finishedAt: createdAt + progress * stepMs } : {}),
        createdAt,
        steps,
      };
    });
}

// --- Entry points -------------------------------------------------------------------------------------

export const DEFAULT_FLEET_SEED = 'better-compute';

const snapshotCache = new Map<string, FleetSnapshot>();

/** The whole simulated fleet at `now`. Deterministic in (now, seed); the last few results are memoized. */
export function simulateFleet(now: number, seed: string = DEFAULT_FLEET_SEED): FleetSnapshot {
  const cacheKey = `${seed}@${now}`;
  const cached = snapshotCache.get(cacheKey);
  if (cached) return cached;
  const structure = structureFor(seed);
  const nodes = applyOverlay(structure, now);
  const instances = simulateInstances(structure, nodes, now);
  const { sandboxes, snapshots } = simulateSandboxes(structure, nodes, now);
  const instancesByNode = new Map<string, number>();
  for (const instance of instances)
    if (instance.nodeId && instance.state !== 'deleted') instancesByNode.set(instance.nodeId, (instancesByNode.get(instance.nodeId) ?? 0) + 1);
  const sandboxesByNode = new Map<string, number>();
  for (const sandbox of sandboxes) if (sandbox.nodeId) sandboxesByNode.set(sandbox.nodeId, (sandboxesByNode.get(sandbox.nodeId) ?? 0) + 1);
  for (const node of nodes) {
    node.instanceCount = instancesByNode.get(node.id) ?? 0;
    node.sandboxCount = sandboxesByNode.get(node.id) ?? 0;
  }
  const snapshot: FleetSnapshot = {
    seed,
    now,
    simulated: true,
    tenantId: ROOT_TENANT,
    sites: topologySites,
    pools: topologyPools,
    nodes,
    instances,
    sandboxes,
    templates: structure.templates,
    volumes: structure.volumes.map((volume, index) => ({ ...volume, createdAt: now - (1 + index * 7) * HOUR })),
    snapshots,
    rollouts: simulateRollouts(structure, nodes, now),
    batches: simulateBatches(structure, nodes, now),
    drift: simulateDrift(structure, now),
    discovered: simulateDiscovered(structure, nodes, now),
    workflows: simulateWorkflows(nodes, now),
    incidents: fleetIncidents(nodes),
  };
  snapshotCache.set(cacheKey, snapshot);
  if (snapshotCache.size > 4) snapshotCache.delete(snapshotCache.keys().next().value!);
  return snapshot;
}

/** The part of a snapshot in one site (the workspace's site scope); unscoped returns it as is. */
export function scopeFleet(snapshot: FleetSnapshot, siteId?: string): FleetSnapshot {
  if (!siteId) return snapshot;
  const nodeIds = new Set(snapshot.nodes.filter((node) => node.siteId === siteId).map((node) => node.id));
  const poolIds = new Set(snapshot.pools.filter((pool) => pool.siteId === siteId).map((pool) => pool.id));
  return {
    ...snapshot,
    sites: snapshot.sites.filter((site) => site.id === siteId),
    pools: snapshot.pools.filter((pool) => poolIds.has(pool.id)),
    nodes: snapshot.nodes.filter((node) => nodeIds.has(node.id)),
    instances: snapshot.instances.filter((instance) => poolIds.has(instance.poolId)),
    sandboxes: snapshot.sandboxes.filter((sandbox) => poolIds.has(sandbox.poolId)),
    templates: snapshot.templates.filter((template) => poolIds.has(template.poolId)),
    volumes: snapshot.volumes.filter((volume) => poolIds.has(volume.poolId)),
    rollouts: snapshot.rollouts.map((rollout) => {
      const nodeList = rollout.nodeList.filter((node) => nodeIds.has(node.nodeId));
      return { ...rollout, nodeList, nodes: countStates(nodeList) };
    }),
    batches: snapshot.batches.filter((batch) => batch.members.some((member) => nodeIds.has(member.nodeId))),
    discovered: snapshot.discovered.filter((machine) => machine.siteId === siteId),
    workflows: snapshot.workflows.filter((workflow) => workflow.nodeId && nodeIds.has(workflow.nodeId)),
    incidents: snapshot.incidents.filter((incident) => incident.siteId === siteId),
  };
}

/** A GPU's utilization over the last `points` samples `stepMs` apart, oldest first (for sparklines). */
export function gpuUtilizationSeries(gpu: FleetGpu, now: number, points = 60, stepMs = 20_000): number[] {
  if (!gpu.allocation) return Array.from({ length: points }, (_, i) => 0.01 * noise(`${gpu.id}:i`, Math.floor((now - (points - 1 - i) * stepMs) / 20_000)));
  return Array.from({ length: points }, (_, i) => Math.min(1, 0.52 + 0.48 * drift(`${gpu.id}:u`, now - (points - 1 - i) * stepMs, 90_000)));
}

// --- The event stream -------------------------------------------------------------------------------

/** Mean gap between simulated events (they arrive with jitter). */
const EVENT_GAP_MS = 1_400;

type EventSubject = 'node' | 'sandbox' | 'instance' | 'reservation' | 'workflow' | 'security' | 'rollout' | 'batch';
const EVENT_KINDS: { type: string; weight: number; subject: EventSubject; data?: (r: number) => Record<string, unknown> }[] = [
  { type: 'node.status', weight: 14, subject: 'node', data: (r) => ({ observedGeneration: 10 + Math.floor(r * 30) }) },
  { type: 'sandbox.created', weight: 9, subject: 'sandbox', data: (r) => ({ warm: r < 0.7 }) },
  { type: 'sandbox.ready', weight: 9, subject: 'sandbox', data: (r) => ({ bootMs: Math.round(r < 0.7 ? 400 + r * 900 : 9000 + r * 20000) }) },
  { type: 'sandbox.deleted', weight: 7, subject: 'sandbox', data: () => ({ reason: 'ttl' }) },
  { type: 'sandbox.exec.issued', weight: 6, subject: 'sandbox' },
  { type: 'reservation.placed', weight: 5, subject: 'reservation', data: (r) => ({ gpus: [1, 2, 4, 8, 16][Math.floor(r * 5)] }) },
  { type: 'reservation.active', weight: 4, subject: 'reservation' },
  { type: 'reservation.released', weight: 3, subject: 'reservation' },
  { type: 'instance.running', weight: 4, subject: 'instance' },
  { type: 'instance.stopping', weight: 1, subject: 'instance' },
  { type: 'workflow.step.succeeded', weight: 4, subject: 'workflow', data: (r) => ({ action: ['disk.wipe', 'diag.nvml', 'image.write', 'bmc.boot'][Math.floor(r * 4)] }) },
  { type: 'workflow.step.failed', weight: 0.5, subject: 'workflow', data: () => ({ action: 'diag.nvml', attempt: 2 }) },
  { type: 'node.condition.changed', weight: 1.5, subject: 'node', data: (r) => ({ condition: ['NvlinkDegraded', 'DiskPressure', 'ClockSkew', 'Xid79', 'RowRemapPending'][Math.floor(r * 5)], status: r < 0.6 ? 'true' : 'false' }) },
  { type: 'node.connected', weight: 1, subject: 'node' },
  { type: 'node.disconnected', weight: 0.6, subject: 'node', data: () => ({ reason: 'session closed' }) },
  { type: 'node.command.queued', weight: 3, subject: 'node', data: (r) => ({ kind: ['instance.apply', 'devices.apply', 'host.unit', 'bmc.power'][Math.floor(r * 4)] }) },
  { type: 'command.settled', weight: 3, subject: 'node', data: (r) => ({ outcome: r < 0.97 ? 'succeeded' : 'failed' }) },
  { type: 'rollout.wave', weight: 0.2, subject: 'rollout' },
  { type: 'command.batch.approved', weight: 0.1, subject: 'batch' },
  { type: 'security.join.refused', weight: 0.25, subject: 'security', data: () => ({ reason: 'token-expired' }) },
  { type: 'security.certificate-revoked', weight: 0.1, subject: 'node' },
  { type: 'node.ssh-cert.issued', weight: 0.8, subject: 'node', data: () => ({ principal: 'root', ttl: '15m' }) },
  { type: 'node.remediation.started', weight: 0.4, subject: 'node', data: () => ({ action: 'drain-reboot' }) },
];
const EVENT_WEIGHT = EVENT_KINDS.reduce((sum, kind) => sum + kind.weight, 0);

/**
 * The simulated outbox between `from` (exclusive) and `to` (inclusive), oldest first, at most `limit` (the
 * newest). Event i exists at a fixed time, so windows re-read the same events: poll
 * `eventsBetween(snapshot, lastSeen, now)` and nothing arrives twice.
 */
export function eventsBetween(snapshot: FleetSnapshot, from: number, to: number, limit = 500): ComputeEvent[] {
  const first = Math.max(Math.floor(from / EVENT_GAP_MS), Math.floor(to / EVENT_GAP_MS) - limit);
  const events: ComputeEvent[] = [];
  const nodes = snapshot.nodes.length ? snapshot.nodes : structureFor(snapshot.seed).nodes;
  for (let slot = first; slot <= Math.floor(to / EVENT_GAP_MS); slot++) {
    const key = `${snapshot.seed}:evt:${slot}`;
    const r = rng(hash(key));
    const at = slot * EVENT_GAP_MS + Math.floor(r() * EVENT_GAP_MS);
    if (at <= from || at > to) continue;
    let roll = r() * EVENT_WEIGHT;
    const kind = EVENT_KINDS.find((each) => (roll -= each.weight) < 0) ?? EVENT_KINDS[0]!;
    const node = choose(nodes, r());
    const system = kind.subject === 'node' || kind.subject === 'rollout' || kind.subject === 'workflow' || kind.subject === 'batch' || kind.subject === 'security';
    const tenantId = system ? ROOT_TENANT : choose(CUSTOMER_TENANTS, r());
    const subject =
      kind.subject === 'node' || kind.subject === 'security'
        ? `node/${node.id}`
        : kind.subject === 'sandbox'
          ? `sandbox/${sid('sbx', `${key}:s`, 14)}`
          : kind.subject === 'instance'
            ? `instance/${sid('inst', `${key}:i`, 14)}`
            : kind.subject === 'reservation'
              ? `reservation/${sid('rsv', `${key}:r`, 12)}`
              : kind.subject === 'workflow'
                ? `workflow/${sid('wf', `${key}:w`, 12)}`
                : kind.subject === 'batch'
                  ? `commandBatch/${snapshot.batches[0]?.batchId ?? 'bat'}`
                  : `rollout/${snapshot.rollouts[0]?.id ?? 'rol'}`;
    events.push({
      id: sid('evt', key, 16),
      type: kind.type,
      tenantId,
      subject,
      time: new Date(at).toISOString(),
      sequence: String(slot),
      data: { ...(kind.data?.(r()) ?? {}), ...(kind.subject === 'node' || kind.subject === 'security' ? { hostname: node.hostname, siteId: node.siteId } : {}) },
    });
  }
  return events.slice(-limit);
}

/** Fleet-wide totals the overview widgets and page headers show. */
export function fleetTotals(snapshot: FleetSnapshot) {
  const nodes = snapshot.nodes;
  const gpus = nodes.flatMap((node) => node.gpus);
  const connectivity = Object.fromEntries(connectivityStates.map((state) => [state, 0])) as Record<Connectivity, number>;
  const health: Record<NodeHealth, number> = { ready: 0, degraded: 0, offline: 0, provisioning: 0 };
  for (const node of nodes) {
    connectivity[node.connectivity] += 1;
    health[node.health] += 1;
  }
  const withTelemetry = gpus.filter((gpu) => gpu.telemetry);
  return {
    nodes: nodes.length,
    health,
    schedulable: nodes.filter(isSchedulable).length,
    cordoned: nodes.filter((node) => node.cordoned).length,
    connectivity,
    gpus: gpus.length,
    gpusHealthy: gpus.filter((gpu) => gpu.healthy).length,
    gpusAllocated: gpus.filter((gpu) => gpu.allocation).length,
    gpuUtilization: withTelemetry.length ? withTelemetry.reduce((sum, gpu) => sum + gpu.telemetry!.utilization, 0) / withTelemetry.length : 0,
    gpuPowerKw: withTelemetry.reduce((sum, gpu) => sum + gpu.telemetry!.powerW, 0) / 1000,
    incidents: {
      critical: snapshot.incidents.filter((incident) => incident.severity === 'critical').length,
      warning: snapshot.incidents.filter((incident) => incident.severity === 'warning').length,
    },
    sandboxes: {
      ready: snapshot.sandboxes.filter((sandbox) => sandbox.state === 'ready').length,
      starting: snapshot.sandboxes.filter((sandbox) => sandbox.state === 'starting').length,
    },
    instances: {
      running: snapshot.instances.filter((instance) => instance.state === 'running').length,
      total: snapshot.instances.length,
    },
  };
}
