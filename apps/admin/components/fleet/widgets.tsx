'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EntityLink, usePeek } from '@/components/shell/peek';
import { useNow } from '@/components/shell/workspace';
import { StackedBar } from '@/components/ui/charts';
import { Led, Mono, Tag } from '@/components/ui/signal';
import { MINUTE } from '@/lib/data/core';
import { rolloutNodeStates, type FleetGpu, type FleetNode } from '@/lib/data/fleet';
import { fmtDuration, fmtNum, fmtPct, fmtRelative } from '@/lib/data/format';
import { pools } from '@/lib/data/topology';
import type { WidgetProps } from '@/lib/modules';
import { cx } from '@/utils/cx';
import { ConditionSummary, nodeStatus, nodeStatusLabel } from './ui';
import { warmIdle } from './sandboxes-page';
import { useFleet } from './use-fleet';

// Overview widgets from the fleet module. Each renders only its body inside the shell's WidgetFrame and reads
// the fleet at the workspace clock and site scope, like the pages.

const HEALTH = [
  { key: 'ready', label: 'ready', tone: 'neutral' },
  { key: 'degraded', label: 'degraded', tone: 'signal' },
  { key: 'provisioning', label: 'provisioning', tone: 'hatch' },
  { key: 'offline', label: 'offline', tone: 'crit' },
] as const;

/** fleet.health: node health per pool; each row links to /nodes filtered to it. */
export function HealthWidget({ settings }: WidgetProps) {
  const snapshot = useFleet();
  const kind = String(settings.kind ?? 'all');
  const rows = snapshot.pools
    .filter((pool) => kind === 'all' || pool.kind === kind)
    .map((pool) => {
      const members = snapshot.nodes.filter((node) => node.poolId === pool.id);
      const counts = { ready: 0, degraded: 0, provisioning: 0, offline: 0 };
      for (const node of members) counts[node.health] += 1;
      return { pool, members, counts };
    })
    .filter((row) => row.members.length);
  return (
    <ul className="flex h-full flex-col gap-2 overflow-y-auto">
      {rows.map(({ pool, members, counts }) => (
        <li key={pool.id}>
          <Link href={`/nodes?pool=${pool.id}`} className="group flex flex-col gap-1">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-caption-1-medium text-text-primary group-hover:underline">{pool.name}</span>
              <span className="ml-auto flex shrink-0 gap-2 font-mono text-[11px] tabular-nums">
                <span className="text-text-secondary">
                  {counts.ready}/{members.length}
                </span>
                {counts.degraded > 0 && <span className="text-signal">{counts.degraded} deg</span>}
                {counts.offline > 0 && <span className="text-red-500">{counts.offline} off</span>}
              </span>
            </span>
            <StackedBar height={5} parts={HEALTH.map((h) => ({ label: h.label, value: counts[h.key], tone: h.tone }))} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function gpuTone(gpu: FleetGpu, mode: string): string | undefined {
  if (!gpu.healthy) return undefined;
  const value = mode === 'temp' ? Math.max(0, ((gpu.telemetry?.temperatureC ?? 30) - 30) / 55) : (gpu.telemetry?.utilization ?? 0);
  if (!gpu.telemetry || value < 0.02) return undefined;
  return `color-mix(in srgb, var(--color-signal-fill) ${Math.round(25 + value * 75)}%, var(--color-surface-sunken))`;
}

/** fleet.gpu-wall: every GPU as one cell (load or temperature), unhealthy ones outlined red. */
export function GpuWallWidget({ settings }: WidgetProps) {
  const snapshot = useFleet();
  const peek = usePeek();
  const mode = String(settings.color ?? 'util');
  const onlyBad = Boolean(settings.unhealthyOnly);
  const nodes = snapshot.nodes.filter((node) => node.gpus.length && (!onlyBad || node.gpus.some((gpu) => !gpu.healthy)));
  const bad = snapshot.nodes.flatMap((node) => node.gpus).filter((gpu) => !gpu.healthy).length;
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-3 font-mono text-[11px] text-text-tertiary">
        <span>{fmtNum(nodes.reduce((sum, node) => sum + node.gpus.length, 0))} GPUs</span>
        <span className={cx(bad && 'text-red-500')}>{bad} unhealthy</span>
        <span className="ml-auto">{mode === 'temp' ? 'fill = temperature' : 'fill = utilization'}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-wrap content-start gap-[3px] overflow-y-auto">
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => peek.open('node', node.id)}
            title={`${node.hostname} · ${nodeStatusLabel(node)}`}
            className={cx('grid grid-cols-4 gap-px p-px outline-none hover:ring-1 hover:ring-text-primary', node.connectivity !== 'connected' && 'opacity-40')}
          >
            {node.gpus.map((gpu) => (
              <span
                key={gpu.id}
                className={cx('size-[7px]', !gpu.healthy ? 'hatch border border-red-500' : !gpu.telemetry ? 'bg-background-secondary-default' : '')}
                style={gpuTone(gpu, mode) ? { background: gpuTone(gpu, mode) } : gpu.healthy && gpu.telemetry ? { background: 'var(--color-background-secondary-default)' } : undefined}
              />
            ))}
          </button>
        ))}
      </div>
    </div>
  );
}

