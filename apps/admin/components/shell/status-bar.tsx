'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { controlPlane, fmtDuration, fmtNum } from '@/lib/data';
import { collectAttention, modules } from '@/lib/modules';
import { Led } from '@/components/ui/signal';
import { WidgetBoundary } from '@/components/widgets/widget-frame';
import { cx } from '@/utils/cx';
import { useConnection } from './connection';
import { useAcks } from './pins';
import { usePeek } from './peek';
import { useLive, useWorkspace } from './workspace';

/** One status bar readout: a label and a mono value, optionally a button. */
export function StatusItem({
  label,
  value,
  tone,
  onClick,
  href,
  title,
}: {
  label?: ReactNode;
  value: ReactNode;
  tone?: 'signal' | 'crit';
  onClick?: () => void;
  href?: string;
  title?: string;
}) {
  const body = (
    <>
      {label && <span className="text-text-tertiary">{label}</span>}
      <span className={cx('tabular-nums', tone === 'signal' ? 'text-signal' : tone === 'crit' ? 'text-red-500' : 'text-text-secondary')}>{value}</span>
    </>
  );
  const className = 'inline-flex h-full shrink-0 items-center gap-1.5 px-2.5 hover:bg-background-secondary-default/60 hover:text-text-primary';
  if (href)
    return (
      <Link href={href} title={title} className={className}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} title={title} className={className}>
        {body}
      </button>
    );
  return (
    <span title={title} className="inline-flex h-full shrink-0 items-center gap-1.5 px-2.5">
      {body}
    </span>
  );
}

/**
 * The instrument strip at the bottom of every page: where the data comes from, the control plane's vitals,
 * open alerts, the clock mode — and any readouts modules contribute (`AdminModule.status`).
 */
export function StatusBar() {
  const { source, live, now, wallNow, density, setDensity } = useWorkspace();
  const peek = usePeek();
  const { status: connection } = useConnection();
  const components = useLive((t) => controlPlane(t), { bucketMs: 5_000 });
  const items = useLive((t, scope) => collectAttention(t, scope), { bucketMs: 10_000 });
  const acks = useAcks();
  const open = items.filter((item) => !acks.has(item.id));
  const critical = open.filter((item) => item.severity === 'critical').length;
  const api = components.find((c) => c.id === 'api');
  const db = components.find((c) => c.id === 'db');
  const outbox = components.find((c) => c.id === 'events');
  const sessions = components.filter((c) => c.kind === 'gateway').reduce((sum, c) => sum + c.rate, 0);
  const degraded = components.filter((c) => c.status !== 'ok');
  const extras = modules.flatMap((module) => (module.status ?? []).map((Item, index) => ({ key: `${module.id}:${index}`, Item })));

  return (
    <footer data-tour="statusbar" className="hidden h-7 shrink-0 items-stretch divide-x divide-separator-border overflow-x-auto border-t border-separator-border bg-surface-sunken font-mono text-[11px] text-text-secondary sm:flex">
      <StatusItem
        value={
          <span className="inline-flex items-center gap-1.5">
            <Led status={source === 'simulated' ? 'pending' : 'live'} />
            {source === 'simulated' ? 'SIMULATED' : 'LIVE API'}
          </span>
        }
        title={source === 'simulated' ? 'Deterministic simulated fleet; no API calls are made' : 'Connected to the compute API'}
      />
      <StatusItem
        label="api"
        value={!connection ? '…' : !connection.configured ? 'not set' : connection.ok ? `${connection.latencyMs} ms` : 'down'}
        tone={connection?.configured && !connection.ok ? 'crit' : undefined}
        href="/settings#connection"
        title={connection?.url ? `${connection.url}${connection.error ? ` — ${connection.error.message}` : ''}` : 'No compute API configured; the panel is simulated'}
      />
      <StatusItem
        label="control plane"
        value={degraded.length ? `${degraded.length} degraded` : 'nominal'}
        tone={degraded.length ? 'signal' : undefined}
        href="/control-plane"
      />
      {api && <StatusItem label="api p99" value={fmtDuration(api.latencyMs)} onClick={() => peek.open('component', 'api')} tone={api.status === 'ok' ? undefined : 'signal'} />}
      {db && <StatusItem label="db lag" value={fmtDuration(db.latencyMs)} onClick={() => peek.open('component', 'db')} tone={db.status === 'ok' ? undefined : 'signal'} />}
      {outbox && <StatusItem label="outbox" value={fmtDuration(outbox.latencyMs)} onClick={() => peek.open('component', 'events')} />}
      <StatusItem label="sessions" value={fmtNum(sessions)} title="bcd daemon sessions across every gateway" />
      {extras.map(({ key, Item }) => (
        <WidgetBoundary key={key} name={key}>
          <Item />
        </WidgetBoundary>
      ))}
      <span className="flex-1" />
      <StatusItem label="alerts" value={critical ? `${critical} critical · ${open.length}` : open.length} tone={critical ? 'crit' : open.length ? 'signal' : undefined} href="/attention" />
      <StatusItem
        value={live ? 'live' : `−${fmtDuration(wallNow - now)}`}
        tone={live ? undefined : 'signal'}
        title={live ? 'Live; press p to pause, , to step back' : 'Viewing the past; press p for live'}
      />
      <StatusItem value={density} onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')} title="Toggle table density" />
      <StatusItem value="? keys" onClick={() => window.dispatchEvent(new Event('bc-admin:show-shortcuts'))} />
    </footer>
  );
}
