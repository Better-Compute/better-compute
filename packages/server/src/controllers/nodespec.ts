import { createHash } from 'node:crypto';
import {
  schedulableProvisionStates,
  type ComputeModule,
  type Condition,
  type DeviceAssignment,
  type InstanceSpec,
  type Json,
  type Label,
  type ModuleContext,
  type NodeRecord,
  type NodeSpec,
  type ProvisionState,
  type SqlTx,
} from '@better-compute/core';
import { toMs } from './node-state.js';

// NodeSpec (PLAN.md §7.3, §8.4): a node's desired state is the base sections plus every registered
// module's `nodeSpec()` contribution. It is stored in `nodes.spec` as protobuf JSON of
// `bettercompute.agent.v1.NodeSpec` (what the gateway sends in `DesiredState`), and
// `nodes.generation` moves only when the canonical spec changes. Desired state applies once a node
// is adopted or deployed (generation 1 is written on adoption, §3.3 step 7) and keeps being
// maintained from then on, whatever the provision state.

type JsonObject = { [key: string]: Json };

/** SHA-256 hex of a value's canonical JSON (sorted keys, no whitespace). */
export function specHash(spec: Json): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

/** RFC 8785-style canonical JSON for comparison: object keys sorted, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

interface RecordRow {
  node: Record<string, unknown>;
  conditions: { type: string; status: Condition['status']; reason: string | null; since: string }[];
  labels: Label[];
}

/** A stored node as module hooks receive it (`NodeRecord`), optionally locking the row. */
export async function loadNodeRecord(
  tx: SqlTx,
  nodeId: string,
  options: { lock?: boolean } = {},
): Promise<{ record: NodeRecord; spec: Json | null } | undefined> {
  // to_jsonb keeps this independent of the columns later migrations add (power, adapter, …).
  const { rows } = await tx.query<RecordRow>(
    `SELECT to_jsonb(n) AS node,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('type', c.type, 'status', c.status,
                        'reason', c.reason, 'since', c.since) ORDER BY c.type)
                        FROM node_conditions c WHERE c.node_id = n.id), '[]'::jsonb) AS conditions,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('key', l.key, 'value', l.value,
                        'source', l.source) ORDER BY l.key)
                        FROM node_labels l WHERE l.node_id = n.id), '[]'::jsonb) AS labels
       FROM nodes n WHERE n.id = $1${options.lock ? ' FOR UPDATE OF n' : ''}`,
    [nodeId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const n = row.node;
  const text = (key: string) => (typeof n[key] === 'string' ? (n[key] as string) : undefined);
  const hardwareKey = text('hardware_key')?.replace(/^\\x/, '');
  const record: NodeRecord = {
    id: String(n.id),
    siteId: String(n.site_id),
    ownerTenantId: String(n.owner_tenant_id),
    role: n.role as NodeRecord['role'],
    provisionState: n.provision_state as ProvisionState,
    maintenance: n.maintenance === true,
    cordoned: n.cordoned === true,
    power: (text('power') ?? 'unknown') as NodeRecord['power'],
    connectivity: n.connectivity as NodeRecord['connectivity'],
    conditions: row.conditions.map((condition) => ({
      type: condition.type,
      status: condition.status,
      ...(condition.reason !== null ? { reason: condition.reason } : {}),
      since: toMs(condition.since) ?? 0,
    })),
    noScheduleReasons: Array.isArray(n.no_schedule_reasons)
      ? (n.no_schedule_reasons as string[])
      : [],
    labels: row.labels,
    trust: n.trust as NodeRecord['trust'],
    adapter: text('adapter') ?? 'bcd/v1',
    drivers: (n.drivers ?? {}) as NodeRecord['drivers'],
    hardwareKeyTrusted: n.hardware_key_trusted === true,
    generation: Number(n.generation),
    observedGeneration: Number(n.observed_generation),
    version: Number(n.version),
  };
  if (text('pool_id')) record.poolId = text('pool_id');
  if (text('failed_from')) record.failedFrom = text('failed_from') as ProvisionState;
  if (hardwareKey) record.hardwareKey = hardwareKey;
  return { record, spec: (n.spec ?? null) as Json | null };
}

/** Merges module contributions over the base sections, in registration order. */
export function mergeNodeSpecs(parts: readonly Partial<NodeSpec>[]): NodeSpec {
  const spec: NodeSpec = { generation: 0, host: {}, devices: { assignments: [] } };
  const assignments = new Map<string, DeviceAssignment>();
  const instances = new Map<string, InstanceSpec>();
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.host?.config) spec.host = { config: { ...spec.host?.config, ...part.host.config } };
    for (const assignment of part.devices?.assignments ?? [])
      assignments.set(assignment.allocationId, assignment);
    for (const instance of part.instances ?? []) instances.set(instance.id, instance);
    if (part.access)
      spec.access = {
        ...spec.access,
        ...part.access,
        sshCaPublicKeys: [
          ...new Set([
            ...(spec.access?.sshCaPublicKeys ?? []),
            ...(part.access.sshCaPublicKeys ?? []),
          ]),
        ],
      };
    if (part.telemetry) spec.telemetry = { ...spec.telemetry, ...part.telemetry };
    if (part.daemon) spec.daemon = part.daemon;
    if (part.site) spec.site = part.site;
  }
  spec.devices = { assignments: [...assignments.values()] };
  if (instances.size) spec.instances = [...instances.values()];
  return spec;
}

