import type { ReactNode } from 'react';
import { RiAlarmWarningFill, RiErrorWarningFill, RiInformationFill } from 'react-icons/ri';
import { cx } from '@/utils/cx';

// Status vocabulary. The instrument theme keeps ONE signal hue (thermal amber) for things that are live, booked
// or need an operator; failures use BoardUI's error red; everything healthy stays graphite. So a screen that is
// all grey is a quiet fleet, amber is where the work is, and red is what's broken.

export type Status = 'live' | 'ok' | 'warn' | 'crit' | 'off' | 'pending';

const ledStyles: Record<Status, string> = {
  live: 'bg-signal-fill shadow-[0_0_0_3px_var(--color-signal-soft)]',
  ok: 'bg-neutral-400 dark:bg-neutral-300',
  warn: 'bg-signal-fill',
  crit: 'bg-red-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-red-500)_22%,transparent)]',
  off: 'border border-neutral-400 bg-transparent dark:border-neutral-500',
  pending: 'border border-signal-fill bg-transparent',
};

/** A status LED. `live` pulses (unless reduced motion). */
export function Led({ status, className, label }: { status: Status; className?: string; label?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx(
        'inline-block size-2 shrink-0 rounded-full',
        ledStyles[status],
        status === 'live' && 'motion-safe:animate-[led-pulse_2s_ease-in-out_infinite]',
        className,
      )}
    />
  );
}

const tagStyles: Record<Status, string> = {
  live: 'border-signal-fill/40 bg-signal-soft text-signal',
  ok: 'border-separator-border bg-background-secondary-default text-text-secondary',
  warn: 'border-signal-fill/50 bg-signal-soft text-signal',
  crit: 'border-red-500/40 bg-red-500/10 text-text-error-primary',
  off: 'border-separator-border bg-transparent text-text-tertiary',
  pending: 'border-dashed border-signal-fill/60 bg-transparent text-signal',
};

/** A compact mono status tag with its LED: <Tag status="live">active</Tag>. */
export function Tag({
  status = 'ok',
  children,
  className,
  led = true,
}: {
  status?: Status;
  children: ReactNode;
  className?: string;
  led?: boolean;
}) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center gap-1.5 border px-1.5 font-mono text-[11px] leading-none whitespace-nowrap',
        tagStyles[status],
        className,
      )}
    >
      {led && <Led status={status} className="size-1.5" />}
      {children}
    </span>
  );
}

export type Severity = 'critical' | 'warning' | 'info';

export const severityStatus: Record<Severity, Status> = { critical: 'crit', warning: 'warn', info: 'ok' };

export function SeverityIcon({ severity, className }: { severity: Severity; className?: string }) {
  const Icon =
    severity === 'critical' ? RiAlarmWarningFill : severity === 'warning' ? RiErrorWarningFill : RiInformationFill;
  return (
    <Icon
      aria-label={severity}
      className={cx(
        'size-4 shrink-0',
        severity === 'critical' && 'text-red-500',
        severity === 'warning' && 'text-signal',
        severity === 'info' && 'text-text-tertiary',
        className,
      )}
    />
  );
}

/** Mono id chip (node ids, reservation ids): selectable, never wraps. */
export function Mono({ children, className, dim }: { children: ReactNode; className?: string; dim?: boolean }) {
  return (
    <span className={cx('font-mono text-[12px] tabular-nums whitespace-nowrap', dim ? 'text-text-tertiary' : 'text-text-primary', className)}>
      {children}
    </span>
  );
}
