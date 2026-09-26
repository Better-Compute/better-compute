'use client';

import type { ComponentType, ReactNode } from 'react';
import { Button as AriaButton, Menu as AriaMenu, MenuItem, MenuTrigger, Popover, type Selection } from 'react-aria-components';
import { RiArrowDownSLine, RiCheckLine } from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { Led, Tag, type Status } from '@/components/ui/signal';
import type { Connectivity, FleetGpu, FleetNode, ProvisionState, RolloutNodeState, InstanceState, SandboxState } from '@/lib/data/fleet';
import { describeCondition, nodeSeverity } from '@/lib/data/fleet';
import { fmtPct } from '@/lib/data/format';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

// --- Status vocabulary for fleet objects (the instrument rule: grey = quiet, amber = live/needs you, red = broken)

export function nodeStatus(node: FleetNode): Status {
  if (node.connectivity === 'unreachable' || node.connectivity === 'lost') return 'crit';
  if (node.provisionState === 'failed') return 'crit';
  const severity = nodeSeverity(node);
  if (severity === 'critical') return 'crit';
  if (node.connectivity === 'disconnected') return 'off';
  if (node.health === 'provisioning' || ['adopting', 'enrolling', 'inspecting', 'commissioning', 'deploying', 'releasing', 'retiring'].includes(node.provisionState)) return 'pending';
  if (severity === 'warning' || node.conditions.some((c) => c.type === 'Draining')) return 'warn';
  if (node.cordoned || node.maintenance || node.provisionState === 'rescue') return 'off';
  if (node.gpus.some((gpu) => gpu.allocation) || (node.cpu.utilization ?? 0) > 0.2) return 'live';
  return 'ok';
}

export function nodeStatusLabel(node: FleetNode): string {
  if (node.connectivity !== 'connected') return node.connectivity;
  if (node.conditions.some((c) => c.type === 'Draining')) return 'draining';
  if (node.provisionState !== 'deployed' && node.provisionState !== 'adopted') return node.provisionState;
  const severity = nodeSeverity(node);
  if (severity === 'critical' || severity === 'warning') return 'degraded';
  if (node.maintenance) return 'maintenance';
  if (node.cordoned) return 'cordoned';
  return node.gpus.some((gpu) => gpu.allocation) ? 'in use' : 'ready';
}

export const connectivityStatus: Record<Connectivity, Status> = {
  connected: 'ok',
  disconnected: 'off',
  unreachable: 'crit',
  lost: 'crit',
};

export const provisionStatus: Record<ProvisionState, Status> = {
  adopting: 'pending',
  adopted: 'ok',
  enrolling: 'pending',
  inspecting: 'pending',
  commissioning: 'pending',
  ready: 'off',
  deploying: 'pending',
  deployed: 'ok',
  releasing: 'pending',
  rescue: 'warn',
  failed: 'crit',
  retiring: 'pending',
  retired: 'off',
};

export const instanceStatus: Record<InstanceState, Status> = {
  pending: 'pending',
  scheduling: 'pending',
  provisioning: 'pending',
  starting: 'pending',
  running: 'live',
  stopped: 'off',
  rebooting: 'pending',
  resizing: 'pending',
  deleting: 'pending',
  deleted: 'off',
  error: 'crit',
  lost: 'crit',
  paused: 'off',
};

export const sandboxStatus: Record<SandboxState, Status> = {
  starting: 'pending',
  ready: 'live',
  failed: 'crit',
  deleting: 'off',
  deleted: 'off',
};

export const rolloutNodeStatus: Record<RolloutNodeState, Status> = {
  pending: 'off',
  upgrading: 'live',
  succeeded: 'ok',
  failed: 'crit',
  skipped: 'off',
  'rolling-back': 'warn',
  'rolled-back': 'warn',
};

export function NodeStatusTag({ node, className }: { node: FleetNode; className?: string }) {
  return (
    <Tag status={nodeStatus(node)} className={className}>
      {nodeStatusLabel(node)}
    </Tag>
  );
}

/** The node's worst condition in words, plus how many more. */
export function ConditionSummary({ node }: { node: FleetNode }) {
  const active = node.conditions.filter((condition) => condition.status === 'true');
  if (!active.length) return <span className="text-text-tertiary">—</span>;
  const ranked = [...active].sort((a, b) => rank(describeCondition(a.type).severity) - rank(describeCondition(b.type).severity));
  const top = ranked[0]!;
  const severity = describeCondition(top.type).severity;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={ranked.map((c) => `${c.type}: ${c.message ?? ''}`).join('\n')}>
      <Led status={severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'ok'} className="size-1.5" />
      <span className={cx('truncate', severity === 'info' ? 'text-text-secondary' : 'text-text-primary')}>{top.type}</span>
      {ranked.length > 1 && <span className="shrink-0 font-mono text-[11px] text-text-tertiary">+{ranked.length - 1}</span>}
    </span>
  );
}
const rank = (severity: string) => (severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2);

