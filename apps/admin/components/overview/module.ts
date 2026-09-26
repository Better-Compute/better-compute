import {
  RiAlarmWarningLine,
  RiDashboard3Line,
  RiEyeLine,
  RiFlashlightLine,
  RiGridLine,
  RiMapPin2Line,
  RiPulseLine,
  RiServerLine,
  RiStackLine,
  RiStickyNoteLine,
  RiTimerFlashLine,
} from 'react-icons/ri';
import type { AdminModule } from '@/lib/modules';
import { controlPlane, fleetPulse, siteById, sites } from '@/lib/data';
import { WatchingWidget } from '@/components/shell/watching';
import { ComponentPeek, SitePeek } from './peeks';
import { NotesWidget } from './notes-widget';
import {
  ActivityWidget,
  AttentionQueue,
  ControlPlaneWidget,
  FleetWall,
  KpiStrip,
  PowerWidget,
  PulseChart,
  SitesWidget,
} from './widgets';

/** The Overview: cross-cutting widgets over the whole fleet and the control plane itself. */
export const overviewModule: AdminModule = {
  id: 'overview',
  title: 'Overview',
  nav: [
    {
      href: '/',
      label: 'Overview',
      icon: RiDashboard3Line,
      group: 'Overview',
      shortcut: 'g o',
      keywords: ['home', 'dashboard', 'widgets'],
      description: 'Dashboards of widgets from every module',
    },
    {
      href: '/attention',
      label: 'Needs attention',
      icon: RiAlarmWarningLine,
      group: 'Overview',
      shortcut: 'g a',
      keywords: ['alerts', 'incidents', 'queue', 'ack', 'on-call'],
      description: 'Failures, approvals, quota pressure and forecasts from every module',
    },
    {
      href: '/control-plane',
      label: 'Control plane',
      icon: RiServerLine,
      group: 'Overview',
      shortcut: 'g p',
      keywords: ['api', 'gateway', 'database', 'workers', 'health', 'status'],
      description: 'The API, gateways, workers, database and outbox',
    },
  ],
  search: (query) => {
    const q = query.toLowerCase();
    return [
      ...sites
        .filter((site) => `${site.id} ${site.name} ${site.city} ${site.provider}`.toLowerCase().includes(q))
        .map((site) => ({
          id: site.id,
          label: `${site.name} (${site.id})`,
          group: 'Sites',
          hint: `${site.city} · ${site.provider}`,
          icon: RiMapPin2Line,
          href: `/?site=${site.id}`,
          peek: { kind: 'site', id: site.id },
        })),
      ...controlPlane(0)
        .filter((c) => `${c.id} ${c.name} ${c.kind}`.toLowerCase().includes(q))
        .map((c) => ({
          id: c.id,
          label: c.name,
          group: 'Control plane',
          hint: c.kind,
          icon: RiServerLine,
          href: '/control-plane',
          peek: { kind: 'component', id: c.id },
        })),
    ];
  },
  watch: {
    site: (id, now) => {
      const site = siteById(id);
      if (!site) return null;
      const pulse = fleetPulse(now, { siteId: id });
      const gateway = controlPlane(now).find((c) => c.id === `gw-${id}`);
      const status = pulse.nodes.offline > 2 || gateway?.status === 'down' ? 'crit' : pulse.nodes.offline || pulse.nodes.degraded > 3 || gateway?.status === 'degraded' ? 'warn' : 'ok';
      return {
        label: site.name,
        status,
        summary: `${pulse.nodes.ready}/${pulse.nodes.total} ready · ${pulse.nodes.offline} offline · gateway ${gateway?.status ?? 'unknown'}`,
        href: `/?site=${id}`,
      };
    },
    component: (id, now) => {
      const c = controlPlane(now).find((x) => x.id === id);
      if (!c) return null;
      return { label: c.name, status: c.status === 'ok' ? 'ok' : c.status === 'down' ? 'crit' : 'warn', summary: c.detail, href: '/control-plane' };
    },
  },
  peeks: {
    site: { title: (id) => siteById(id)?.name ?? id, href: (id) => `/?site=${id}`, icon: RiMapPin2Line, component: SitePeek },
    component: { title: (id) => controlPlane(0).find((c) => c.id === id)?.name ?? id, href: () => '/control-plane', icon: RiServerLine, component: ComponentPeek },
  },
  widgets: [
    { id: 'overview.kpis', title: 'Fleet KPIs', description: 'Nodes ready, GPU and CPU utilization, free GPUs, sandboxes, power — with trends.', icon: RiStackLine, module: 'overview', defaultSize: { w: 12, h: 2 }, minSize: { w: 4, h: 2 }, maxSize: { w: 12, h: 3 }, live: true, component: KpiStrip },
    {
      id: 'overview.pulse',
      title: 'Utilization',
      description: 'A fleet metric over the workspace time range: utilization, GPUs allocated, sandboxes or power.',
      icon: RiPulseLine,
      module: 'overview',
      defaultSize: { w: 8, h: 4 },
      minSize: { w: 4, h: 3 },
      settings: [
        {
          id: 'metric',
          label: 'Metric',
          type: 'select',
          default: 'utilization',
          options: [
            { value: 'utilization', label: 'Utilization (GPU vs CPU)' },
            { value: 'gpus', label: 'GPUs allocated' },
            { value: 'sandboxes', label: 'Sandboxes live' },
            { value: 'power', label: 'IT power' },
          ],
        },
        { id: 'compare', label: 'CPU line', type: 'toggle', default: true, hint: 'Show CPU utilization next to GPU' },
      ],
      component: PulseChart,
    },
    { id: 'overview.attention', title: 'Needs attention', description: 'The operator queue: failures, approvals, forecasts, quota pressure.', icon: RiAlarmWarningLine, module: 'overview', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, href: '/attention', component: AttentionQueue,
      settings: [{ id: 'grouped', label: 'Group', type: 'toggle', default: true, hint: 'Collapse items of the same kind ("Node unreachable" ×3)' }] },
    { id: 'overview.fleet-wall', title: 'Fleet wall', description: 'Every node as one cell, grouped by pool: load, faults, provisioning.', icon: RiGridLine, module: 'overview', defaultSize: { w: 8, h: 4 }, minSize: { w: 4, h: 3 }, href: '/nodes', component: FleetWall,
      settings: [{ id: 'kind', label: 'Pools', type: 'select', default: 'all', options: [{ value: 'all', label: 'All pools' }, { value: 'gpu', label: 'GPU pools' }, { value: 'cpu', label: 'CPU pools' }, { value: 'sandbox', label: 'Sandbox pools' }] }] },
    { id: 'overview.control-plane', title: 'Control plane', description: 'API, IAM bridge, database, workers, outbox and each site gateway.', icon: RiServerLine, module: 'overview', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, href: '/control-plane', component: ControlPlaneWidget },
    { id: 'overview.sites', title: 'Sites', description: 'Sites on a map with nodes, GPUs, utilization and power. Click to scope.', icon: RiMapPin2Line, module: 'overview', defaultSize: { w: 6, h: 4 }, minSize: { w: 3, h: 3 }, component: SitesWidget },
    { id: 'overview.activity', title: 'Activity', description: 'The live event stream, newest first, filterable by kind.', icon: RiTimerFlashLine, module: 'overview', defaultSize: { w: 6, h: 4 }, minSize: { w: 3, h: 3 }, href: '/activity', component: ActivityWidget,
      settings: [{ id: 'severity', label: 'Show', type: 'select', default: 'info', options: [{ value: 'info', label: 'Everything' }, { value: 'warning', label: 'Warnings and critical' }, { value: 'critical', label: 'Critical only' }] }] },
    { id: 'overview.watching', title: 'Watching', description: 'Nodes, pools, reservations and sites you watch, with their state now; a toast when one changes.', icon: RiEyeLine, module: 'overview', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 2 }, live: true, component: WatchingWidget },
    { id: 'overview.notes', title: 'Notes', description: 'Handover notes, runbook links and who is on call, saved with the dashboard.', icon: RiStickyNoteLine, module: 'overview', defaultSize: { w: 4, h: 3 }, minSize: { w: 2, h: 2 }, live: true, component: NotesWidget },
    { id: 'overview.power', title: 'Power', description: 'IT power draw against budget, and the energy run-rate.', icon: RiFlashlightLine, module: 'overview', defaultSize: { w: 4, h: 2 }, minSize: { w: 3, h: 2 }, component: PowerWidget },
  ],
};
