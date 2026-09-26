import { clamp, DAY, diurnal, drift, floorTo, HOUR, MINUTE, noise, pick } from './core';
import { pools, poolNodeId, sites, tenants, type Pool } from './topology';

// Cross-cutting simulated signals for the Overview and the shell: the fleet's pulse (health and utilization,
// per pool and over time), the control plane's own health, the operator's attention queue and a general
// activity stream. The capacity and fleet modules keep their own detailed sources (lib/data/capacity.ts,
// lib/data/fleet.ts) built on the same topology and helpers, so the numbers agree in spirit.

export interface Scope {
  siteId?: string;
}

const inScope = (pool: Pool, scope?: Scope) => !scope?.siteId || pool.siteId === scope.siteId;

export interface PoolPulse {
  pool: Pool;
  nodes: { ready: number; degraded: number; offline: number; provisioning: number };
  /** GPU pools count GPUs; CPU and sandbox pools count vCPUs. */
  unit: 'gpu' | 'vcpu';
  total: number;
  allocated: number;
  reserved: number;
  unhealthy: number;
  available: number;
  utilization: number;
  /** Instantaneous IT power draw, kW. */
  powerKw: number;
}

/** A pool's state at `t`: bookings follow a diurnal curve plus slow per-pool drift; faults are rare and sticky. */
export function poolPulse(pool: Pool, t: number): PoolPulse {
  const base = pool.kind === 'gpu' ? 0.62 : pool.kind === 'sandbox' ? 0.38 : 0.48;
  const phase = pool.siteId.startsWith('iad') || pool.siteId.startsWith('sjc') ? -7 : 0;
  const load = clamp(
    base + 0.22 * diurnal(t, phase) + 0.18 * (drift(`${pool.id}:load`, t, 5 * HOUR) - 0.5),
    0.05,
    0.985,
  );
  const faultBucket = floorTo(t, 20 * MINUTE);
  const offline = Math.floor(noise(`${pool.id}:off`, faultBucket / MINUTE) * 2.2 * (pool.nodes / 60));
  const degraded = Math.floor(noise(`${pool.id}:deg`, faultBucket / MINUTE) * 3.4 * (pool.nodes / 50));
  const provisioning = Math.floor(noise(`${pool.id}:prov`, floorTo(t, HOUR) / MINUTE) * 2.5);
  const ready = Math.max(0, pool.nodes - offline - degraded - provisioning);
  const unit = pool.kind === 'gpu' ? 'gpu' : 'vcpu';
  const perNode = unit === 'gpu' ? pool.gpusPerNode : pool.vcpusPerNode;
  const total = pool.nodes * perNode;
  const unhealthy = (offline + provisioning) * perNode + Math.round(degraded * perNode * 0.25);
  const schedulable = Math.max(0, total - unhealthy);
  const allocated = Math.round(schedulable * load);
  const reserved = Math.round((schedulable - allocated) * (0.25 + 0.3 * drift(`${pool.id}:rsv`, t, 3 * HOUR)));
  const available = Math.max(0, schedulable - allocated - reserved);
  const idleKw = pool.kind === 'gpu' ? 1.6 : 0.35;
  const busyKw = pool.kind === 'gpu' ? pool.gpusPerNode * 0.68 : 0.55;
  const powerKw = (ready + degraded) * (idleKw + busyKw * load);
  return {
    pool,
    nodes: { ready, degraded, offline, provisioning },
    unit,
    total,
    allocated,
    reserved,
    unhealthy,
    available,
    utilization: schedulable ? allocated / schedulable : 0,
    powerKw,
  };
}

export type NodeState = 'busy' | 'idle' | 'degraded' | 'offline' | 'provisioning';

/**
 * Which of a pool's nodes are offline, provisioning and degraded at `t` (the pulse only has counts): nodes are
 * ranked by a per-node fault draw that changes every 20 minutes, and the lowest ranks take the fault states in
 * that order. The rest are busy or idle by their own load. Shared by the Fleet wall and the fleet module, so a
 * node is offline on every page at once.
 */
export function nodeStates(pulse: PoolPulse, t: number): { id: string; index: number; state: NodeState; load: number }[] {
  const { pool, nodes } = pulse;
  const bucket = floorTo(t, 20 * MINUTE) / MINUTE;
  const ranked = Array.from({ length: pool.nodes }, (_, i) => ({ i, r: noise(`${pool.id}:${i}:fault`, bucket) }))
    .sort((a, b) => a.r - b.r)
    .map((entry) => entry.i);
  const states = new Array<NodeState>(pool.nodes).fill('idle');
  let k = 0;
  for (let n = 0; n < nodes.offline; n++) states[ranked[k++]!] = 'offline';
  for (let n = 0; n < nodes.provisioning; n++) states[ranked[k++]!] = 'provisioning';
  for (let n = 0; n < nodes.degraded; n++) states[ranked[k++]!] = 'degraded';
  return states.map((state, i) => {
    const load = clamp(pulse.utilization + (noise(`${pool.id}:${i}:load`, Math.floor(t / (5 * MINUTE))) - 0.5) * 0.9, 0, 1);
    return { id: poolNodeId(pool, i), index: i, state: state === 'idle' && load > 0.15 ? 'busy' : state, load };
  });
}