// --- GPU cells ---------------------------------------------------------------------------------------------

/**
 * One square per GPU. Magnitude (utilization) is the amber ramp's opacity; free GPUs are empty outlines;
 * unhealthy ones are hatched with a red edge. Hover names the GPU.
 */
export function GpuCells({ gpus, size = 10, gap = 2, className }: { gpus: readonly FleetGpu[]; size?: number; gap?: number; className?: string }) {
  if (!gpus.length) return <span className="font-mono text-[11px] text-text-tertiary">no GPUs</span>;
  return (
    <span className={cx('inline-flex items-center', className)} style={{ gap }} role="img" aria-label={gpuSummary(gpus)}>
      {gpus.map((gpu) => (
        <GpuCell key={gpu.id} gpu={gpu} size={size} />
      ))}
    </span>
  );
}

export function GpuCell({ gpu, size = 10, onClick, selected }: { gpu: FleetGpu; size?: number; onClick?: () => void; selected?: boolean }) {
  const utilization = gpu.telemetry?.utilization ?? 0;
  const title = [
    `GPU ${gpu.index} · ${gpu.model}`,
    !gpu.healthy ? `UNHEALTHY${gpu.xid ? ` · XID ${gpu.xid.code}` : ''}` : gpu.allocation ? `booked by ${gpu.allocation.tenantId}` : 'free',
    gpu.telemetry ? `${fmtPct(utilization, 0)} util · ${gpu.telemetry.temperatureC}°C · ${gpu.telemetry.powerW} W` : 'no telemetry',
  ].join('\n');
  const Element = onClick ? 'button' : 'span';
  return (
    <Element
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      title={title}
      className={cx(
        'relative inline-block shrink-0',
        !gpu.healthy ? 'hatch border border-red-500' : gpu.allocation ? '' : 'border border-separator-border-strong',
        selected && 'outline outline-1 outline-offset-1 outline-text-primary',
        onClick && 'cursor-pointer',
      )}
      style={{
        width: size,
        height: size,
        ...(gpu.healthy && gpu.allocation
          ? { background: `color-mix(in srgb, var(--color-signal-fill) ${Math.round(35 + utilization * 65)}%, var(--color-surface-sunken))` }
          : {}),
      }}
    />
  );
}

export function gpuSummary(gpus: readonly FleetGpu[]): string {
  const booked = gpus.filter((gpu) => gpu.allocation).length;
  const bad = gpus.filter((gpu) => !gpu.healthy).length;
  return `${gpus.length} GPUs, ${booked} booked${bad ? `, ${bad} unhealthy` : ''}`;
}

/** A thin inline utilization bar with its number (tables). */
export function UtilBar({ value, className, warnAt = 0.9 }: { value: number | undefined; className?: string; warnAt?: number }) {
  if (value === undefined) return <span className="font-mono text-[11px] text-text-tertiary">—</span>;
  return (
    <span className={cx('flex w-full min-w-0 items-center gap-2', className)}>
      <span className="h-1 min-w-6 flex-1 bg-background-secondary-default">
        <span
          className="block h-full transition-[width] duration-500 ease-out"
          style={{ width: `${Math.min(100, value * 100)}%`, background: value >= warnAt ? 'var(--color-signal-fill)' : 'var(--color-text-secondary)' }}
        />
      </span>
      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-text-secondary">{Math.round(value * 100)}%</span>
    </span>
  );
}

// --- Facet menu: multi-select filter chips ------------------------------------------------------------------

export interface FacetOption {
  id: string;
  label: string;
  count?: number;
}

