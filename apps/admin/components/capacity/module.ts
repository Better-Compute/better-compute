import {
  RiAddLine,
  RiBarChartBoxLine,
  RiCalendarEventLine,
  RiCalendarScheduleLine,
  RiDownloadLine,
  RiLightbulbFlashLine,
  RiLayoutGridLine,
  RiMoneyDollarCircleLine,
  RiPieChart2Line,
  RiScales3Line,
  RiSearchEyeLine,
  RiServerLine,
  RiStackLine,
  RiTimerLine,
} from 'react-icons/ri';
import type { AdminModule, CommandDef, SearchResult, WidgetDef, WidgetSetting } from '@/lib/modules';
import { capacityAt, capacityInsights, reservationGpus } from '@/lib/data/capacity';
import { pools, tenants } from '@/lib/data/topology';
import { PoolPeek, ReservationPeek, TenantPeek } from './peeks';
import { FreeGpusStatus, InsightsStatus, WaitingStatus } from './status';
import {
  CapacityHeatmapWidget,
  CapacityKpisWidget,
  FinderWidget,
  InsightsWidget,
  ModelsWidget,
  padded,
  PoolsWidget,
  PressureWidget,
  QuotaAlertsWidget,
  SpendWidget,
  UpcomingWidget,
} from './widgets';

// Capacity: pools, bookings over time, reservations and their planning, quotas, usage and spend, flavors.

// Pools themselves come from `search` (with peeks); commands are the verbs.
const poolCommands: CommandDef[] = pools
  .filter((pool) => pool.kind === 'gpu')
  .map((pool) => ({
    id: `capacity.book.${pool.id}`,
    label: `Book ${pool.short} GPUs in ${pool.siteId}`,
    group: 'Capacity',
    icon: RiAddLine,
    keywords: ['reserve', 'reservation', 'gpu', pool.short, pool.id],
    href: `/reservations/new?pool=${pool.id}`,
  }));

const gpuModels = [...new Set(pools.filter((pool) => pool.kind === 'gpu').map((pool) => pool.short))];
const modelOptions = [{ value: 'all', label: 'All GPU models' }, ...gpuModels.map((model) => ({ value: model, label: model }))];

/** Per-instance options of each widget (the shell's Configure drawer). */
const SETTINGS: Record<string, WidgetSetting[]> = {
  'capacity.heatmap': [
    {
      id: 'window',
      label: 'Window',
      type: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Fit the widget' },
        { value: '12/48', label: '12 h back · 48 h ahead' },
        { value: '24/96', label: '1 d back · 4 d ahead' },
        { value: '48/168', label: '2 d back · 7 d ahead' },
        { value: '168/168', label: '7 d back · 7 d ahead' },
      ],
    },
    { id: 'model', label: 'GPU model', type: 'select', default: 'all', options: modelOptions },
    { id: 'sort', label: 'Rows', type: 'select', default: 'pool', options: [{ value: 'pool', label: 'By pool' }, { value: 'utilization', label: 'Busiest first' }] },
  ],
  'capacity.pools': [
    { id: 'sort', label: 'Sort', type: 'select', default: 'utilization', options: [{ value: 'utilization', label: 'Busiest first' }, { value: 'free', label: 'Most free first' }, { value: 'name', label: 'By name' }] },
    { id: 'kind', label: 'Pools', type: 'select', default: 'all', options: [{ value: 'all', label: 'All' }, { value: 'gpu', label: 'GPU pools' }, { value: 'vcpu', label: 'CPU & sandbox pools' }] },
  ],
  'reservations.upcoming': [
    { id: 'horizon', label: 'Look ahead (hours)', type: 'number', default: 12, min: 1, max: 72, step: 1 },
    { id: 'show', label: 'Show', type: 'select', default: 'both', options: [{ value: 'both', label: 'Starts and ends' }, { value: 'starts', label: 'Starts only' }, { value: 'ends', label: 'Ends only' }] },
    { id: 'minGpus', label: 'At least (GPUs)', type: 'number', default: 1, min: 1, max: 64, step: 1, hint: 'hide small bookings' },
  ],
  'quotas.alerts': [
    { id: 'threshold', label: 'Alert at (%)', type: 'number', default: 80, min: 50, max: 100, step: 5 },
    { id: 'resource', label: 'Resource', type: 'select', default: 'all', options: [{ value: 'all', label: 'All' }, { value: 'gpu', label: 'GPUs' }, { value: 'vcpu', label: 'vCPUs' }, { value: 'memoryGiB', label: 'Memory' }] },
  ],
  'usage.spend': [
    { id: 'days', label: 'Days', type: 'number', default: 30, min: 1, max: 30, step: 1 },
    { id: 'group', label: 'Top list by', type: 'select', default: 'tenant', options: [{ value: 'tenant', label: 'Tenant' }, { value: 'project', label: 'Project' }, { value: 'pool', label: 'Pool' }, { value: 'meter', label: 'Meter' }] },
  ],
  'capacity.finder': [
    { id: 'gpus', label: 'GPUs', type: 'select', default: '8', options: ['1', '8', '16', '32', '64'].map((value) => ({ value, label: value })) },
    { id: 'duration', label: 'For', type: 'select', default: '1d', options: ['4h', '1d', '3d', '7d'].map((value) => ({ value, label: value })) },
    { id: 'model', label: 'GPU model', type: 'select', default: 'all', options: modelOptions },
  ],
  'capacity.pressure': [
    { id: 'gpus', label: 'GPUs on one node', type: 'number', default: 8, min: 1, max: 8, step: 1 },
    { id: 'hours', label: 'For (hours)', type: 'number', default: 24, min: 1, max: 168, step: 1 },
  ],
};