export interface FleetPulse {
  t: number;
  nodes: { total: number; ready: number; degraded: number; offline: number; provisioning: number };
  gpus: { total: number; allocated: number; reserved: number; available: number; unhealthy: number };
  vcpus: { total: number; allocated: number };
  gpuUtilization: number;
  cpuUtilization: number;
  sandboxesLive: number;
  powerKw: number;
  pools: PoolPulse[];
}

export function fleetPulse(t: number, scope?: Scope): FleetPulse {
  const pulses = pools.filter((pool) => inScope(pool, scope)).map((pool) => poolPulse(pool, t));
  const sum = (pick: (p: PoolPulse) => number, filter: (p: PoolPulse) => boolean = () => true) =>
    pulses.filter(filter).reduce((total, p) => total + pick(p), 0);
  const gpu = (p: PoolPulse) => p.unit === 'gpu';
  const cpu = (p: PoolPulse) => p.unit === 'vcpu';
  const gpuAllocatable = sum((p) => p.total - p.unhealthy, gpu);
  const cpuAllocatable = sum((p) => p.total - p.unhealthy, cpu);
  const sandboxVcpus = sum((p) => p.allocated, (p) => p.pool.kind === 'sandbox');
  return {
    t,
    nodes: {
      total: sum((p) => p.pool.nodes),
      ready: sum((p) => p.nodes.ready),
      degraded: sum((p) => p.nodes.degraded),
      offline: sum((p) => p.nodes.offline),
      provisioning: sum((p) => p.nodes.provisioning),
    },
    gpus: {
      total: sum((p) => p.total, gpu),
      allocated: sum((p) => p.allocated, gpu),
      reserved: sum((p) => p.reserved, gpu),
      available: sum((p) => p.available, gpu),
      unhealthy: sum((p) => p.unhealthy, gpu),
    },
    vcpus: { total: sum((p) => p.total, cpu), allocated: sum((p) => p.allocated, cpu) },
    gpuUtilization: gpuAllocatable ? sum((p) => p.allocated, gpu) / gpuAllocatable : 0,
    cpuUtilization: cpuAllocatable ? sum((p) => p.allocated, cpu) / cpuAllocatable : 0,
    // 2 vCPU per sandbox on average.
    sandboxesLive: Math.round(sandboxVcpus / 2),
    powerKw: sum((p) => p.powerKw),
    pools: pulses,
  };
}

export interface PulsePoint {
  t: number;
  gpuUtilization: number;
  cpuUtilization: number;
  gpusAllocated: number;
  sandboxesLive: number;
  powerKw: number;
}

/** `points` samples ending at `t`, `step` apart (bucketed, so a ticking clock doesn't reshuffle history). */
export function pulseSeries(t: number, points: number, step: number, scope?: Scope): PulsePoint[] {
  const end = floorTo(t, step);
  return Array.from({ length: points }, (_, i) => {
    const at = end - (points - 1 - i) * step;
    const pulse = fleetPulse(at, scope);
    return {
      t: at,
      gpuUtilization: pulse.gpuUtilization,
      cpuUtilization: pulse.cpuUtilization,
      gpusAllocated: pulse.gpus.allocated,
      sandboxesLive: pulse.sandboxesLive,
      powerKw: pulse.powerKw,
    };
  });
}

// ── Control plane ────────────────────────────────────────────────────────────────────────────────────────────

export type Health = 'ok' | 'degraded' | 'down';

export interface ControlPlaneComponent {
  id: string;
  name: string;
  kind: 'api' | 'gateway' | 'worker' | 'database' | 'iam' | 'events';
  siteId?: string;
  status: Health;
  /** p99 latency in ms (API, gateways, IAM), replication lag in ms (database), queue age in ms (workers). */
  latencyMs: number;
  /** Requests (or jobs, or streams) per second. */
  rate: number;
  rateUnit: string;
  detail: string;
  /** The last 30 minutes, one point a minute, of `latencyMs`. */
  series: number[];
}