const rank = (node: FleetNode) => {
  const status = nodeStatus(node);
  return status === 'crit' ? 0 : status === 'warn' ? 1 : status === 'pending' ? 2 : 3;
};

/** fleet.unhealthy: the worst nodes first, with their top condition. */
export function UnhealthyWidget({ settings, size }: WidgetProps) {
  const snapshot = useFleet();
  const now = useNow(5_000);
  const includeWarnings = settings.warnings !== false;
  const nodes = useMemo(
    () =>
      snapshot.nodes
        .filter((node) => {
          const status = nodeStatus(node);
          return status === 'crit' || (includeWarnings && status === 'warn');
        })
        .sort((a, b) => rank(a) - rank(b) || (b.conditions[0]?.since ?? 0) - (a.conditions[0]?.since ?? 0)),
    [snapshot.nodes, includeWarnings],
  );
  const limit = Math.max(3, size.h * 2 - 1);
  if (!nodes.length) return <p className="grid h-full place-items-center text-body-2-regular text-text-tertiary">Every node is healthy.</p>;
  return (
    <div className="flex h-full flex-col">
      <ul className="min-h-0 flex-1 divide-y divide-separator-border/60 overflow-y-auto">
        {nodes.slice(0, limit).map((node) => {
          const worst = node.conditions.find((c) => c.status === 'true');
          return (
            <li key={node.id} className={cx('flex items-center gap-2 py-1.5 pl-2', nodeStatus(node) === 'crit' ? 'shadow-[inset_2px_0_0_var(--color-red-500)]' : 'shadow-[inset_2px_0_0_var(--color-signal-fill)]')}>
              <EntityLink kind="node" id={node.id} className="w-32 shrink-0 truncate">
                {node.hostname}
              </EntityLink>
              <span className="min-w-0 flex-1 text-caption-1-regular">
                <ConditionSummary node={node} />
              </span>
              <span className="shrink-0 font-mono text-[10px] text-text-tertiary">{worst ? fmtRelative(worst.since, now) : ''}</span>
            </li>
          );
        })}
      </ul>
      {nodes.length > limit && (
        <Link href="/nodes?preset=attention" className="pt-1 font-mono text-[11px] text-text-tertiary hover:text-text-primary">
          +{nodes.length - limit} more →
        </Link>
      )}
    </div>
  );
}

