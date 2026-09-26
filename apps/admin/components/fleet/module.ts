import {
  RiAlarmWarningLine,
  RiBox3Line,
  RiHammerLine,
  RiLayoutColumnLine,
  RiRadarLine,
  RiRefreshLine,
  RiRocket2Line,
  RiServerLine,
  RiShieldCheckLine,
  RiTimerFlashLine,
  RiWifiOffLine,
} from 'react-icons/ri';
import type { AdminModule } from '@/lib/modules';
import { NodePeek, SandboxPeek, searchFleet } from './peeks';

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
    {
      href: '/metal',
      label: 'Bare metal',
      icon: RiHammerLine,
      group: 'Fleet',
      shortcut: 'g m',
      keywords: ['bmc', 'redfish', 'ipmi', 'pxe', 'commission', 'deploy', 'workflow', 'provision'],
      description: 'Enrollment to deployment: lifecycle stages, workflows, PXE discoveries',
    },
    {
      href: '/sandboxes',
      label: 'Sandboxes',
      icon: RiBox3Line,
      group: 'Workloads',
      shortcut: 'g s',
      keywords: ['microvm', 'agents', 'warm pool', 'ttl', 'exec', 'snapshot'],
      description: 'Agent microVMs: warm pools, TTLs, time to ready, exec',
    },
    {
      href: '/rollouts',
      label: 'Rollouts',
      icon: RiRocket2Line,
      group: 'Operations',
      shortcut: 'g r',
      keywords: ['bcd', 'upgrade', 'release', 'waves', 'version'],
      description: 'bcd releases wave by wave, with the failure gate',
    },
    {
      href: '/batches',
      label: 'Command batches',
      icon: RiShieldCheckLine,
      group: 'Operations',
      shortcut: 'g b',
      keywords: ['quorum', 'approve', 'sign', 'destructive', 'power', 'wipe'],
      description: 'Destructive commands waiting for approver signatures',
    },
    {
      href: '/activity',
      label: 'Activity',
      icon: RiTimerFlashLine,
      group: 'Operations',
      shortcut: 'g e',
      keywords: ['events', 'stream', 'watch', 'audit', 'log'],
      description: 'The live event stream, filterable and pausable',
    },
  ],
  widgets: [],
  commands: [
    { id: 'fleet.nodes.attention', label: 'Nodes that need attention', group: 'Fleet', icon: RiAlarmWarningLine, href: '/nodes?preset=attention', keywords: ['incidents', 'broken', 'critical'] },
    { id: 'fleet.nodes.offline', label: 'Offline nodes', group: 'Fleet', icon: RiWifiOffLine, href: '/nodes?health=offline', keywords: ['unreachable', 'lost', 'down'] },
    { id: 'fleet.nodes.racks', label: 'Rack elevations', group: 'Fleet', icon: RiLayoutColumnLine, href: '/nodes?view=racks', keywords: ['datacenter', 'layout', 'units'] },
    { id: 'fleet.nodes.outdated', label: 'Nodes on an old bcd', group: 'Fleet', icon: RiRefreshLine, href: '/nodes?preset=outdated', keywords: ['version', 'upgrade', 'daemon'] },
    { id: 'fleet.metal.pxe', label: 'Machines discovered on PXE', group: 'Fleet', icon: RiRadarLine, href: '/metal', keywords: ['mac', 'unknown', 'confirm'] },
    { id: 'fleet.batches.pending', label: 'Batches awaiting my signature', group: 'Operations', icon: RiShieldCheckLine, href: '/batches', keywords: ['approve', 'quorum'] },
  ],
  search: searchFleet,
  peeks: {
    node: { title: (id) => id.replace(/^n-/, ''), href: (id) => `/nodes/${id}`, icon: RiServerLine, component: NodePeek },
    sandbox: { title: (id) => id, href: (id) => `/sandboxes?sandbox=${id}`, icon: RiBox3Line, component: SandboxPeek },
  },
};