const bytesField = (value: string): string =>
  (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  ).toString('base64');

const gib = (value: number): string => String(BigInt(Math.round(value * 2 ** 30)));

const bindings: Readonly<Record<string, string>> = {
  hold: 'BINDING_HOLD',
  instance: 'BINDING_INSTANCE',
  node: 'BINDING_NODE',
};

async function wireAssignments(
  tx: SqlTx,
  assignments: readonly DeviceAssignment[],
): Promise<Json[]> {
  if (!assignments.length) return [];
  const deviceIds = [...new Set(assignments.flatMap((assignment) => assignment.deviceIds))];
  const classes = new Map(
    (
      await tx.query<{ id: string; class: string }>(
        'SELECT id, class FROM devices WHERE id = ANY($1::text[])',
        [deviceIds],
      )
    ).rows.map((row) => [row.id, row.class]),
  );
  const owners = new Map(
    (
      await tx.query<{ id: string; owner_kind: string; owner_id: string; binding: string | null }>(
        `SELECT a.id, a.owner_kind, a.owner_id, r.request ->> 'binding' AS binding
           FROM allocations a
           LEFT JOIN reservations r ON a.owner_kind = 'reservation' AND r.id = a.owner_id
          WHERE a.id = ANY($1::text[])`,
        [assignments.map((assignment) => assignment.allocationId)],
      )
    ).rows.map((row) => [row.id, row]),
  );
  return [...assignments]
    .sort((a, b) => (a.allocationId < b.allocationId ? -1 : 1))
    .map((assignment) => {
      const owner = owners.get(assignment.allocationId);
      const wire: JsonObject = {
        allocationId: assignment.allocationId,
        binding:
          owner?.owner_kind === 'instance'
            ? 'BINDING_INSTANCE'
            : (bindings[owner?.binding ?? 'hold'] ?? 'BINDING_HOLD'),
        devices: [...new Set(assignment.deviceIds)]
          .sort()
          .map((id) => ({ id, deviceClass: classes.get(id) ?? 'gpu' })),
        env: [`BCD_ALLOCATION_ID=${assignment.allocationId}`],
      };
      if (owner?.owner_kind === 'reservation') wire.reservationId = owner.owner_id;
      if (owner?.owner_kind === 'instance') wire.instanceId = owner.owner_id;
      return wire;
    });
}

function wireInstance(instance: InstanceSpec): Json {
  const wire: JsonObject = {
    instanceId: instance.id,
    desiredState: `INSTANCE_DESIRED_STATE_${instance.desiredState.toUpperCase()}`,
    runtime: instance.runtime,
    vcpu: instance.flavor.vcpu,
    memoryBytes: gib(instance.flavor.memoryGiB),
    diskBytes: gib(instance.flavor.diskGiB),
    image: {
      url: instance.image.url,
      sha256: bytesField(instance.image.sha256),
      format: instance.image.format,
    },
  };
  if (instance.userData?.startsWith('secret://')) wire.userDataRef = instance.userData;
  if (instance.deviceIds?.length) wire.gpuDeviceIds = [...instance.deviceIds].sort();
  return wire;
}

/**
 * The protobuf JSON of `agent/v1 NodeSpec` for a merged spec, as the gateway reads `nodes.spec`
 * (`fromJson(NodeSpecSchema, …)`). Lists are sorted and empty ones omitted, so equal specs
 * serialize equally. Device assignments gain their class, binding and reservation from the store.
 */
