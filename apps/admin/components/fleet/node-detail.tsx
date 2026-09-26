'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import {
  RiAddLine,
  RiCloseLine,
  RiExternalLinkLine,
  RiFlowChart,
  RiHandHeartLine,
  RiKey2Line,
  RiLockLine,
  RiLockUnlockLine,
  RiPriceTag3Line,
  RiShieldKeyholeLine,
  RiToolsLine,
} from 'react-icons/ri';
import { Tab, TabList, TabPanel, Tabs } from '@/components/base/tabs/tabs';
import { useWorkspace } from '@/components/shell/workspace';
import { Gauge, Sparkline } from '@/components/ui/charts';
import { KeyValue } from '@/components/ui/panel';
import { Led, Mono, SeverityIcon, Tag } from '@/components/ui/signal';
import {
  describeCondition,
  eventsBetween,
  gpuUtilizationSeries,
  type FleetGpu,
  type FleetNode,
  type FleetSnapshot,
} from '@/lib/data/fleet';
import { HOUR } from '@/lib/data/core';
import { fmtDuration, fmtGiB, fmtPct, fmtRelative, fmtStamp } from '@/lib/data/format';
import { poolById, siteById, tenantById } from '@/lib/data/topology';
import { cx } from '@/utils/cx';
import { fleetActions, useFleetActions } from './store';
import {
  ActionButton,
  GpuCell,
  NodeStatusTag,
  SectionLabel,
  connectivityStatus,
  instanceStatus,
  provisionStatus,
  sandboxStatus,
  useConfirm,
} from './ui';

const actionLabel: Record<string, string> = {
  'quarantine-gpu': 'Quarantine the GPU (automatic)',
  'drain-reboot': 'Drain, then reboot the node',
  'drain-gpu-reset': 'Drain, then reset the GPU',
  rma: 'Drain and open an RMA',
};

