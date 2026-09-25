import { highlight } from 'fumadocs-core/highlight';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { codeThemes } from '@/lib/code-themes';
import { cx } from '@/utils/cx';
import { ResourceSwitch, type ResourcePane } from './resource-switch';

/**
 * The three kinds of capacity, each with the calls that book it. Checked against the code: reservations.create's
 * validated input (packages/capacity/src/reservations.ts: devices, topology 'any' | 'nvlink-all', duration in ms,
 * binding), flavors (packages/vps/src/flavors.ts: vcpu 1-1024, memoryGiB, diskGiB, gpus 0-16), instances.create
 * (packages/vps), and tunnels.open (packages/server/src/tunnels/module.ts: instances take exec, ssh or tcp and get a
 * single-use `ticket`).
 */
const panes: (Omit<ResourcePane, 'code'> & { source: string })[] = [
  {
    id: 'gpu',
    label: 'GPU',
    unit: 'atoms: whole GPUs, MIG, slots',
    summary:
      'Reserve GPUs for a window of time. A booking holds atoms (whole GPUs, MIG instances or time slots) on one node, prefers complete NVLink sets, and binds them on the node as CDI devices for your own workload manager.',
    specs: [
      ['Booked as', 'device atoms over a time range'],
      ['Guard', 'EXCLUDE on device bookings'],
      ['Topology', "'any' or 'nvlink-all'"],
      ['Metered', 'gpu.<model>.hours to Better IAM'],
    ],
    href: '/docs/guides/capacity/reservations',
    linkLabel: 'GPU reservations',
    source: `const reservation = await client.reservations.create({
  tenantId,
  poolId: 'pool_h100',
  devices: [{ class: 'gpu', count: 4, topology: 'nvlink-all' }],
  duration: 8 * 3_600_000, // 8 h
  binding: 'hold',
  idempotencyKey: crypto.randomUUID(),
});
// One IAM decision on the draft, then four GPUs booked on one node.
// Bound on the node as CDI devices: state 'active'.`,
  },
  {
    id: 'cpu',
    label: 'CPU',
    unit: 'vCPUs, memory, disk',
    summary:
      'Size VMs by vCPUs, memory and disk from flavors a pool owner defines, with no GPU at all. Each instance claims its flavor on one host under that host’s overcommit ratio, counts against quota, and is metered by the hour.',
    specs: [
      ['Booked as', 'scalar claims on one host'],
      ['Guard', 'guarded counters, row locks'],
      ['Flavor', '1-1024 vCPU, memory, disk'],
      ['Metered', 'vps.vcpu.hours, vps.memory.gib.hours'],
    ],
    href: '/docs/guides/vps/flavors',
    linkLabel: 'Flavors',
    source: `await compute.api.flavors.create(cred, {
  tenantId: 'root',
  poolId: 'pool_cpu',
  name: 'c1.large',
  vcpu: 8,
  memoryGiB: 32,
  diskGiB: 80, // gpus defaults to 0
});

const vm = await client.instances.create({
  tenantId,
  poolId: 'pool_cpu',
  flavor: 'c1.large',
  imageId: 'ubuntu-24.04',
  idempotencyKey: 'build-agent-7',
});`,
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    unit: 'isolated VMs',
    summary:
      'Run untrusted code in its own VM. Nothing of the platform runs inside the guest, user data is sealed to its tenant, and access goes through single-use tunnel tickets. Today a sandbox is a VPS instance; a sandboxes API with templates, lifetimes, warm pools of paused VMs and snapshots is planned for v0.5.',
    specs: [
      ['Isolation', 'vm, microvm or container trait'],
      ['Inside', 'no join token, no bcd, no IAM key'],
      ['Access', 'exec, ssh, tcp via tunnels.open'],
      ['Status', 'instances: beta · sandboxes API: v0.5'],
    ],
    href: '/docs/guides/vps/sandboxes',
    linkLabel: 'Sandboxes',
    source: `const sandbox = await client.instances.create({
  tenantId,
  poolId: 'pool_cpu',
  flavor: 'sbx.small',
  imageId: 'ubuntu-24.04',
  idempotencyKey: \`sandbox-\${jobId}\`,
});

const { ticket } = await client.tunnels.open({
  tenantId,
  instanceId: sandbox.id,
  op: 'exec', // or 'ssh', or 'tcp' with a port
});

// …run the job through the tunnel, then tear it down:
await client.instances.delete({ tenantId, instanceId: sandbox.id });`,
  },
];

export async function Resources() {
  const highlighted: ResourcePane[] = await Promise.all(
    panes.map(async ({ source, ...pane }) => ({
      ...pane,
      code: await highlight(source, { lang: 'ts', themes: codeThemes, defaultColor: false }),
    })),
  );
  return (
    <Band id="capacity" unit="01">
      <div className={cx('flex flex-col gap-10 py-16 md:py-20', gutter)}>
        <SectionHeading index="01" eyebrow="Capacity" title="One ledger for GPUs, CPUs and sandboxes">
          Every kind of capacity comes out of the same pools, the same quotas and the same Postgres
          tables, so a GPU reservation and a sandbox can never take what the other holds.
        </SectionHeading>
        <ResourceSwitch panes={highlighted} />
      </div>
    </Band>
  );
}