const componentSpecs: Omit<ControlPlaneComponent, 'status' | 'latencyMs' | 'rate' | 'series' | 'detail'>[] = [
  { id: 'api', name: 'Compute API', kind: 'api', rateUnit: 'req/s' },
  { id: 'iam', name: 'better-iam bridge', kind: 'iam', rateUnit: 'authz/s' },
  { id: 'db', name: 'PostgreSQL primary', kind: 'database', rateUnit: 'tx/s' },
  { id: 'workers', name: 'Reconcile workers', kind: 'worker', rateUnit: 'jobs/s' },
  { id: 'events', name: 'Event outbox', kind: 'events', rateUnit: 'evt/s' },
  ...sites.map((site) => ({
    id: `gw-${site.id}`,
    name: `Gateway ${site.id}`,
    kind: 'gateway' as const,
    siteId: site.id,
    rateUnit: 'streams',
  })),
];

const baseLatency: Record<ControlPlaneComponent['kind'], number> = {
  api: 38,
  iam: 6,
  database: 12,
  worker: 420,
  events: 180,
  gateway: 9,
};

function componentLatency(id: string, kind: ControlPlaneComponent['kind'], t: number): number {
  const spike = noise(`${id}:spike`, floorTo(t, 15 * MINUTE) / MINUTE) > 0.93 ? 3.5 : 1;
  return baseLatency[kind] * (0.7 + 0.8 * drift(`${id}:lat`, t, 7 * MINUTE)) * spike;
}

export function controlPlane(t: number): ControlPlaneComponent[] {
  const pulse = fleetPulse(t);
  return componentSpecs.map((spec) => {
    const latencyMs = componentLatency(spec.id, spec.kind, t);
    const ratio = latencyMs / baseLatency[spec.kind];
    const status: Health = ratio > 3 ? 'degraded' : 'ok';
    const load = 0.6 + 0.4 * diurnal(t);
    const siteNodes = spec.siteId
      ? pools.filter((pool) => pool.siteId === spec.siteId).reduce((n, pool) => n + pool.nodes, 0)
      : pulse.nodes.total;
    const rate =
      spec.kind === 'gateway'
        ? siteNodes
        : spec.kind === 'api'
          ? Math.round(840 * load)
          : spec.kind === 'iam'
            ? Math.round(310 * load)
            : spec.kind === 'database'
              ? Math.round(2600 * load)
              : spec.kind === 'worker'
                ? Math.round(95 * load)
                : Math.round(430 * load);
    const detail =
      spec.kind === 'gateway'
        ? `${siteNodes} daemon sessions · mTLS`
        : spec.kind === 'database'
          ? `replica lag ${Math.round(latencyMs)} ms · ${Math.round(58 + 20 * drift('db:conn', t))} conns`
          : spec.kind === 'worker'
            ? `oldest job ${Math.round(latencyMs)} ms · ${4 + Math.round(4 * drift('w:n', t, DAY))} leases`
            : spec.kind === 'events'
              ? `cursor lag ${Math.round(latencyMs)} ms · 6 sinks`
              : `p99 ${Math.round(latencyMs)} ms`;
    const series = Array.from({ length: 30 }, (_, i) =>
      componentLatency(spec.id, spec.kind, floorTo(t, MINUTE) - (29 - i) * MINUTE),
    );
    return { ...spec, status, latencyMs, rate, detail, series };
  });
}

// ── Attention queue ──────────────────────────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** The module that owns the fix. */
  source: string;
  href: string;
  at: number;
  subject: string;
  /** The one next step, rendered as a button ("Adjust quota", "Open the nodes"). */
  action?: { label: string; href: string };
}

// The platform's own items. Capacity and fleet items come from those modules' `attention` (collectAttention
// in lib/modules.ts merges them); here only the control plane itself and platform-wide chores.
const attentionTemplates: ((key: string, t: number) => Omit<AttentionItem, 'id' | 'at'>)[] = [
  (key) => ({
    severity: 'info',
    title: 'Signing root rotation due',
    detail: `Command-signing root expires in ${10 + Math.floor(noise(key, 9) * 20)} days.`,
    source: 'security',
    href: '/settings',
    subject: 'pki/command-root',
  }),
];

/** A degraded control-plane component (the Control plane page's own numbers) is an item until it recovers. */
function controlPlaneAttention(t: number, scope?: Scope): AttentionItem[] {
  return controlPlane(t)
    .filter((c) => c.status !== 'ok' && (!scope?.siteId || !c.siteId || c.siteId === scope.siteId))
    .map((c) => {
      const since = floorTo(t, 15 * MINUTE);
      return {
        id: `cp:${c.id}:${since}`,
        severity: c.status === 'down' ? ('critical' as const) : ('warning' as const),
        title: `${c.name} degraded`,
        detail: `${c.detail}; about ${Math.round(c.latencyMs / baseLatency[c.kind])}× its usual latency.`,
        source: 'control-plane',
        href: '/control-plane',
        at: since,
        subject: `component/${c.id}`,
        action: { label: 'Open the control plane', href: '/control-plane' },
      };
    });
}

