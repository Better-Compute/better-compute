import {
  RiAlarmWarningLine,
  RiDashboard3Line,
  RiFlashlightLine,
  RiGridLine,
  RiMapPin2Line,
  RiPulseLine,
  RiServerLine,
  RiStackLine,
  RiTimerFlashLine,
} from 'react-icons/ri';
import type { AdminModule } from '@/lib/modules';
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
      href: '/control-plane',
      label: 'Control plane',
      icon: RiServerLine,
      group: 'Overview',
      shortcut: 'g p',
      keywords: ['api', 'gateway', 'database', 'workers', 'health', 'status'],
      description: 'The API, gateways, workers, database and outbox',
    },
  ],
  widgets: [
    { id: 'overview.kpis', title: 'Fleet KPIs', description: 'Nodes ready, GPU and CPU utilization, free GPUs, sandboxes, power — with trends.', icon: RiStackLine, module: 'overview', defaultSize: { w: 12, h: 2 }, minSize: { w: 4, h: 2 }, maxSize: { w: 12, h: 3 }, component: KpiStrip },
    { id: 'overview.pulse', title: 'Utilization', description: 'GPU and CPU utilization over the workspace time range.', icon: RiPulseLine, module: 'overview', defaultSize: { w: 8, h: 4 }, minSize: { w: 4, h: 3 }, component: PulseChart },
    { id: 'overview.attention', title: 'Needs attention', description: 'The operator queue: failures, approvals, forecasts, quota pressure.', icon: RiAlarmWarningLine, module: 'overview', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, href: '/#attention', component: AttentionQueue },
    { id: 'overview.fleet-wall', title: 'Fleet wall', description: 'Every node as one cell, grouped by pool: load, faults, provisioning.', icon: RiGridLine, module: 'overview', defaultSize: { w: 8, h: 4 }, minSize: { w: 4, h: 3 }, href: '/nodes', component: FleetWall },
    { id: 'overview.control-plane', title: 'Control plane', description: 'API, IAM bridge, database, workers, outbox and each site gateway.', icon: RiServerLine, module: 'overview', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, href: '/control-plane', component: ControlPlaneWidget },
    { id: 'overview.sites', title: 'Sites', description: 'Sites on a map with nodes, GPUs, utilization and power. Click to scope.', icon: RiMapPin2Line, module: 'overview', defaultSize: { w: 6, h: 4 }, minSize: { w: 3, h: 3 }, component: SitesWidget },
    { id: 'overview.activity', title: 'Activity', description: 'The live event stream, newest first, filterable by kind.', icon: RiTimerFlashLine, module: 'overview', defaultSize: { w: 6, h: 4 }, minSize: { w: 3, h: 3 }, href: '/activity', component: ActivityWidget },
    { id: 'overview.power', title: 'Power', description: 'IT power draw against budget, and the energy run-rate.', icon: RiFlashlightLine, module: 'overview', defaultSize: { w: 4, h: 2 }, minSize: { w: 3, h: 2 }, component: PowerWidget },
  ],
};