/** Attach settings, and padding for every widget but the KPI strip (which draws edge-to-edge cells). */
const withSettings = (widgets: WidgetDef[]): WidgetDef[] =>
  widgets.map((widget) => ({
    ...widget,
    ...(SETTINGS[widget.id] ? { settings: SETTINGS[widget.id] } : {}),
    component: widget.id === 'capacity.kpis' ? widget.component : padded(widget.component),
  }));

const matches = (query: string, ...fields: (string | undefined)[]) => {
  const q = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(q));
};

/** Palette entities: pools, tenants and reservations (by id, or a tenant's live ones). */
function search(query: string, context: { now: number; siteId?: string }): SearchResult[] {
  const results: SearchResult[] = [];
  for (const pool of pools) {
    if (context.siteId && pool.siteId !== context.siteId) continue;
    if (matches(query, pool.id, pool.name, pool.short, pool.model, pool.siteId))
      results.push({ id: `pool:${pool.id}`, label: pool.name, group: 'Pools', hint: `${pool.short} · ${pool.siteId} · ${pool.nodes * (pool.gpusPerNode || 1)} ${pool.gpusPerNode ? 'GPUs' : 'nodes'}`, icon: RiServerLine, href: `/pools/${pool.id}`, peek: { kind: 'pool', id: pool.id } });
  }
  for (const tenant of tenants)
    if (matches(query, tenant.id, tenant.name, tenant.slug))
      results.push({ id: `tenant:${tenant.id}`, label: tenant.name, group: 'Tenants', hint: tenant.id, icon: RiScales3Line, href: `/quotas?tenant=${tenant.id}`, peek: { kind: 'tenant', id: tenant.id } });
  const q = query.toLowerCase();
  if (q.length >= 3 && (q.startsWith('rsv') || /[0-9]/.test(q))) {
    const snapshot = capacityAt(context.now);
    for (const reservation of snapshot.reservations) {
      if (!reservation.id.includes(q)) continue;
      results.push({
        id: `reservation:${reservation.id}`,
        label: reservation.id,
        group: 'Reservations',
        hint: `${reservation.state} · ${reservationGpus(reservation)} GPU · ${reservation.poolId}`,
        icon: RiCalendarEventLine,
        href: `/reservations?id=${reservation.id}`,
        peek: { kind: 'reservation', id: reservation.id },
      });
      if (results.length >= 8) break;
    }
  }
  return results.slice(0, 8);
}