/** Everything about one node: header actions, then tabs for GPUs, conditions, labels, workloads, events. */
export function NodeDetail({ node, snapshot, compact }: { node: FleetNode; snapshot: FleetSnapshot; compact?: boolean }) {
  const { now } = useWorkspace();
  const [confirm, ask] = useConfirm();
  const pool = node.poolId ? poolById(node.poolId) : undefined;
  const site = siteById(node.siteId);
  const workflow = snapshot.workflows.find((each) => each.nodeId === node.id);
  const instances = snapshot.instances.filter((instance) => instance.nodeId === node.id);
  const sandboxes = snapshot.sandboxes.filter((sandbox) => sandbox.nodeId === node.id);
  const active = node.conditions.filter((condition) => condition.status === 'true');
  const [selectedGpu, setSelectedGpu] = useState<number | undefined>(undefined);

  const cordon = () =>
    ask({
      title: `Cordon ${node.hostname}?`,
      body: 'New reservations, instances and sandboxes stop landing here. Running work is not touched.',
      method: `nodes.cordon { nodeId: "${node.id}", version: ${node.version} }`,
      confirmLabel: 'Cordon',
      reason: true,
      onConfirm: (reason) => fleetActions.cordon([node.id], now, reason || undefined),
    });
  const drain = () =>
    ask({
      title: `Drain ${node.hostname}?`,
      body: (
        <>
          Cordons the node and moves work off it: {node.gpus.filter((gpu) => gpu.allocation).length} booked GPUs, {node.instanceCount} instances and{' '}
          {node.sandboxCount} sandboxes are rescheduled or released under their policies.
        </>
      ),
      method: `nodes.drain { nodeId: "${node.id}" }`,
      confirmLabel: 'Drain node',
      reason: true,
      onConfirm: (reason) => fleetActions.drain([node.id], now, reason || undefined),
    });
  const revoke = () =>
    ask({
      title: 'Revoke this node’s identity?',
      body: 'Every certificate of the current identity generation is revoked and the gateway drops its session. The machine must rejoin with a new join token.',
      method: `nodes.revokeIdentity { nodeId: "${node.id}" }`,
      confirmLabel: 'Revoke identity',
      danger: true,
      reason: true,
      typeToConfirm: node.hostname,
      onConfirm: () => fleetActions.revokeIdentity(node.id, now),
    });

  return (
    <div className="flex flex-col gap-4">
      {confirm}
      <div className="flex flex-wrap items-center gap-2">
        <NodeStatusTag node={node} />
        <Tag status={connectivityStatus[node.connectivity]} led>
          {node.connectivity}
        </Tag>
        <Tag status={provisionStatus[node.provisionState]}>{node.provisionState}</Tag>
        {node.trust !== 'platform' && <Tag status="off">{node.trust}</Tag>}
        {node.noScheduleReasons.map((reason) => (
          <Tag key={reason} status="off" led={false} className="hatch">
            {reason}
          </Tag>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {node.cordoned ? (
          <ActionButton icon={RiLockUnlockLine} onPress={() => fleetActions.uncordon([node.id], now)}>
            Uncordon
          </ActionButton>
        ) : (
          <ActionButton icon={RiLockLine} onPress={cordon}>
            Cordon
          </ActionButton>
        )}
        <ActionButton icon={RiHandHeartLine} onPress={drain} disabled={node.conditions.some((c) => c.type === 'Draining')}>
          Drain
        </ActionButton>
        <ActionButton icon={RiToolsLine} onPress={() => fleetActions.maintenance([node.id], !node.maintenance, now)}>
          {node.maintenance ? 'Leave maintenance' : 'Maintenance'}
        </ActionButton>
        <ActionButton icon={RiKey2Line} title="nodes.issueSshCert: a 15-minute break-glass certificate bound to this node">
          Break-glass SSH
        </ActionButton>
        <ActionButton icon={RiShieldKeyholeLine} danger onPress={revoke}>
          Revoke identity
        </ActionButton>
        {compact && (
          <Link
            href={`/nodes/${node.id}`}
            className="ml-auto inline-flex h-7 items-center gap-1 px-2 text-caption-1-medium text-text-secondary hover:text-text-primary"
          >
            Full page <RiExternalLinkLine className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>

      {node.gpus.length > 0 && <UsageStrip node={node} />}

      <Tabs defaultSelectedKey="overview">
        <TabList aria-label="Node sections" className="overflow-x-auto">
          <Tab id="overview">Overview</Tab>
          {node.gpus.length > 0 && (
            <Tab id="gpus" count={node.gpus.length}>
              GPUs
            </Tab>
          )}
          <Tab id="conditions" count={active.length || undefined}>
            Conditions
          </Tab>
          <Tab id="labels" count={node.labels.length}>
            Labels
          </Tab>
          <Tab id="workloads" count={instances.length + sandboxes.length || undefined}>
            Workloads
          </Tab>
          <Tab id="events">Events</Tab>
          {workflow && <Tab id="workflow">Workflow</Tab>}
        </TabList>

        <TabPanel id="overview" className="flex flex-col gap-5">
          <div>
            <SectionLabel>Placement</SectionLabel>
            <KeyValue
              columns={compact ? 2 : 4}
              items={[
                { label: 'Site', value: site ? `${site.name} (${site.provider})` : node.siteId },
                { label: 'Pool', value: pool ? <Link className="hover:underline" href={`/pools/${pool.id}`}>{pool.name}</Link> : '—' },
                { label: 'Rack / unit', value: `${node.rack} · U${node.unit - node.heightU + 1}–${node.unit}`, mono: true },
                { label: 'Owner', value: tenantById(node.ownerTenantId)?.name ?? node.ownerTenantId },
                { label: 'Role', value: node.role },
                { label: 'Trust', value: node.trust },
                { label: 'Power', value: node.power },
                { label: 'BMC', value: node.bmc ? `${node.bmc.driver} · ${node.bmc.address}` : 'none (adopted)', mono: Boolean(node.bmc) },
              ]}
            />
          </div>
          <div>
            <SectionLabel>Daemon and session</SectionLabel>
            <KeyValue
              columns={compact ? 2 : 4}
              items={[
                { label: 'bcd', value: node.daemonVersion, mono: true },
                {
                  label: 'Generation',
                  value: (
                    <span className={cx(node.observedGeneration < node.generation && 'text-signal')}>
                      {node.observedGeneration} / {node.generation}
                      {node.observedGeneration < node.generation && ' · converging'}
                    </span>
                  ),
                  mono: true,
                },
                { label: 'Identity gen.', value: node.identityGeneration, mono: true },
                { label: 'Hardware key', value: node.hardwareKeyTrusted ? 'TPM-bound' : 'software key' },
                { label: 'Gateway', value: node.session?.gatewayId ?? '—', mono: true },
                { label: 'Session epoch', value: node.session?.epoch ?? '—', mono: true },
                {
                  label: node.connectivity === 'connected' ? 'Connected' : 'Disconnected',
                  value: fmtRelative((node.connectivity === 'connected' ? node.session?.connectedAt : node.session?.disconnectedAt) ?? now, now),
                },
                { label: 'Last seen', value: fmtRelative(node.session?.lastSeen ?? now, now) },
              ]}
            />
          </div>
          <div>
            <SectionLabel>Hardware</SectionLabel>
            <KeyValue
              columns={compact ? 2 : 4}
              items={[
                { label: 'CPU', value: node.cpu.model },
                { label: 'vCPUs', value: node.cpu.vcpus, mono: true },
                { label: 'Memory', value: fmtGiB(node.memoryGiB), mono: true },
                { label: 'GPUs', value: node.gpus.length ? `${node.gpus.length} × ${node.gpus[0]!.attributes.gpuProduct}` : 'none' },
              ]}
            />
          </div>
          <div>
            <SectionLabel>Identity</SectionLabel>
            <KeyValue columns={1} items={[{ label: 'Node id', value: node.id, mono: true }]} />
          </div>
        </TabPanel>

        {node.gpus.length > 0 && (
          <TabPanel id="gpus" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {node.gpus.map((gpu) => (
                <GpuCell key={gpu.id} gpu={gpu} size={22} onClick={() => setSelectedGpu(gpu.index === selectedGpu ? undefined : gpu.index)} selected={gpu.index === selectedGpu} />
              ))}
              <span className="ml-2 text-caption-1-regular text-text-tertiary">click a GPU for its readings</span>
            </div>
            <GpuTable gpus={node.gpus} now={now} highlight={selectedGpu} />
            <p className="text-caption-1-regular text-text-tertiary">
              Utilization, temperature and power are bcd&apos;s OTLP samples (nvidia-smi / NVML), not inventory. Driver{' '}
              <Mono>{String(node.gpus[0]!.attributes.driverVersion)}</Mono>.
            </p>
          </TabPanel>
        )}

        <TabPanel id="conditions">
          {active.length === 0 ? (
            <p className="py-6 text-center text-body-2-regular text-text-tertiary">No active conditions. The node is healthy.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-separator-border border border-separator-border">
              {active.map((condition) => {
                const info = describeCondition(condition.type);
                return (
                  <li key={condition.type} className="flex items-start gap-3 p-3">
                    <SeverityIcon severity={info.severity} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-[13px] text-text-primary">{condition.type}</span>
                        <span className="text-caption-1-regular text-text-tertiary">{info.label}</span>
                      </div>
                      {condition.message && <p className="mt-0.5 text-body-2-regular text-text-secondary">{condition.message}</p>}
                      <p className="mt-1 font-mono text-[11px] text-text-tertiary">
                        since {fmtStamp(condition.since)} · {fmtDuration(now - condition.since)}
                        {info.action && <> · policy: {actionLabel[info.action]}</>}
                      </p>
                    </div>
                    {info.severity !== 'info' && (
                      <ActionButton onPress={() => fleetActions.acknowledge(node.id, condition.type, now)}>Acknowledge</ActionButton>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </TabPanel>

        <TabPanel id="labels">
          <LabelsEditor node={node} />
        </TabPanel>

        <TabPanel id="workloads" className="flex flex-col gap-4">
          {node.gpus.some((gpu) => gpu.allocation) && (
            <div>
              <SectionLabel>GPU reservations</SectionLabel>
              <ul className="flex flex-col gap-1">
                {Object.values(
                  node.gpus.reduce<Record<string, { id: string; tenant: string; gpus: number[]; since: number }>>((acc, gpu) => {
                    if (!gpu.allocation) return acc;
                    const entry = (acc[gpu.allocation.reservationId] ??= { id: gpu.allocation.reservationId, tenant: gpu.allocation.tenantId, gpus: [], since: gpu.allocation.since });
                    entry.gpus.push(gpu.index);
                    return acc;
                  }, {}),
                ).map((reservation) => (
                  <li key={reservation.id} className="flex items-center gap-3 border border-separator-border px-3 py-2">
                    <Led status="live" />
                    <Link href={`/reservations/${reservation.id}`} className="font-mono text-[12px] text-text-primary hover:underline">
                      {reservation.id}
                    </Link>
                    <span className="text-caption-1-regular text-text-secondary">{tenantById(reservation.tenant)?.name ?? reservation.tenant}</span>
                    <span className="ml-auto font-mono text-[11px] text-text-tertiary">
                      GPU {reservation.gpus.join(',')} · {fmtDuration(now - reservation.since)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {instances.length > 0 && (
            <div>
              <SectionLabel>Instances</SectionLabel>
              <ul className="flex flex-col gap-1">
                {instances.map((instance) => (
                  <li key={instance.id} className="flex items-center gap-3 border border-separator-border px-3 py-2">
                    <Led status={instanceStatus[instance.state]} />
                    <Mono>{instance.id}</Mono>
                    <span className="text-caption-1-regular text-text-secondary">{instance.flavor}</span>
                    <span className="ml-auto text-caption-1-regular text-text-tertiary">{tenantById(instance.tenantId)?.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sandboxes.length > 0 && (
            <div>
              <SectionLabel>Sandboxes</SectionLabel>
              <ul className="flex flex-col gap-1">
                {sandboxes.map((sandbox) => (
                  <li key={sandbox.id} className="flex items-center gap-3 border border-separator-border px-3 py-2">
                    <Led status={sandboxStatus[sandbox.state]} />
                    <Mono>{sandbox.id}</Mono>
                    <span className="text-caption-1-regular text-text-secondary">expires {fmtRelative(sandbox.expiresAt, now)}</span>
                    <span className="ml-auto text-caption-1-regular text-text-tertiary">{tenantById(sandbox.tenantId)?.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!node.gpus.some((gpu) => gpu.allocation) && !instances.length && !sandboxes.length && (
            <p className="py-6 text-center text-body-2-regular text-text-tertiary">Nothing runs on this node right now.</p>
          )}
        </TabPanel>

        <TabPanel id="events">
          <NodeEvents node={node} snapshot={snapshot} />
        </TabPanel>

        {workflow && (
          <TabPanel id="workflow">
            <WorkflowSteps workflow={workflow} now={now} />
          </TabPanel>
        )}
      </Tabs>
    </div>
  );
}

function UsageStrip({ node }: { node: FleetNode }) {
  const live = node.gpus.filter((gpu) => gpu.telemetry);
  const avg = (pick: (gpu: FleetGpu) => number) => (live.length ? live.reduce((sum, gpu) => sum + pick(gpu), 0) / live.length : 0);
  const power = live.reduce((sum, gpu) => sum + gpu.telemetry!.powerW, 0);
  const limit = node.gpus.reduce((sum, gpu) => sum + (gpu.telemetry?.powerLimitW ?? 0), 0);
  const hottest = live.reduce((max, gpu) => Math.max(max, gpu.telemetry!.temperatureC), 0);
  return (
    <div className="grid grid-cols-2 gap-3 border border-separator-border bg-surface-sunken p-3 sm:grid-cols-4">
      <div className="flex items-center gap-3">
        <Gauge ratio={avg((gpu) => gpu.telemetry!.utilization)} size={64} label="GPU" />
      </div>
      <div className="flex items-center gap-3">
        <Gauge ratio={avg((gpu) => gpu.telemetry!.memoryUsed)} size={64} label="VRAM" tone="neutral" />
      </div>
      <div className="flex items-center gap-3">
        <Gauge ratio={node.cpu.utilization ?? 0} size={64} label="CPU" tone="neutral" />
      </div>
      <div className="flex flex-col justify-center gap-1 font-mono text-[11px] text-text-secondary">
        <span>
          <span className="text-[18px] text-text-primary tabular-nums">{(power / 1000).toFixed(1)}</span> kW
        </span>
        <span className="text-text-tertiary">of {(limit / 1000).toFixed(1)} kW cap</span>
        <span className={cx(hottest >= 80 ? 'text-signal' : 'text-text-tertiary')}>hottest {hottest || '—'}°C</span>
      </div>
    </div>
  );
}

function GpuTable({ gpus, now, highlight }: { gpus: readonly FleetGpu[]; now: number; highlight?: number }) {
  return (
    <div className="overflow-x-auto border border-separator-border">
      <table className="w-full border-collapse text-left">
        <thead className="bg-surface-sunken">
          <tr className="border-b border-separator-border font-mono text-[10px] tracking-wider text-text-tertiary uppercase">
            <th className="px-2 py-1.5">GPU</th>
            <th className="px-2 py-1.5">State</th>
            <th className="w-32 px-2 py-1.5">Util · 20 min</th>
            <th className="px-2 py-1.5 text-right">VRAM</th>
            <th className="px-2 py-1.5 text-right">Temp</th>
            <th className="px-2 py-1.5 text-right">Power</th>
            <th className="px-2 py-1.5">Held by</th>
          </tr>
        </thead>
        <tbody>
          {gpus.map((gpu) => (
            <tr key={gpu.id} className={cx('border-b border-separator-border/60 text-body-2-regular last:border-0', highlight === gpu.index && 'bg-signal-soft')}>
              <td className="px-2 py-1.5">
                <div className="font-mono text-[12px] text-text-primary">#{gpu.index}</div>
                <div className="font-mono text-[10px] text-text-tertiary" title={gpu.uuid}>
                  {String(gpu.attributes.pciBusId)}
                </div>
              </td>
              <td className="px-2 py-1.5">
                {!gpu.healthy ? (
                  <Tag status="crit">{gpu.xid ? `XID ${gpu.xid.code}` : gpu.eccUncorrectable ? `ECC ×${gpu.eccUncorrectable}` : 'unhealthy'}</Tag>
                ) : gpu.allocation ? (
                  <Tag status="live">booked</Tag>
                ) : (
                  <Tag status="ok">free</Tag>
                )}
              </td>
              <td className="px-2 py-1.5">
                {gpu.telemetry ? (
                  <div className="flex items-center gap-2">
                    <Sparkline values={gpuUtilizationSeries(gpu, now)} height={18} max={1} min={0} tone={gpu.allocation ? 'signal' : 'muted'} />
                    <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-text-secondary">{fmtPct(gpu.telemetry.utilization, 0)}</span>
                  </div>
                ) : (
                  <span className="font-mono text-[11px] text-text-tertiary">—</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-[12px] tabular-nums text-text-secondary">
                {gpu.telemetry ? `${Math.round(gpu.telemetry.memoryUsed * gpu.vramGiB)} / ${gpu.vramGiB}G` : `${gpu.vramGiB}G`}
              </td>
              <td className={cx('px-2 py-1.5 text-right font-mono text-[12px] tabular-nums', (gpu.telemetry?.temperatureC ?? 0) >= 80 ? 'text-signal' : 'text-text-secondary')}>
                {gpu.telemetry ? `${gpu.telemetry.temperatureC}°` : '—'}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-[12px] tabular-nums text-text-secondary">{gpu.telemetry ? `${gpu.telemetry.powerW} W` : '—'}</td>
              <td className="px-2 py-1.5 text-caption-1-regular text-text-secondary">
                {gpu.allocation ? tenantById(gpu.allocation.tenantId)?.name ?? gpu.allocation.tenantId : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LabelsEditor({ node }: { node: FleetNode }) {
  const { now } = useWorkspace();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [taint, setTaint] = useState('');
  const bySource = (source: string) => node.labels.filter((label) => label.source === source);
  const taints = node.noScheduleReasons.filter((reason) => reason.startsWith('taint:')).map((reason) => reason.slice(6));
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/.test(key) && !key.startsWith('bc.dev/');
  const group = (title: string, source: string, note: ReactNode, removable: boolean) => (
    <div>
      <SectionLabel>{title}</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {bySource(source).map((label) => (
          <span key={label.key} className="inline-flex h-6 items-center gap-1 border border-separator-border bg-surface-sunken pl-1.5 font-mono text-[11px]">
            <span className="text-text-tertiary">{label.key}=</span>
            <span className="text-text-primary">{label.value}</span>
            {removable ? (
              <button type="button" aria-label={`Remove ${label.key}`} onClick={() => fleetActions.label([node.id], {}, [label.key], now)} className="grid h-full w-5 place-items-center text-text-tertiary hover:text-text-primary">
                <RiCloseLine className="size-3" aria-hidden />
              </button>
            ) : (
              <span className="w-1.5" />
            )}
          </span>
        ))}
        {bySource(source).length === 0 && <span className="text-caption-1-regular text-text-tertiary">none</span>}
      </div>
      <p className="mt-1 text-caption-1-regular text-text-tertiary">{note}</p>
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      {group('Operator labels', 'operator', 'Yours to set; placement matches them with nodeLabels.', true)}
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          fleetActions.label([node.id], { [key]: value }, [], now);
          setKey('');
          setValue('');
        }}
      >
        <RiPriceTag3Line className="size-4 text-text-tertiary" aria-hidden />
        <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="key" aria-label="Label key" className="h-7 w-36 border border-border-button-default bg-background-primary-default px-2 font-mono text-[12px] outline-none focus:border-signal-500" />
        <span className="font-mono text-text-tertiary">=</span>
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="value" aria-label="Label value" className="h-7 w-36 border border-border-button-default bg-background-primary-default px-2 font-mono text-[12px] outline-none focus:border-signal-500" />
        <ActionButton icon={RiAddLine} disabled={!valid}>
          Set label
        </ActionButton>
        {key.startsWith('bc.dev/') && <span className="text-caption-1-regular text-text-error-primary">bc.dev/ labels are system-only</span>}
      </form>
      {group('Inventory labels', 'inventory', 'From the last inventory report; they change with the hardware.', false)}
      {group('System labels', 'system', 'Written by the gateway from Hello capabilities and drivers.', false)}
      <div>
        <SectionLabel>Taints (NoSchedule)</SectionLabel>
        <div className="flex flex-wrap items-center gap-1.5">
          {taints.map((name) => (
            <span key={name} className="hatch inline-flex h-6 items-center gap-1 border border-separator-border pl-1.5 font-mono text-[11px] text-text-primary">
              {name}
              <button type="button" aria-label={`Remove taint ${name}`} onClick={() => fleetActions.taint([node.id], [], [name], now)} className="grid h-full w-5 place-items-center text-text-tertiary hover:text-text-primary">
                <RiCloseLine className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!taint.trim()) return;
              fleetActions.taint([node.id], [taint.trim()], [], now);
              setTaint('');
            }}
          >
            <input value={taint} onChange={(event) => setTaint(event.target.value)} placeholder="add taint" aria-label="Taint" className="h-6 w-32 border border-border-button-default bg-background-primary-default px-2 font-mono text-[11px] outline-none focus:border-signal-500" />
          </form>
        </div>
        <p className="mt-1 text-caption-1-regular text-text-tertiary">
          Stored as <Mono dim>taint:&lt;key&gt;</Mono>; a <Mono dim>dedicated=&lt;tenant&gt;</Mono> taint is tolerated only by that tenant.
        </p>
      </div>
    </div>
  );
}

function NodeEvents({ node, snapshot }: { node: FleetNode; snapshot: FleetSnapshot }) {
  const { now } = useWorkspace();
  const actions = useFleetActions();
  const bucket = Math.floor(now / 10_000) * 10_000;
  const events = useMemo(() => {
    const simulated = eventsBetween(snapshot, bucket - 6 * HOUR, bucket, 20_000).filter((event) => event.subject === `node/${node.id}`);
    const operator = actions.audit
      .filter((entry) => entry.subject === `node/${node.id}`)
      .map((entry) => ({ id: entry.id, type: `operator.${entry.method}`, time: new Date(entry.at).toISOString(), data: { summary: entry.summary } as Record<string, unknown> }));
    const conditions = node.conditions.map((condition) => ({
      id: `cond:${condition.type}`,
      type: 'node.condition.changed',
      time: new Date(condition.since).toISOString(),
      data: { condition: condition.type, status: condition.status, message: condition.message } as Record<string, unknown>,
    }));
    return [...simulated, ...operator, ...conditions].sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 60);
  }, [snapshot, bucket, node, actions.audit]);
  if (!events.length) return <p className="py-6 text-center text-body-2-regular text-text-tertiary">No events for this node in the last 6 hours.</p>;
  return (
    <ol className="relative flex flex-col border-l border-separator-border pl-4">
      {events.map((event) => (
        <li key={event.id} className="relative py-1.5">
          <span className={cx('absolute top-3 -left-[21px] size-2 rounded-full border-2 border-background-full', event.type.startsWith('operator.') ? 'bg-signal-fill' : event.type.includes('condition') ? 'bg-text-secondary' : 'bg-separator-border-strong')} />
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[12px] text-text-primary">{event.type}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-text-tertiary">{fmtRelative(Date.parse(event.time), now)}</span>
          </div>
          <div className="truncate font-mono text-[11px] text-text-tertiary">
            {typeof event.data.summary === 'string'
              ? event.data.summary
              : Object.entries(event.data)
                  .filter(([k]) => k !== 'hostname' && k !== 'siteId')
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(' ')}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function WorkflowSteps({ workflow, now }: { workflow: FleetSnapshot['workflows'][number]; now: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <RiFlowChart className="size-4 text-text-tertiary" aria-hidden />
        <span className="font-mono text-[13px] text-text-primary">
          {workflow.profileId} v{workflow.profileVersion}
        </span>
        <Tag status={workflow.state === 'failed' ? 'crit' : workflow.state === 'running' ? 'live' : 'ok'}>{workflow.state}</Tag>
        <span className="ml-auto font-mono text-[11px] text-text-tertiary">
          started {fmtRelative(workflow.createdAt, now)} · <Mono dim>{workflow.id}</Mono>
        </span>
      </div>
      <ol className="flex flex-col">
        {workflow.steps.map((step, index) => {
          const status = step.state === 'succeeded' ? 'ok' : step.state === 'failed' ? 'crit' : step.state === 'running' || step.state === 'waiting' ? 'live' : 'off';
          return (
            <li key={step.id} className="flex items-stretch gap-3">
              <div className="flex w-3 flex-col items-center">
                <Led status={status} className="mt-2.5" />
                {index < workflow.steps.length - 1 && <span className={cx('w-px flex-1', step.state === 'succeeded' ? 'bg-text-tertiary' : 'bg-separator-border')} />}
              </div>
              <div className="flex min-w-0 flex-1 items-baseline gap-2 border-b border-separator-border/60 py-2">
                <span className="font-mono text-[12px] text-text-primary">{step.action}</span>
                {step.driver && <span className="text-caption-1-regular text-text-tertiary">{step.driver}</span>}
                <span className="border border-separator-border px-1 font-mono text-[10px] text-text-tertiary">{step.runsOn}</span>
                {step.attempt > 1 && <span className="font-mono text-[10px] text-signal">attempt {step.attempt}</span>}
                <span className="ml-auto shrink-0 font-mono text-[11px] text-text-tertiary">
                  {step.state === 'pending'
                    ? 'pending'
                    : step.finishedAt
                      ? fmtDuration(step.finishedAt - (step.startedAt ?? step.finishedAt))
                      : step.state === 'failed'
                        ? 'failed'
                        : `${step.state} · ${fmtDuration(now - (step.startedAt ?? now))}`}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