/** fleet.rollout: the running bcd rollout by wave. */
export function RolloutWidget() {
  const snapshot = useFleet();
  const now = useNow(5_000);
  const rollout = snapshot.rollouts.find((each) => each.state === 'running' || each.state === 'paused');
  if (!rollout) return <p className="grid h-full place-items-center text-body-2-regular text-text-tertiary">No rollout running.</p>;
  const total = rollout.nodeList.length;
  const done = rollout.nodes.succeeded;
  return (
    <Link href="/rollouts" className="flex h-full flex-col gap-2">
      <span className="flex items-center gap-2">
        <Mono>bcd {rollout.version}</Mono>
        <Tag status={rollout.state === 'running' ? 'live' : 'warn'}>{rollout.state}</Tag>
        <span className="ml-auto font-mono text-[11px] text-text-tertiary">
          wave {rollout.wave + 1}/{rollout.waves.length} · {fmtRelative(rollout.createdAt, now)}
        </span>
      </span>
      <StackedBar
        height={8}
        parts={rolloutNodeStates.map((state) => ({
          label: state,
          value: rollout.nodes[state],
          tone: state === 'succeeded' ? 'neutral' : state === 'upgrading' ? 'signal' : state === 'failed' ? 'crit' : state === 'pending' ? 'muted' : 'hatch',
        }))}
      />
      <span className="font-mono text-[11px] text-text-secondary">
        {done}/{total} upgraded · {fmtPct(done / (total || 1), 0)}
        {rollout.nodes.failed > 0 && <span className="text-red-500"> · {rollout.nodes.failed} failed</span>}
      </span>
      <div className="grid grid-cols-4 gap-1">
        {rollout.waves.map((pct, index) => (
          <span key={index} className={cx('border px-1 py-0.5 text-center font-mono text-[10px]', index === rollout.wave ? 'border-signal-fill/60 bg-signal-soft text-text-primary' : index < rollout.wave ? 'border-separator-border text-text-secondary' : 'border-dashed border-separator-border text-text-tertiary')}>
            {pct}%
          </span>
        ))}
      </div>
    </Link>
  );
}

/** fleet.sandboxes: live, starting and warm-idle sandboxes, and how many expire soon. */
export function SandboxesWidget() {
  const snapshot = useFleet();
  const now = useNow(5_000);
  const ready = snapshot.sandboxes.filter((s) => s.state === 'ready').length;
  const starting = snapshot.sandboxes.filter((s) => s.state === 'starting').length;
  const idle = snapshot.templates.reduce((sum, template) => sum + warmIdle(template, now), 0);
  const expiring = snapshot.sandboxes.filter((s) => s.state === 'ready' && s.expiresAt - now < 5 * MINUTE).length;
  const recent = snapshot.sandboxes.filter((s) => now - s.createdAt < 30 * MINUTE);
  const warm = recent.filter((s) => s.warm).length;
  const item = (label: string, value: string, tone?: string) => (
    <div className="flex flex-col">
      <span className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">{label}</span>
      <span className={cx('font-mono text-[20px] leading-7 tabular-nums', tone ?? 'text-text-primary')}>{value}</span>
    </div>
  );
  return (
    <Link href="/sandboxes" className="grid h-full grid-cols-3 content-center gap-3">
      {item('live', fmtNum(ready))}
      {item('starting', fmtNum(starting))}
      {item('warm idle', fmtNum(idle), 'text-signal')}
      {item('warm hits', recent.length ? fmtPct(warm / recent.length, 0) : '—')}
      {item('expiring', fmtNum(expiring), expiring ? 'text-signal' : undefined)}
      {item('templates', fmtNum(snapshot.templates.length))}
    </Link>
  );
}

/** fleet.batches: quorum batches waiting for signatures. */
export function BatchesWidget() {
  const snapshot = useFleet();
  const now = useNow(5_000);
  const pending = snapshot.batches.filter((batch) => batch.state === 'pending');
  if (!pending.length) return <p className="grid h-full place-items-center text-body-2-regular text-text-tertiary">Nothing awaits a signature.</p>;
  return (
    <ul className="flex h-full flex-col gap-1.5 overflow-y-auto">
      {pending.map((batch) => (
        <li key={batch.batchId}>
          <Link href="/batches" className="flex flex-col gap-0.5 border border-signal-fill/30 px-2 py-1.5 hover:bg-signal-soft">
            <span className="flex items-center gap-2">
              <Led status="pending" />
              <span className="truncate text-caption-1-medium text-text-primary">{batch.reason}</span>
            </span>
            <span className="font-mono text-[10px] text-text-tertiary">
              {batch.members[0]?.kind} × {batch.scopeSize} · {batch.approvals.length}/{batch.requiredApprovals} signed · expires in {fmtDuration(Math.max(0, batch.notAfter - now))}
              {batch.createdByAgent && ` · by ${batch.createdByAgent}`}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export const poolKindOptions = [
  { value: 'all', label: 'All pools' },
  ...[...new Set(pools.map((pool) => pool.kind))].map((kind) => ({ value: kind, label: `${kind.toUpperCase()} pools` })),
];