/** The open items at `t`: each slot turns over every few hours, so the queue changes slowly and plausibly. */
export function attention(t: number, scope?: Scope): AttentionItem[] {
  const items: AttentionItem[] = [...controlPlaneAttention(t, scope)];
  for (let slot = 0; slot < attentionTemplates.length; slot++) {
    const period = (2 + slot) * HOUR;
    // Slots turn over at staggered times; an item opened somewhere between its slot's start and now.
    const offset = slot * 17 * MINUTE;
    const bucket = floorTo(t + offset, period) - offset;
    const key = `att:${slot}:${bucket}`;
    if (noise(key, 99) < 0.2) continue;
    // One template per slot, so the queue never repeats itself.
    const template = attentionTemplates[slot % attentionTemplates.length]!;
    const item = template(key, t);
    if (scope?.siteId && !item.detail.includes(scope.siteId) && !item.title.includes(scope.siteId)) {
      if (item.subject.startsWith('node/') || item.subject.startsWith('site/') || item.subject.startsWith('pool/'))
        continue;
    }
    // Fixed open time within the slot; not open yet → not in the queue yet.
    const at = bucket + Math.floor(noise(key, 101) * period * 0.6);
    if (at > t) continue;
    items.push({ ...item, id: key, at });
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at - a.at);
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActivityEvent {
  id: string;
  at: number;
  type: string;
  subject: string;
  actor: string;
  message: string;
  severity: Severity;
  href?: string;
}

const actors = ['system', 'scheduler', 'bcd', 'ops@operator', 'alice@aurora', 'ci@kestrel', 'jo@meridian', 'agent:mcp'];

function activityAt(key: string, at: number): ActivityEvent {
  const pool = pick(pools, key, 1);
  const node = poolNodeId(pool, Math.floor(noise(key, 2) * pool.nodes));
  const tenant = pick(tenants.slice(1), key, 3);
  const n = 1 + Math.floor(noise(key, 4) * 8);
  const rsv = `rsv_${(noise(key, 5) * 0xffffff).toString(16).slice(0, 6)}`;
  const kinds: Omit<ActivityEvent, 'id' | 'at'>[] = [
    { type: 'reservation.active', subject: `reservation/${rsv}`, actor: 'scheduler', severity: 'info',
      message: `${tenant.name}: ${n}× ${pool.short} active in ${pool.siteId}`, href: `/reservations/${rsv}` },
    { type: 'reservation.created', subject: `reservation/${rsv}`, actor: pick(actors, key, 6), severity: 'info',
      message: `${tenant.name} requested ${n}× ${pool.short}`, href: `/reservations/${rsv}` },
    { type: 'node.ready', subject: `node/${node}`, actor: 'bcd', severity: 'info',
      message: `${node} joined and passed health checks`, href: `/nodes/${node}` },
    { type: 'node.cordoned', subject: `node/${node}`, actor: 'ops@operator', severity: 'warning',
      message: `${node} cordoned for maintenance`, href: `/nodes/${node}` },
    { type: 'device.unhealthy', subject: `node/${node}`, actor: 'bcd', severity: 'critical',
      message: `GPU ${Math.floor(noise(key, 7) * 8)} on ${node}: XID 48 (double-bit ECC)`, href: `/nodes/${node}` },
    { type: 'sandbox.created', subject: `sandbox/sbx_${key.slice(-5)}`, actor: 'agent:mcp', severity: 'info',
      message: `${tenant.name}: ${n * 3} sandboxes from template python-3.13`, href: '/sandboxes' },
    { type: 'quota.set', subject: `tenant/${tenant.id}`, actor: 'ops@operator', severity: 'info',
      message: `${tenant.name} ${pool.short} quota raised to ${n * 16}`, href: '/quotas' },
    { type: 'rollout.wave', subject: 'rollout/bcd', actor: 'system', severity: 'info',
      message: `bcd rollout wave ${1 + (n % 4)} complete (${n * 12} nodes)`, href: '/rollouts' },
  ];
  const weights = [4, 3, 3, 1, 1, 3, 1, 1];
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = noise(key, 8) * total;
  let index = 0;
  while (roll >= weights[index]!) roll -= weights[index++]!;
  return { ...kinds[index]!, id: key, at };
}

/** The latest `count` events up to `t`, newest first; roughly one every 20 s. */
export function activity(t: number, count = 30, scope?: Scope): ActivityEvent[] {
  const step = 20_000;
  const events: ActivityEvent[] = [];
  for (let bucket = floorTo(t, step); events.length < count && bucket > t - 2 * DAY; bucket -= step) {
    const key = `act:${bucket}`;
    const at = bucket + Math.floor(noise(key, 0) * step);
    if (at > t) continue;
    const event = activityAt(key, at);
    if (scope?.siteId && !event.message.includes(scope.siteId) && !event.subject.includes(scope.siteId)) continue;
    events.push(event);
  }
  return events;
}
