'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RiFileCopyLine, RiPauseLine, RiPlayLine, RiSearchLine, RiTimerFlashLine } from 'react-icons/ri';
import { useWorkspace } from '@/components/shell/workspace';
import { Sparkline } from '@/components/ui/charts';
import { useFeedback } from '@/components/ui/feedback';
import { Drawer } from '@/components/ui/overlay';
import { PageHeader, Panel } from '@/components/ui/panel';
import { Led, Mono, type Status } from '@/components/ui/signal';
import { eventsBetween, type ComputeEvent } from '@/lib/data/fleet';
import { MINUTE } from '@/lib/data/core';
import { fmtClock, fmtNum, fmtRelative } from '@/lib/data/format';
import { tenantById } from '@/lib/data/topology';
import { cx } from '@/utils/cx';
import { auditEvents, useFleetActions } from './store';
import { useFleet } from './use-fleet';

// The event stream as `events.list` / the SSE `/watch` endpoint delivers it: newest first, filterable by family,
// pausable (the list freezes while new events keep counting), each event openable as its raw envelope.

const FAMILIES = ['node', 'sandbox', 'reservation', 'instance', 'workflow', 'command', 'rollout', 'security', 'operator'] as const;
type Family = (typeof FAMILIES)[number];

const familyOf = (event: ComputeEvent): Family => {
  const head = event.type.split('.')[0]!;
  return (FAMILIES as readonly string[]).includes(head) ? (head as Family) : 'node';
};

export function eventStatus(event: ComputeEvent): Status {
  if (event.type.startsWith('operator.')) return 'live';
  if (event.type.startsWith('security.') || /failed|lost|unreachable|refused|revoked|escalated/.test(event.type)) return 'crit';
  if (/condition|remediation|disconnected|preempt|expiring/.test(event.type)) return 'warn';
  if (/created|placed|queued|started|issued|provisioning|starting/.test(event.type)) return 'pending';
  return 'ok';
}

/** "node/n-fra1-h100-001" → a link where the admin has a page for it. */
export function SubjectLink({ subject, className }: { subject: string; className?: string }) {
  const [kind, id] = subject.split('/') as [string, string | undefined];
  const href =
    kind === 'node' && id ? `/nodes/${id}` : kind === 'reservation' && id ? `/reservations?id=${id}` : kind === 'sandbox' ? '/sandboxes' : kind === 'rollout' ? '/rollouts' : kind === 'commandBatch' ? '/batches' : kind === 'workflow' ? '/metal' : undefined;
  const text = (
    <>
      <span className="text-text-tertiary">{kind}/</span>
      {id ?? ''}
    </>
  );
  return href ? (
    <Link href={href} onClick={(event) => event.stopPropagation()} className={cx('truncate font-mono text-[12px] text-text-primary hover:underline', className)}>
      {text}
    </Link>
  ) : (
    <span className={cx('truncate font-mono text-[12px] text-text-primary', className)}>{text}</span>
  );
}

function summary(event: ComputeEvent): string {
  if (typeof event.data.summary === 'string') return event.data.summary;
  return Object.entries(event.data)
    .filter(([key]) => key !== 'siteId')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join('  ');
}