export async function wireNodeSpec(tx: SqlTx, spec: NodeSpec): Promise<JsonObject> {
  const wire: JsonObject = {};
  const units = Object.keys(spec.host?.config ?? {})
    .sort()
    .map((unit) => ({ unit, configJson: canonicalJson(spec.host!.config![unit]) }));
  wire.host = units.length ? { units } : {};
  const assignments = await wireAssignments(tx, spec.devices?.assignments ?? []);
  wire.devices = assignments.length ? { assignments } : {};
  if (spec.instances?.length)
    wire.instances = {
      instances: [...spec.instances].sort((a, b) => (a.id < b.id ? -1 : 1)).map(wireInstance),
    };
  if (spec.access) {
    const access: JsonObject = {};
    if (spec.access.execTicketJwks !== undefined)
      access.execTicketJwksJson = canonicalJson(spec.access.execTicketJwks);
    if (spec.access.sshCaPublicKeys?.length)
      access.sshCaPublicKeys = [...spec.access.sshCaPublicKeys].sort();
    if (spec.access.sshPrincipals?.length)
      access.sshPrincipals = [...spec.access.sshPrincipals].sort();
    // uint64 in proto3 JSON is a decimal string; sorted numerically for a stable spec hash.
    if (spec.access.sshRevokedSerials?.length)
      access.sshRevokedSerials = [...new Set(spec.access.sshRevokedSerials)].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
      );
    wire.access = access;
  }
  if (spec.telemetry) {
    const telemetry: JsonObject = {};
    if (spec.telemetry.otlpEndpoint) telemetry.otlpEndpoint = spec.telemetry.otlpEndpoint;
    if (spec.telemetry.intervalSeconds)
      telemetry.exportIntervalMs = Math.round(spec.telemetry.intervalSeconds * 1000);
    wire.telemetry = telemetry;
  }
  if (spec.daemon) {
    const daemon: JsonObject = {
      version: spec.daemon.version,
      url: spec.daemon.url,
      sha256: bytesField(spec.daemon.sha256),
    };
    if (spec.daemon.signature) daemon.signature = bytesField(spec.daemon.signature);
    wire.daemon = daemon;
  }
  if (spec.site)
    wire.site = { boot: { active: spec.site.boot.active, epoch: String(spec.site.boot.epoch) } };
  return wire;
}

export interface NodeSpecOutcome {
  generation: number;
  /** Whether this pass wrote a new spec (and bumped the generation). */
  changed: boolean;
  spec: JsonObject;
}

/**
 * One NodeSpec pass over a node, in one transaction with its row locked: collects the modules'
 * contributions (their queries join this transaction), renders the wire spec, and writes it with
 * `generation + 1` only when the canonical JSON differs from the stored one. Undefined when the
 * node does not exist or desired state does not apply to it yet.
 */
export async function reconcileNodeSpec(
  context: ModuleContext,
  nodeId: string,
  modules: readonly ComputeModule[],
  hooks: {
    /** Runs in the transaction that wrote a new generation (the runtime pokes the gateway). */
    changed?(tx: SqlTx, nodeId: string, generation: number): Promise<void>;
  } = {},
): Promise<NodeSpecOutcome | undefined> {
  return context.sql.transaction(async (tx) => {
    const loaded = await loadNodeRecord(tx, nodeId, { lock: true });
    if (!loaded) return undefined;
    const { record, spec: stored } = loaded;
    if (
      record.generation === 0 &&
      !(schedulableProvisionStates as readonly ProvisionState[]).includes(record.provisionState)
    )
      return undefined;
    const parts: Partial<NodeSpec>[] = [];
    for (const module of modules)
      if (typeof module.nodeSpec === 'function') parts.push(await module.nodeSpec(context, record));
    const next = await wireNodeSpec(tx, mergeNodeSpecs(parts));
    if (stored !== null && canonicalJson(stored) === canonicalJson(next))
      return { generation: record.generation, changed: false, spec: next };
    const updated = await tx.query<{ generation: string | number }>(
      `UPDATE nodes SET spec = $2::jsonb, generation = generation + 1, version = version + 1
        WHERE id = $1 AND generation = $3
        RETURNING generation`,
      [nodeId, JSON.stringify(next), record.generation],
    );
    const generation = Number(updated.rows[0]?.generation ?? record.generation);
    const changed = updated.rowCount === 1;
    if (changed) await hooks.changed?.(tx, nodeId, generation);
    return { generation, changed, spec: next };
  });
}
