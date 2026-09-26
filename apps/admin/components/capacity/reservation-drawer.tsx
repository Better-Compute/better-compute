'use client';

import Link from 'next/link';
import { useMemo, useRef } from 'react';
import { earliestFit } from '@better-compute/console-kit';
import { usePageCommands } from '@/components/shell/page-commands';
import { EntityLink } from '@/components/shell/peek';
import { RiAddLine, RiArrowDownSLine, RiCheckLine, RiCloseCircleLine, RiCloseLine, RiFileCopyLine, RiQuestionLine, RiStopCircleLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { Drawer, Menu } from '@/components/ui/overlay';
import { KeyValue } from '@/components/ui/panel';
import { Mono, SeverityIcon, Tag } from '@/components/ui/signal';
import { fmtDuration, fmtMoney, fmtNum, fmtRelative, fmtStamp } from '@/lib/data/format';
import { durationMs, HOUR, reservationGpus, type Reservation, type ReservationState } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { DAY, useCapacity, useCapacityActions, useHourWindow, usePoolRows, useTenantName, useTimelines } from './data';
import { diagnoseWait, timelineReach, waitWindow } from './diagnose';
import { ReservationGantt } from './gantt';
import { reservationSpend, stateStyle } from './model';
import { planHref, ReadOnlyHint, StateTag } from './ui';

// One reservation, everything about it, and what an operator can do to it. Destructive actions confirm inline
// (a second press), never in a modal on top of a modal.

const PATH: ReservationState[] = ['pending', 'placed', 'binding', 'active', 'releasing', 'released'];

function Lifecycle({ reservation, now }: { reservation: Reservation; now: number }) {
  const terminal = ['failed', 'cancelled', 'expired', 'denied'].includes(reservation.state);
  const reached = terminal ? -1 : PATH.indexOf(reservation.state === 'awaiting-confirmation' ? 'pending' : reservation.state);
  const during = reservation.during;
  // Only times the API tells us: the window's start and end (placement time is not returned).
  const when: Partial<Record<ReservationState, number | undefined>> = {
    binding: during?.start,
    active: during ? during.start + 2 * 60_000 : undefined,
    releasing: during?.end,
    released: during?.end,
  };
  return (
    <ol className="flex flex-col">
      {PATH.map((state, index) => {
        const done = !terminal && index <= reached;
        const current = !terminal && index === reached;
        const t = when[state];
        return (
          <li key={state} className="grid grid-cols-[16px_1fr_auto] items-start gap-x-3">
            <span className="flex h-full flex-col items-center">
              <span
                className={cx(
                  'mt-1 size-2.5 shrink-0 rounded-full border',
                  current ? 'border-signal-fill bg-signal-fill shadow-[0_0_0_3px_var(--color-signal-soft)]' : done ? 'border-text-secondary bg-text-secondary' : 'border-separator-border-strong',
                )}
              />
              {index < PATH.length - 1 && <span className={cx('w-px flex-1', done && index < reached ? 'bg-text-secondary' : 'bg-separator-border')} style={{ minHeight: 18 }} />}
            </span>
            <span className={cx('pb-3 font-mono text-[12px]', current ? 'text-text-primary' : done ? 'text-text-secondary' : 'text-text-tertiary')}>{stateStyle[state].label}</span>
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">
              {t !== undefined && (done || t > now) ? `${fmtStamp(t)}${t > now ? ` · ${fmtRelative(t, now)}` : ''}` : ''}
            </span>
          </li>
        );
      })}
      {terminal && (
        <li className="mt-1 flex items-center gap-2">
          <StateTag state={reservation.state} />
          <span className="text-caption-1-regular text-text-secondary">ended outside the normal path</span>
        </li>
      )}
    </ol>
  );
}

/**
 * For a reservation that hasn't started: every GPU pool that could take the same shape, with its earliest window
 * (pool-wide timeline; the placer still decides per node) and a link that opens the planner prefilled there.
 */
function Alternatives({ reservation }: { reservation: Reservation }) {
  const { snapshot, rows } = usePoolRows();
  const { hour, to } = useHourWindow(0, 7 * 24);
  const perNode = reservation.request.devices[0]?.class === 'node' ? 8 : reservation.request.devices[0]?.count ?? 1;
  const nodes = reservation.request.gang?.size ?? 1;
  const gpus = reservationGpus(reservation);
  const length = durationMs(reservation.request.duration) || DAY;
  const candidates = useMemo(
    () => rows.filter((row) => row.unit === 'gpu' && (snapshot.nodes.find((node) => node.poolId === row.id)?.gpus ?? 8) >= perNode),
    [rows, snapshot.nodes, perNode],
  );
  const timelines = useTimelines(
    candidates.map((row) => row.id),
    hour,
    to,
  );
  const ranked = useMemo(
    () =>
      candidates
        .map((row) => {
          const timeline = timelines.get(row.id);
          const start = timeline ? earliestFit(timeline, gpus, length, { notBefore: hour }) : undefined;
          return { row, start };
        })
        .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
        .slice(0, 5),
    [candidates, timelines, gpus, length, hour],
  );
  const current = reservation.during?.start;
  return (
    <section>
      <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Other places it could run</h3>
      <ul className="border border-separator-border">
        {ranked.map(({ row, start }) => (
          <li key={row.id} className="flex items-center gap-2 border-b border-separator-border px-3 py-1.5 last:border-0">
            <span className="min-w-0 flex-1 truncate text-caption-1-regular">
              {row.name} <span className="font-mono text-[10px] text-text-tertiary">{row.short} · {row.siteId}</span>
              {row.id === reservation.poolId && <span className="ml-1 font-mono text-[10px] text-text-tertiary">(this pool)</span>}
            </span>
            {start === undefined ? (
              <Tag status="off">none in 7 d</Tag>
            ) : start <= snapshot.now + HOUR ? (
              <Tag status="live">now</Tag>
            ) : (
              <Tag status={current !== undefined && start < current ? 'live' : 'ok'} led={current !== undefined && start < current}>
                {fmtRelative(start, snapshot.now)}
              </Tag>
            )}
            {start !== undefined && row.id !== reservation.poolId && (
              <Link href={planHref(row.id, start, start + length, { gpus: perNode, nodes })} className="font-mono text-[11px] text-signal hover:underline">
                plan there
              </Link>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1 font-mono text-[10px] text-text-tertiary">earliest window for {fmtNum(gpus)} GPUs × {fmtDuration(length)}; amber = sooner than it starts now</p>
    </section>
  );
}

const VERDICT_ICON = { ok: RiCheckLine, blocks: RiCloseLine, unknown: RiQuestionLine } as const;

/**
 * For a reservation that hasn't placed: which check holds it (quota, shape, nodes in service, capacity, free GPUs
 * scattered across nodes), what is booked on the pool over its window, and the one next step for that cause.
 */
function WhyWaiting({ reservation }: { reservation: Reservation }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const { hour } = useHourWindow(0, 0);
  // Load the pool's timeline through the window it wants (a pending start can be days out).
  const reach = timelineReach(hour, [waitWindow(reservation, snapshot.now).end]);
  const timelines = useTimelines([reservation.poolId], hour, reach);
  const timeline = timelines.get(reservation.poolId);
  const diagnosis = useMemo(() => diagnoseWait(reservation, snapshot, timeline), [reservation, snapshot, timeline]);
  const { cause, fitsAt, needed } = diagnosis;
  const { start } = diagnosis.window;
  const length = diagnosis.window.end - start;
  // The pool-wide earliest fit only answers a capacity cause: scattered GPUs look free pool-wide, and a person's
  // confirmation or a shape that never fits don't move with time.
  const poolWideFit = !cause || cause.id === 'capacity';
  const next =
    cause?.id === 'service'
      ? { href: `/pools/${reservation.poolId}?tab=now`, label: 'see the rack' }
      : cause?.id === 'fragmentation'
        ? { href: `/pools/${reservation.poolId}?tab=now`, label: 'see where the free GPUs are' }
        : cause?.id === 'capacity' && fitsAt !== undefined
          ? { href: planHref(reservation.poolId, fitsAt, fitsAt + length, { gpus: needed.perNode, nodes: needed.nodes }), label: 'plan the earliest window' }
          : undefined;
  return (
    <section>
      <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Why it&apos;s waiting</h3>
      <div className={cx('border px-3 py-2', cause ? 'border-signal-fill/50 bg-signal-soft' : 'border-separator-border')}>
        <p className="text-caption-1-regular text-text-primary">
          {cause ? (
            <>
              <span className="font-semibold">{cause.label}.</span> {cause.detail}
            </>
          ) : diagnosis.placer ? (
            <>
              The book has room for it now; the placer last said “{diagnosis.placer.message ?? diagnosis.placer.reason ?? diagnosis.placer.type}”
              {diagnosis.placer.since < snapshot.now - 60_000 ? ` (${fmtRelative(diagnosis.placer.since, snapshot.now)})` : ''}. It retries on the next pass.
            </>
          ) : (
            'Nothing in the book blocks it: it should place on the next pass.'
          )}
        </p>
        <p className="mt-1 font-mono text-[11px] text-text-secondary">
          {start > snapshot.now + HOUR && `wants to start ${fmtStamp(start)} (${fmtRelative(start, snapshot.now)}) · `}
          {!poolWideFit
            ? `needs ${needed.gpus} GPUs × ${fmtDuration(length)}`
            : !timeline
              ? 'loading the pool timeline…'
              : fitsAt === undefined
                ? `no window for ${needed.gpus} GPUs × ${fmtDuration(length)} in this pool before ${fmtStamp(diagnosis.searchedTo ?? reach)}`
                : fitsAt <= start + HOUR
                  ? `this pool has ${needed.gpus} GPUs × ${fmtDuration(length)} free from ${start > snapshot.now + HOUR ? 'then' : 'now'} (pool-wide)`
                  : `this pool fits ${needed.gpus} GPUs × ${fmtDuration(length)} from ${fmtStamp(fitsAt)} (${fmtRelative(fitsAt, snapshot.now)})`}
          {next && (
            <>
              {' · '}
              <Link href={next.href} className="text-signal hover:underline">
                {next.label}
              </Link>
            </>
          )}
        </p>
      </div>
      <ul className="mt-2 flex flex-col">
        {diagnosis.checks.map((check) => {
          const Icon = VERDICT_ICON[check.verdict];
          return (
            <li key={check.id} className="grid grid-cols-[16px_88px_1fr] items-start gap-x-2 py-1">
              <Icon
                aria-label={check.verdict === 'ok' ? 'passes' : check.verdict === 'blocks' ? 'blocks' : 'unknown'}
                className={cx('mt-0.5 size-3.5', check.verdict === 'blocks' ? 'text-signal' : check.verdict === 'ok' ? 'text-text-secondary' : 'text-text-tertiary')}
              />
              <span className={cx('font-mono text-[11px]', check.verdict === 'blocks' ? 'text-text-primary' : 'text-text-secondary')}>{check.label}</span>
              <span className="text-caption-1-regular text-text-secondary">{check.detail}</span>
            </li>
          );
        })}
      </ul>
      {diagnosis.blockers.length > 0 && (cause?.id === 'capacity' || cause?.id === 'fragmentation') && (
        <div className="mt-2">
          <p className="mb-1 font-mono text-[10px] text-text-tertiary">
            booked on {reservation.poolId} over its window ({fmtStamp(diagnosis.window.start)} → {fmtStamp(diagnosis.window.end)}), most GPU-hours first
          </p>
          <ul className="border border-separator-border">
            {diagnosis.blockers.slice(0, 5).map(({ reservation: other, gpus, gpuHours }) => (
              <li key={other.id} className="flex flex-wrap items-center gap-2 border-b border-separator-border px-3 py-1.5 last:border-0">
                <EntityLink kind="reservation" id={other.id} href={`/reservations?id=${other.id}`} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary">{tenantName(other.tenantId)}</span>
                {other.request.spot && <Tag status="warn">spot</Tag>}
                <span className="font-mono text-[11px] tabular-nums text-text-secondary">
                  {fmtNum(gpus)} GPU · {fmtNum(Math.round(gpuHours))} GPU·h · until {fmtStamp(other.during!.end)}
                </span>
              </li>
            ))}
          </ul>
          {diagnosis.blockers.length > 5 && <p className="mt-1 font-mono text-[10px] text-text-tertiary">+{diagnosis.blockers.length - 5} more</p>}
        </div>
      )}
    </section>
  );
}

/**
 * The reservation's own nodes, with everything else booked on them around its window: who was there before, who
 * comes after, and what sits on the other GPUs.
 */
function NeighbourSchedule({ reservation }: { reservation: Reservation }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const ids = reservation.nodeIds ?? [];
  const nodes = useMemo(() => snapshot.nodes.filter((node) => ids.includes(node.id)), [snapshot.nodes, ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const length = reservation.during!.end - reservation.during!.start;
  const pad = Math.max(6 * HOUR, length * 0.5);
  const from = reservation.during!.start - pad;
  const to = reservation.during!.end + pad;
  const around = useMemo(
    () => snapshot.reservations.filter((entry) => entry.poolId === reservation.poolId && entry.during && entry.nodeIds?.some((id) => ids.includes(id)) && entry.during.end > from && entry.during.start < to),
    [snapshot.reservations, reservation.poolId, ids.join(','), from, to], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (!nodes.length) return null;
  return (
    <div className="mt-3">
      <ReservationGantt reservations={around} nodes={nodes} from={from} to={to} now={snapshot.now} selectedId={reservation.id} tenantName={tenantName} gpusPerNode={nodes[0]?.gpus ?? 8} maxHeight={180} />
    </div>
  );
}

export function ReservationDrawer({ reservation, onClose }: { reservation?: Reservation; onClose(): void }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const actions = useCapacityActions();
  // Follow the reservation through mutations: re-read it from the snapshot by id.
  const current = useMemo(
    () => (reservation ? snapshot.reservations.find((entry) => entry.id === reservation.id) ?? reservation : undefined),
    [snapshot, reservation],
  );
  const spend = useMemo(() => (current ? reservationSpend(current, snapshot.usage, snapshot.prices) : 0), [current, snapshot]);
  // While open, the reservation's verbs are in ⌘K under "This page". They call the *current* actions through a
  // ref: a memoized closure would keep an old `live` flag and could mutate while the panel shows the past.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const id = current?.id;
  const state = current?.state;
  usePageCommands(
    useMemo(() => {
      if (!id || !state) return [];
      const live = state === 'active' || state === 'binding' || state === 'releasing';
      const cancellable = state === 'placed' || state === 'pending' || state === 'awaiting-confirmation';
      return [
        ...(live
          ? [
              { id: 'rsv.release', label: `Release ${id}`, group: 'This page', icon: RiStopCircleLine, run: () => void actionsRef.current.release(id) },
              ...[1, 6, 24].map((hours) => ({ id: `rsv.extend.${hours}`, label: `Extend ${id} by ${hours} h`, group: 'This page', icon: RiAddLine, run: () => void actionsRef.current.extend(id, hours * HOUR) })),
            ]
          : []),
        ...(cancellable ? [{ id: 'rsv.cancel', label: `Cancel ${id}`, group: 'This page', icon: RiCloseCircleLine, run: () => void actionsRef.current.cancel(id) }] : []),
        { id: 'rsv.copy-cli', label: `Copy CLI for ${id}`, group: 'This page', icon: RiFileCopyLine, run: () => void navigator.clipboard?.writeText(`better-compute reservations get ${id}`) },
      ];
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, state]),
  );
  if (!current) return null;

  const r = current;
  const gpus = reservationGpus(r);
  const perNode = r.request.devices[0]?.class === 'node' ? 'whole node' : `${r.request.devices[0]?.count ?? 0} per node`;
  const owner = snapshot.identities.find((identity) => identity.id === r.ownerIdentityId);
  const live = r.state === 'active' || r.state === 'binding' || r.state === 'releasing';
  const cancellable = r.state === 'placed' || r.state === 'pending' || r.state === 'awaiting-confirmation';
  const progress = r.during ? Math.min(1, Math.max(0, (snapshot.now - r.during.start) / (r.during.end - r.during.start))) : 0;
  const cli = `better-compute reservations get ${r.id} --tenant ${r.tenantId}`;

  return (
    <Drawer
      open={Boolean(reservation)}
      onOpenChange={(open) => {
        if (!open) {
          actions.reset();
          onClose();
        }
      }}
      title={
        <span className="flex items-center gap-2">
          {r.id} <StateTag state={r.state} />
        </span>
      }
      subtitle={`${tenantName(r.tenantId)} · ${r.poolId}${r.projectId ? ` · ${r.projectId}` : ''}`}
      width={600}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          {live && (
            <>
              <Menu
                label="Extend"
                trigger={
                  <Button variant="secondary" size="small" leadingIcon={RiAddLine} trailingIcon={RiArrowDownSLine} disabled={actions.state.busy || !actions.live}>
                    Extend
                  </Button>
                }
                items={[1, 6, 24, 72].map((hours) => ({
                  id: String(hours),
                  label: `+${hours} h (until ${fmtStamp((r.during?.end ?? snapshot.now) + hours * HOUR)})`,
                  onAction: () => void actions.extend(r.id, hours * HOUR),
                }))}
              />
              <Button variant="secondary" size="small" leadingIcon={RiStopCircleLine} disabled={actions.state.busy || !actions.live} onClick={() => void actions.release(r.id, gpus)}>
                Release
              </Button>
            </>
          )}
          {cancellable && (
            <Button variant="secondary" size="small" leadingIcon={RiCloseCircleLine} disabled={actions.state.busy || !actions.live} onClick={() => void actions.cancel(r.id)}>
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="small"
            leadingIcon={RiFileCopyLine}
            onClick={() => void navigator.clipboard?.writeText(cli)}
            title={cli}
          >
            Copy CLI
          </Button>
          {(live || cancellable) && <ReadOnlyHint reason={actions.readOnly} />}
        </div>
        {actions.state.error && (
          <p className="flex items-center gap-2 border border-red-500/40 bg-red-500/10 px-3 py-2 text-caption-1-regular text-text-error-primary">
            <SeverityIcon severity="critical" /> {actions.state.error}
          </p>
        )}
        {actions.state.done && !actions.state.error && <p className="font-mono text-[11px] text-text-secondary">✓ {actions.state.done}</p>}

        {r.during && (
          <section>
            <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11px] text-text-tertiary">
              <span>{fmtStamp(r.during.start)} UTC</span>
              <span>{fmtDuration(r.during.end - r.during.start)}</span>
              <span>{fmtStamp(r.during.end)} UTC</span>
            </div>
            <div className="h-2 bg-background-secondary-default">
              <div className={cx('h-full', live ? 'bg-signal-fill' : 'bg-text-tertiary/50')} style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-text-secondary">
              {snapshot.now < r.during.start
                ? `starts ${fmtRelative(r.during.start, snapshot.now)}`
                : snapshot.now < r.during.end && live
                  ? `${fmtDuration(r.during.end - snapshot.now)} left`
                  : `ended ${fmtRelative(r.during.end, snapshot.now)}`}
              {r.leaseExpiresAt && ` · lease renews by ${fmtStamp(r.leaseExpiresAt)}`}
            </p>
          </section>
        )}

        <KeyValue
          columns={2}
          items={[
            { label: 'GPUs', value: `${fmtNum(gpus)} (${perNode}${r.request.gang ? ` × ${r.request.gang.size} nodes` : ''})`, mono: true },
            { label: 'Binding', value: r.request.binding ?? 'hold', mono: true },
            { label: 'Topology', value: r.request.topology ?? 'any', mono: true },
            { label: 'Market', value: r.request.spot ? 'spot (preemptible)' : 'on-demand' },
            { label: 'Owner', value: owner ? `${owner.name}${owner.agent ? ' (agent)' : ''}` : r.ownerIdentityId },
            // Live usage windows don't name their reservation, so per-reservation spend is simulation-only.
            { label: 'Spend so far', value: snapshot.source === 'live' ? '— (see Usage)' : fmtMoney(spend, { cents: true }), mono: true },
            ...(r.request.hostShare
              ? [{ label: 'Host share', value: `${fmtNum(r.request.hostShare.vcpu ?? 0)} vCPU · ${fmtNum(r.request.hostShare.memoryGiB ?? 0)} GiB`, mono: true }]
              : []),
            ...(r.request.gang?.topologyKey ? [{ label: 'Gang key', value: r.request.gang.topologyKey, mono: true }] : []),
          ]}
        />

        <section>
          <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Lifecycle</h3>
          <Lifecycle reservation={r} now={snapshot.now} />
        </section>

        {(r.state === 'pending' || r.state === 'awaiting-confirmation') && <WhyWaiting reservation={r} />}

        {(r.state === 'pending' || r.state === 'awaiting-confirmation' || r.state === 'placed') && <Alternatives reservation={r} />}

        {r.conditions.length > 0 && (
          <section>
            <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Conditions</h3>
            <ul className="flex flex-col gap-2">
              {r.conditions.map((condition) => (
                <li key={condition.type} className="border border-separator-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <SeverityIcon severity={condition.type === 'Failed' ? 'critical' : 'warning'} />
                    <span className="font-mono text-[12px] text-text-primary">{condition.type}</span>
                    {condition.reason && <Tag status="ok" led={false}>{condition.reason}</Tag>}
                    <span className="ml-auto font-mono text-[10px] text-text-tertiary">{fmtRelative(condition.since, snapshot.now)}</span>
                  </div>
                  {condition.message && <p className="mt-1 text-caption-1-regular text-text-secondary">{condition.message}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(r.nodeIds?.length ?? 0) > 0 && (
          <section>
            <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Placement</h3>
            <ul className="flex flex-col gap-1.5">
              {r.nodeIds!.map((nodeId) => (
                <li key={nodeId} className="flex flex-wrap items-center gap-2">
                  <EntityLink kind="node" id={nodeId} href={`/nodes/${nodeId}`} />
                  <span className="flex flex-wrap gap-1">
                    {(r.atoms ?? [])
                      .filter((atom) => atom.startsWith(`${nodeId}/`))
                      .map((atom) => (
                        <span key={atom} className="border border-separator-border px-1 font-mono text-[10px] text-text-secondary">
                          {atom.slice(nodeId.length + 1)}
                        </span>
                      ))}
                  </span>
                </li>
              ))}
            </ul>
            {r.during && <NeighbourSchedule reservation={r} />}
          </section>
        )}

        {r.binding && (
          <section>
            <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Hold binding</h3>
            <pre className="overflow-x-auto border border-separator-border bg-surface-sunken p-3 font-mono text-[11px] leading-5 text-text-secondary">
              {[`node        ${r.binding.nodeId}`, `cdi         ${r.binding.cdiDevices.join(' ')}`, `env file    ${r.binding.envFile}`, ...(r.binding.cgroupParent ? [`cgroup      ${r.binding.cgroupParent}`] : [])].join('\n')}
            </pre>
          </section>
        )}

        {r.operation && (
          <section className="flex items-center gap-2 font-mono text-[11px] text-text-secondary">
            operation <Mono>{r.operation.id}</Mono>
            <Tag status={r.operation.state === 'failed' ? 'crit' : r.operation.state === 'succeeded' ? 'ok' : 'pending'}>{r.operation.state}</Tag>
            {r.operation.error && <span className="text-text-error-primary">{r.operation.error.code}: {r.operation.error.message}</span>}
          </section>
        )}

        <details className="border border-separator-border">
          <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-text-secondary">Request as sent (reservations.create)</summary>
          <pre className="overflow-x-auto border-t border-separator-border bg-surface-sunken p-3 font-mono text-[11px] leading-5 text-text-secondary">
            {JSON.stringify({ tenantId: r.tenantId, ...r.request, idempotencyKey: r.idempotencyKey }, null, 2)}
          </pre>
        </details>
      </div>
    </Drawer>
  );
}
