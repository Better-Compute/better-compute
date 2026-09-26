import {
  RiAlarmWarningLine,
  RiLayoutColumnLine,
  RiRefreshLine,
  RiServerLine,
  RiWifiOffLine,
} from 'react-icons/ri';
import type { AdminModule } from '@/lib/modules';

/**
 * Fleet and operations: nodes (table, racks, detail), GPU devices and health, workloads (instances, sandboxes,
 * volumes), the metal lifecycle, rollouts, fleet drift, quorum batches and the live activity stream.
 */
export const fleetModule: AdminModule = {
  id: 'fleet',
  title: 'Fleet',
  nav: [
    {
      href: '/nodes',
      label: 'Nodes',
      icon: RiServerLine,
      group: 'Fleet',
      shortcut: 'g n',
      keywords: ['machines', 'servers', 'hosts', 'cordon', 'drain', 'racks', 'bcd'],
      description: 'Every machine: health, GPUs, lifecycle, racks; cordon, drain, label',
    },
  ],
  widgets: [],
  commands: [
    { id: 'fleet.nodes.attention', label: 'Nodes that need attention', group: 'Fleet', icon: RiAlarmWarningLine, href: '/nodes?preset=attention', keywords: ['incidents', 'broken', 'critical'] },
    { id: 'fleet.nodes.offline', label: 'Offline nodes', group: 'Fleet', icon: RiWifiOffLine, href: '/nodes?health=offline', keywords: ['unreachable', 'lost', 'down'] },
    { id: 'fleet.nodes.racks', label: 'Rack elevations', group: 'Fleet', icon: RiLayoutColumnLine, href: '/nodes?view=racks', keywords: ['datacenter', 'layout', 'units'] },
    { id: 'fleet.nodes.outdated', label: 'Nodes on an old bcd', group: 'Fleet', icon: RiRefreshLine, href: '/nodes?preset=outdated', keywords: ['version', 'upgrade', 'daemon'] },
  ],
};