export const capacityModule: AdminModule = {
  search,
  attention: (now, scope) => capacityInsights(now, scope),
  status: [FreeGpusStatus, WaitingStatus, InsightsStatus],
  peeks: {
    pool: { title: (id) => pools.find((pool) => pool.id === id)?.name ?? id, href: (id) => `/pools/${id}`, icon: RiServerLine, component: PoolPeek },
    reservation: { title: (id) => `Reservation ${id}`, href: (id) => `/reservations?id=${id}`, icon: RiCalendarEventLine, component: ReservationPeek },
    tenant: { title: (id) => tenants.find((tenant) => tenant.id === id)?.name ?? id, href: (id) => `/quotas?tenant=${id}`, icon: RiScales3Line, component: TenantPeek },
  },
  id: 'capacity',
  title: 'Capacity',
  nav: [
    { href: '/capacity', label: 'Capacity', icon: RiBarChartBoxLine, group: 'Capacity', shortcut: 'g c', keywords: ['gpus', 'heatmap', 'forecast', 'utilization', 'free'], description: 'GPUs booked now and ahead, per pool and hour' },
    { href: '/pools', label: 'Pools', icon: RiServerLine, group: 'Capacity', shortcut: 'g l', keywords: ['pool', 'site', 'gpu model', 'policy', 'offers'], description: 'Scheduling domains: capacity, schedule, tenants, policy' },
    { href: '/reservations', label: 'Reservations', icon: RiCalendarEventLine, group: 'Capacity', shortcut: 'g r', keywords: ['bookings', 'gantt', 'release', 'cancel', 'extend', 'pending'], description: 'Every booking: table, timeline, what is waiting' },
    { href: '/reservations/new', label: 'Plan a reservation', icon: RiSearchEyeLine, group: 'Capacity', shortcut: 'n r', keywords: ['book', 'preview', 'placement', 'earliest', 'dry run', 'find gpus'], description: 'Dry-run placement, earliest fit, cost and alternatives' },
    { href: '/quotas', label: 'Quotas', icon: RiScales3Line, group: 'Capacity', shortcut: 'g q', keywords: ['limits', 'tenants', 'ceiling', 'quotas.set'], description: 'Tenant × pool ceilings and use' },
    { href: '/usage', label: 'Usage & spend', icon: RiMoneyDollarCircleLine, group: 'Capacity', shortcut: 'g u', keywords: ['billing', 'cost', 'meters', 'csv', 'invoice', 'gpu hours'], description: 'Metered usage priced at list, by tenant, project, pool' },
    { href: '/flavors', label: 'Flavors', icon: RiLayoutGridLine, group: 'Capacity', keywords: ['instance types', 'shapes', 'sizes', 'vps'], description: 'Instance and sandbox shapes per pool' },
  ],
  widgets: withSettings([
    { id: 'capacity.kpis', title: 'Capacity KPIs', description: 'GPUs allocated, free now, booked later, pending, spend.', icon: RiStackLine, module: 'capacity', defaultSize: { w: 12, h: 2 }, minSize: { w: 4, h: 2 }, maxSize: { w: 12, h: 3 }, href: '/capacity', component: CapacityKpisWidget },
    { id: 'capacity.heatmap', title: 'Booking heatmap', description: 'Share of GPUs booked per pool and hour, history and ahead.', icon: RiCalendarScheduleLine, module: 'capacity', defaultSize: { w: 8, h: 4 }, minSize: { w: 4, h: 3 }, href: '/capacity', component: CapacityHeatmapWidget },
    { id: 'capacity.pools', title: 'Pools', description: 'Each pool: allocated, free, out of service.', icon: RiServerLine, module: 'capacity', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 2 }, href: '/pools', component: PoolsWidget },
    { id: 'capacity.models', title: 'GPU models', description: 'Allocated and free GPUs per model.', icon: RiPieChart2Line, module: 'capacity', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, href: '/capacity', component: ModelsWidget },
    { id: 'reservations.upcoming', title: 'Starts & ends', description: 'Reservations starting or ending in the next 12 hours.', icon: RiCalendarEventLine, module: 'capacity', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 2 }, href: '/reservations', component: UpcomingWidget },
    { id: 'quotas.alerts', title: 'Quota pressure', description: 'Tenants at 80% or more of a quota.', icon: RiScales3Line, module: 'capacity', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, href: '/quotas', component: QuotaAlertsWidget },
    { id: 'usage.spend', title: 'Spend', description: '30-day estimated spend and the top tenants.', icon: RiMoneyDollarCircleLine, module: 'capacity', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, href: '/usage', component: SpendWidget },
    { id: 'capacity.finder', title: 'Find GPUs', description: 'Where N GPUs are free for a duration, soonest first.', icon: RiSearchEyeLine, module: 'capacity', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, href: '/reservations/new', component: FinderWidget },
    { id: 'capacity.pressure', title: 'Where it is tight', description: 'Per pool: when 8 GPUs are next free for 24 h.', icon: RiTimerLine, module: 'capacity', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, href: '/capacity', component: PressureWidget },
    { id: 'capacity.insights', title: 'Capacity insights', description: 'Pools about to fill, unplaceable work, fragmentation, quota ceilings, billing dead letters.', icon: RiLightbulbFlashLine, module: 'capacity', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 2 }, href: '/capacity', component: InsightsWidget },
  ]),
  commands: [
    { id: 'capacity.new', label: 'Plan a reservation', group: 'Capacity', icon: RiSearchEyeLine, keywords: ['book', 'reserve', 'gpus', 'preview'], href: '/reservations/new', shortcut: 'n r' },
    { id: 'capacity.pending', label: 'Show pending reservations', group: 'Capacity', icon: RiTimerLine, keywords: ['waiting', 'unschedulable', 'queue'], href: '/reservations' },
    { id: 'capacity.timeline', label: 'Reservation timeline (Gantt)', group: 'Capacity', icon: RiCalendarScheduleLine, keywords: ['gantt', 'schedule', 'calendar'], href: '/reservations?view=timeline' },
    { id: 'capacity.export-usage', label: 'Export usage as CSV', group: 'Capacity', icon: RiDownloadLine, keywords: ['billing', 'csv', 'download'], href: '/usage' },
    ...poolCommands,
  ],
};