export function ActivityPage() {
  const snapshot = useFleet({ scoped: false });
  const { now, siteId } = useWorkspace();
  const actions = useFleetActions();
  const { toast } = useFeedback();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pausedAt, setPausedAt] = useState<number | undefined>(undefined);
  const [text, setText] = useState('');
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const families = useMemo(() => new Set((params.get('family') ?? '').split(',').filter(Boolean)), [params]);
  const setFamilies = (next: Set<string>) => {
    const search = new URLSearchParams(params.toString());
    if (next.size) search.set('family', [...next].join(','));
    else search.delete('family');
    router.replace(search.toString() ? `${pathname}?${search}` : pathname, { scroll: false });
  };

  // Stable 10 s buckets for history so the list only grows at its head.
  const until = pausedAt ?? now;
  const windowMs = 30 * MINUTE;
  const all = useMemo(() => {
    const simulated = eventsBetween(snapshot, until - windowMs, until, 1_400);
    const operator = auditEvents(actions.audit).filter((event) => Date.parse(event.time) <= until);
    return [...simulated, ...operator].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  }, [snapshot, until, windowMs, actions.audit]);

  const inSite = (event: ComputeEvent) => !siteId || event.data.siteId === undefined || event.data.siteId === siteId;
  const needle = text.trim().toLowerCase();
  const shown = all.filter(
    (event) =>
      inSite(event) &&
      (!families.size || families.has(familyOf(event))) &&
      (!needle || `${event.type} ${event.subject} ${summary(event)} ${event.tenantId}`.toLowerCase().includes(needle)),
  );
  const newSincePause = pausedAt ? eventsBetween(snapshot, pausedAt, now, 5_000).length : 0;

  // Events per minute over the window, for the rate sparkline and per family.
  const perMinute = useMemo(() => {
    const buckets = new Array(30).fill(0) as number[];
    for (const event of all) {
      const age = Math.floor((until - Date.parse(event.time)) / MINUTE);
      if (age >= 0 && age < 30) buckets[29 - age]! += 1;
    }
    return buckets;
  }, [all, until]);
  const familyCounts = useMemo(() => {
    const counts = new Map<Family, number>();
    for (const event of all) counts.set(familyOf(event), (counts.get(familyOf(event)) ?? 0) + 1);
    return counts;
  }, [all]);

  const open = openId ? all.find((event) => event.id === openId) : undefined;
  const toggle = (family: Family) => {
    const next = new Set(families);
    if (next.has(family)) next.delete(family);
    else next.add(family);
    setFamilies(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Activity"
        icon={RiTimerFlashLine}
        description="The event stream every module publishes (events.list, /watch over SSE): nodes, workloads, workflows, commands, rollouts, security, and what operators did here."
        actions={
          <button
            type="button"
            onClick={() => setPausedAt(pausedAt ? undefined : now)}
            className={cx('inline-flex h-8 items-center gap-1.5 border px-3 text-body-2-medium', pausedAt ? 'border-signal-500 bg-signal-500 text-neutral-950' : 'border-border-button-default text-text-primary hover:bg-background-secondary-default')}
          >
            {pausedAt ? <RiPlayLine className="size-4" aria-hidden /> : <RiPauseLine className="size-4" aria-hidden />}
            {pausedAt ? `Resume · ${newSincePause} new` : 'Pause stream'}
          </button>
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <Panel title="Event rate" meta="per minute · last 30 min" className="col-span-12 lg:col-span-4">
          <div className="flex items-end gap-3">
            <span className="font-mono text-[28px] leading-8 font-medium tabular-nums text-text-primary">{perMinute[28] ?? 0}</span>
            <span className="pb-1 font-mono text-[11px] text-text-tertiary">events/min</span>
          </div>
          <Sparkline values={perMinute} height={48} tone="neutral" />
        </Panel>
        <Panel title="Families" meta={`${fmtNum(all.length)} events in 30 min`} className="col-span-12 lg:col-span-8">
          <div className="flex flex-wrap gap-1.5">
            {FAMILIES.map((family) => {
              const active = families.has(family);
              return (
                <button
                  key={family}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(family)}
                  className={cx('inline-flex h-7 items-center gap-2 border px-2 font-mono text-[12px]', active ? 'border-signal-fill/60 bg-signal-soft text-text-primary' : 'border-separator-border text-text-secondary hover:text-text-primary')}
                >
                  <Led status={family === 'security' ? 'crit' : family === 'operator' ? 'live' : 'ok'} className="size-1.5" />
                  {family}
                  <span className="text-[11px] text-text-tertiary tabular-nums">{familyCounts.get(family) ?? 0}</span>
                </button>
              );
            })}
            {families.size > 0 && (
              <button type="button" onClick={() => setFamilies(new Set())} className="px-1 font-mono text-[11px] text-text-tertiary hover:text-text-primary hover:underline">
                all families
              </button>
            )}
          </div>
        </Panel>
      </div>

      <Panel
        flush
        title="Stream"
        meta={pausedAt ? `paused at ${fmtClock(pausedAt)} UTC` : 'live'}
        actions={
          <label className="flex h-7 w-64 items-center gap-1.5 border border-border-button-default bg-background-primary-default px-2 focus-within:ring-2 focus-within:ring-border-focus-ring">
            <RiSearchLine className="size-3.5 text-text-tertiary" aria-hidden />
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder="type, subject, data…" aria-label="Filter events" className="min-w-0 flex-1 bg-transparent text-body-2-regular outline-none placeholder:text-text-placeholder" />
          </label>
        }
      >
        <ol className="max-h-[calc(100dvh-420px)] min-h-64 overflow-y-auto">
          {shown.slice(0, 400).map((event) => (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => setOpenId(event.id)}
                className={cx(
                  'grid w-full grid-cols-[72px_14px_minmax(180px,240px)_minmax(160px,260px)_1fr] items-center gap-2 border-b border-separator-border/60 px-3 py-1.5 text-left hover:bg-background-secondary-default/60',
                  now - Date.parse(event.time) < 3_000 && !pausedAt && 'motion-safe:animate-[row-in_1.2s_ease-out]',
                  openId === event.id && 'bg-background-secondary-default',
                )}
              >
                <span className="font-mono text-[11px] tabular-nums text-text-tertiary" title={event.time}>
                  {fmtClock(Date.parse(event.time))}
                </span>
                <Led status={eventStatus(event)} className="size-1.5" />
                <span className="truncate font-mono text-[12px] text-text-primary">{event.type}</span>
                <SubjectLink subject={event.subject} />
                <span className="truncate font-mono text-[11px] text-text-secondary">
                  {event.tenantId !== 'ten_root' && <span className="mr-2 text-text-tertiary">{tenantById(event.tenantId)?.slug ?? event.tenantId}</span>}
                  {summary(event)}
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="py-10 text-center text-body-2-regular text-text-tertiary">No events match.</li>}
        </ol>
      </Panel>

      <Drawer open={Boolean(open)} onOpenChange={(isOpen) => !isOpen && setOpenId(undefined)} title={open?.type ?? ''} subtitle={open ? `${fmtRelative(Date.parse(open.time), now)} · sequence ${open.sequence}` : undefined} width={560}>
        {open && (
          <div className="flex flex-col gap-3">
            <SubjectLink subject={open.subject} className="text-[13px]" />
            <pre className="overflow-x-auto border border-separator-border bg-surface-sunken p-3 font-mono text-[12px] leading-5 text-text-primary">{JSON.stringify(open, null, 2)}</pre>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(`curl -N -H 'Authorization: Bearer $TOKEN' -H 'Last-Event-ID: ${open.sequence}' "$BETTER_COMPUTE_URL/api/compute/watch?type=${open.type.split('.')[0]}."`);
                toast({ title: 'Copied a /watch command', detail: 'It resumes the stream after this event.', status: 'ok' });
              }}
              className="inline-flex items-center gap-1.5 self-start font-mono text-[12px] text-signal hover:underline"
            >
              <RiFileCopyLine className="size-3.5" aria-hidden /> Copy curl to resume the stream from here
            </button>
            <p className="text-caption-1-regular text-text-tertiary">
              Events are the outbox rows the <Mono dim>events.list</Mono> method pages through and <Mono dim>/watch</Mono> streams; the sequence is the cursor
              (<Mono dim>Last-Event-ID</Mono>).
            </p>
          </div>
        )}
      </Drawer>
    </div>
  );
}