export function FacetMenu({
  label,
  icon: IconComponent,
  options,
  selected,
  onChange,
}: {
  label: string;
  icon?: Icon;
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onChange(next: Set<string>): void;
}) {
  const active = selected.size > 0;
  const names = options.filter((option) => selected.has(option.id)).map((option) => option.label);
  return (
    <MenuTrigger>
      <AriaButton
        className={cx(
          'inline-flex h-8 max-w-64 items-center gap-1.5 border px-2 text-body-2-regular outline-none',
          'focus-visible:ring-2 focus-visible:ring-border-focus-ring',
          active
            ? 'border-signal-fill/50 bg-signal-soft text-text-primary'
            : 'border-dashed border-border-button-default text-text-secondary hover:border-border-button-hover hover:text-text-primary',
        )}
      >
        {IconComponent && <IconComponent className="size-3.5 shrink-0 opacity-70" aria-hidden />}
        <span className="shrink-0">{label}</span>
        {active && (
          <>
            <span className="h-3.5 w-px shrink-0 bg-separator-border-strong" />
            <span className="truncate font-mono text-[11px] text-signal">{names.length > 2 ? `${names.length} selected` : names.join(', ')}</span>
          </>
        )}
        <RiArrowDownSLine className="size-3.5 shrink-0 opacity-60" aria-hidden />
      </AriaButton>
      <Popover placement="bottom start" offset={4} className="min-w-52 border border-separator-border bg-surface-raised p-1 shadow-dropdown outline-none entering:animate-[pop-in_120ms_ease-out]">
        <AriaMenu
          aria-label={label}
          selectionMode="multiple"
          selectedKeys={selected as Selection}
          onSelectionChange={(keys) => onChange(keys === 'all' ? new Set(options.map((o) => o.id)) : new Set([...keys].map(String)))}
          className="max-h-80 overflow-y-auto outline-none"
        >
          {options.map((option) => (
            <MenuItem
              key={option.id}
              id={option.id}
              textValue={option.label}
              className="flex h-8 cursor-default items-center gap-2 px-2 text-body-2-regular text-text-primary outline-none focus:bg-background-secondary-default"
            >
              {({ isSelected }) => (
                <>
                  <span className={cx('grid size-3.5 place-items-center border', isSelected ? 'border-signal-500 bg-signal-500 text-neutral-950' : 'border-border-checkbox-default')}>
                    {isSelected && <RiCheckLine className="size-3" aria-hidden />}
                  </span>
                  <span className="flex-1 truncate">{option.label}</span>
                  {option.count !== undefined && <span className="font-mono text-[11px] tabular-nums text-text-tertiary">{option.count}</span>}
                </>
              )}
            </MenuItem>
          ))}
        </AriaMenu>
        {active && (
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="mt-1 w-full border-t border-separator-border px-2 pt-1.5 pb-1 text-left text-caption-1-regular text-text-secondary hover:text-text-primary"
          >
            Clear {label.toLowerCase()}
          </button>
        )}
      </Popover>
    </MenuTrigger>
  );
}

// --- Small layout helpers ----------------------------------------------------------------------------------------

/** A clickable count chip in a summary strip: "12 offline". Pressing it applies it as a filter. */
export function CountChip({
  status,
  count,
  label,
  active,
  onPress,
}: {
  status: Status;
  count: number;
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={!onPress}
      aria-pressed={active}
      className={cx(
        'inline-flex h-7 items-center gap-2 border px-2 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-border-focus-ring',
        active ? 'border-signal-fill/60 bg-signal-soft' : 'border-separator-border bg-surface-raised hover:border-separator-border-strong',
        count === 0 && !active && 'opacity-50',
      )}
    >
      <Led status={status} />
      <span className="font-mono text-[13px] font-medium tabular-nums text-text-primary">{count}</span>
      <span className="text-caption-1-regular text-text-secondary">{label}</span>
    </button>
  );
}

/** A section label inside detail views. */
export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="font-mono text-[11px] font-medium tracking-wider text-text-tertiary uppercase">{children}</h3>
      <span className="h-px flex-1 bg-separator-border" />
      {action}
    </div>
  );
}

/** A small secondary button used in toolbars, bulk bars and detail headers. */
export function ActionButton({
  icon: IconComponent,
  children,
  onPress,
  danger,
  primary,
  disabled,
  title,
  shortcut,
}: {
  icon?: Icon;
  children: ReactNode;
  onPress?: () => void;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      title={title}
      className={cx(
        'inline-flex h-7 shrink-0 items-center gap-1.5 border px-2 text-caption-1-medium outline-none transition-colors disabled:opacity-40',
        'focus-visible:ring-2 focus-visible:ring-border-focus-ring',
        primary
          ? 'border-signal-500 bg-signal-500 text-neutral-950 hover:bg-signal-400'
          : danger
            ? 'border-red-500/40 text-text-error-primary hover:bg-red-500/10'
            : 'border-border-button-default bg-background-primary-default text-text-primary hover:border-border-button-hover hover:bg-background-secondary-default',
      )}
    >
      {IconComponent && <IconComponent className="size-3.5 shrink-0" aria-hidden />}
      {children}
      {shortcut && <kbd className="ml-0.5 font-mono text-[10px] opacity-60">{shortcut}</kbd>}
    </button>
  );
}
