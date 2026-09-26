'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RiArrowLeftLine, RiCheckboxCircleLine, RiCloseCircleLine, RiFlashlightLine, RiRocketLine, RiSearchEyeLine } from 'react-icons/ri';
import { earliestFit, quotaHint } from '@better-compute/console-kit';
import { Button, ButtonLink } from '@/components/base/buttons/button';
import { Switch } from '@/components/base/switch/switch';
import { EntityLink } from '@/components/shell/peek';
import { useWidth } from '@/components/ui/charts';
import { useFeedback } from '@/components/ui/feedback';
import { Select } from '@/components/ui/overlay';
import { Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Led, Mono, SeverityIcon, Tag } from '@/components/ui/signal';
import { fmtDuration, fmtMoney, fmtNum, fmtRelative, fmtStamp } from '@/lib/data/format';
import { poolById } from '@/lib/data/topology';
import type { CapacityTimeline, PlacementRequest } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { DAY, HOUR, useCapacityActions, useHourWindow, usePoolRows, usePreview, useTimelines } from '../data';
import { HoverCard, HoverRow, Segmented, timeTicks } from '../ui';

const DURATIONS = [
  { id: '1h', ms: HOUR },
  { id: '4h', ms: 4 * HOUR },
  { id: '12h', ms: 12 * HOUR },
  { id: '1d', ms: DAY },
  { id: '3d', ms: 3 * DAY },
  { id: '7d', ms: 7 * DAY },
] as const;

type StartMode = 'now' | 'earliest' | 'at';

/**
 * Free GPUs per hour ahead, the requested amount as a rule and the requested window as a frame: you can see
 * whether (and where) the request fits before asking the placer.
 */
function FitStrip({ timeline, gpus, start, durationMs, now, earliest }: { timeline: CapacityTimeline; gpus: number; start: number; durationMs: number; now: number; earliest?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null);
  const height = 132;
  const top = 18;
  const plotH = height - top - 18;
  const from = timeline.buckets[0]?.start ?? now;
  const to = timeline.buckets.at(-1)?.end ?? now + DAY;
  const max = Math.max(timeline.allocatable, gpus, 1);
  const x = (t: number) => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * width;
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const barW = width / Math.max(1, timeline.buckets.length);
  const ticks = timeTicks(from, to, width);
  const bucket = hover ? timeline.buckets[hover.index] : undefined;
  return (
    <div
      ref={ref}
      className="relative w-full select-none"
      style={{ height }}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const px = event.clientX - box.left;
        const index = Math.floor(px / barW);
        setHover(index >= 0 && index < timeline.buckets.length ? { index, x: px } : null);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg width={width} height={height} className="block" role="img" aria-label={`Free GPUs per hour; the request needs ${gpus}`}>
        {timeline.buckets.map((entry, index) => (
          <rect
            key={entry.start}
            x={index * barW}
            y={y(entry.free)}
            width={Math.max(0.5, barW - (barW > 3 ? 1 : 0))}
            height={top + plotH - y(entry.free)}
            fill={entry.free >= gpus ? 'var(--color-text-tertiary)' : 'var(--color-separator-border-strong)'}
            opacity={entry.free >= gpus ? 0.45 : 0.6}
          />
        ))}
        <line x1={0} x2={width} y1={y(gpus)} y2={y(gpus)} stroke="var(--color-signal-fill)" strokeWidth={1.5} />
        <text x={4} y={y(gpus) - 4} className="fill-text-secondary font-mono text-[10px]">
          needs {gpus}
        </text>
        <rect
          x={x(start)}
          y={top - 2}
          width={Math.max(2, x(start + durationMs) - x(start))}
          height={plotH + 4}
          fill="var(--color-signal-soft)"
          stroke="var(--color-signal-fill)"
          strokeWidth={1.5}
        />
        {earliest !== undefined && (
          <g>
            <line x1={x(earliest)} x2={x(earliest)} y1={top - 6} y2={top + plotH} stroke="var(--color-text-primary)" strokeDasharray="2 2" />
            <text x={x(earliest) + 4} y={top - 8} className="fill-text-primary font-mono text-[10px]">
              earliest
            </text>
          </g>
        )}
        <line x1={x(now)} x2={x(now)} y1={top} y2={top + plotH} stroke="var(--color-text-primary)" strokeWidth={1.5} />
        {ticks.map((tick) => (
          <text key={tick.t} x={tick.x + 2} y={height - 4} className={cx('font-mono text-[10px]', tick.day ? 'fill-text-secondary' : 'fill-text-tertiary')}>
            {tick.label}
          </text>
        ))}
      </svg>
      {hover && bucket && (
        <HoverCard x={hover.x} y={8} containerWidth={width}>
          <div className="mb-1 font-mono text-[10px] text-text-tertiary">{fmtStamp(bucket.start)} UTC</div>
          <HoverRow label="Free" value={`${fmtNum(bucket.free)} / ${fmtNum(timeline.allocatable)}`} />
          <HoverRow label="Booked" value={fmtNum(bucket.booked)} />
        </HoverCard>
      )}
    </div>
  );
}

export function PlannerPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { toast } = useFeedback();
  const { snapshot, rows } = usePoolRows();
  const actions = useCapacityActions();
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
  const [poolId, setPoolId] = useState(search.get('pool') ?? gpuRows[0]?.id ?? '');
  const row = gpuRows.find((entry) => entry.id === poolId) ?? gpuRows[0];
  const perNodeMax = row ? (snapshot.nodes.find((node) => node.poolId === row.id)?.gpus ?? 8) : 8;
  const [perNode, setPerNode] = useState(Math.min(8, perNodeMax));
  const [nodes, setNodes] = useState(1);
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]['id']>('1d');
  const [startMode, setStartMode] = useState<StartMode>('now');
  const [at, setAt] = useState<string>('');
  const [spot, setSpot] = useState(false);
  const tenantsForPool = useMemo(() => snapshot.offers.filter((offer) => offer.poolId === row?.id).map((offer) => offer.tenantId), [snapshot, row]);
  const [tenantId, setTenantId] = useState<string>(snapshot.tenantId);
  const tenant = snapshot.tenants.find((entry) => entry.id === (tenantsForPool.includes(tenantId) ? tenantId : snapshot.tenantId))!;
  const [projectId, setProjectId] = useState<string>('');

  const windowAhead = useHourWindow(0, 7 * 24);
  const timelines = useTimelines(
    gpuRows.map((entry) => entry.id),
    windowAhead.hour,
    windowAhead.to,
  );
  const durationMs = DURATIONS.find((entry) => entry.id === duration)!.ms;
  const gpus = Math.min(perNode, perNodeMax) * nodes;
  const timeline = row ? timelines.get(row.id) : undefined;
  const earliest = timeline ? earliestFit(timeline, gpus, durationMs, { notBefore: windowAhead.hour }) : undefined;
  const start =
    startMode === 'now'
      ? snapshot.now
      : startMode === 'earliest'
        ? Math.max(snapshot.now, earliest ?? snapshot.now)
        : at
          ? Date.parse(`${at}:00Z`)
          : snapshot.now;

  const request: PlacementRequest | undefined = row
    ? {
        poolId: row.id,
        gpus: Math.min(perNode, perNodeMax),
        durationMs,
        ...(start > snapshot.now + 60_000 ? { start } : {}),
        ...(nodes > 1 ? { gang: nodes } : {}),
        ...(spot ? { spot: true } : {}),
        tenantId: tenant.id,
        ...(projectId ? { projectId } : {}),
      }
    : undefined;
  const preview = usePreview(request);
  const quota = row ? quotaHint(snapshot.quotas.filter((q) => q.tenantId === tenant.id), row.id, { gpu: gpus }) : { fits: true, short: [] };
  const price = poolById(row?.id ?? '')?.price ?? 0;
  const cost = gpus * (durationMs / HOUR) * price * (spot ? 0.4 : 1);

  const alternatives = useMemo(
    () =>
      gpuRows
        .filter((entry) => entry.id !== row?.id)
        .map((entry) => {
          const nodeGpus = snapshot.nodes.find((node) => node.poolId === entry.id)?.gpus ?? 8;
          const t = timelines.get(entry.id);
          const fit = t && perNode <= nodeGpus ? earliestFit(t, gpus, durationMs, { notBefore: windowAhead.hour }) : undefined;
          return { entry, fit, sameModel: entry.short === row?.short, possible: perNode <= nodeGpus };
        })
        .filter((alt) => alt.possible)
        .sort((a, b) => Number(b.sameModel) - Number(a.sameModel) || (a.fit ?? Infinity) - (b.fit ?? Infinity))
        .slice(0, 6),
    [gpuRows, row, timelines, gpus, durationMs, perNode, windowAhead.hour, snapshot.nodes],
  );

  const book = async () => {
    if (!request) return;
    const created = await actions.create(request);
    if (created) {
      toast({ title: `${created.id} is ${created.state}`, detail: `${gpus} × ${row!.short} in ${row!.id} from ${fmtStamp(created.during?.start ?? start)} UTC`, status: 'live' });
      router.push(`/reservations?id=${created.id}`);
    }
  };

  const verdict = !preview ? 'checking' : preview.fits && quota.fits ? 'fits' : preview.preemptible && quota.fits ? 'preempt' : 'no';

  return (
    <>
      <PageHeader
        icon={RiSearchEyeLine}
        title="Plan a reservation"
        description="Say what you need; the placer's dry run (capacity.preview) answers as you type, with the node candidates, the quota left, the cost and the earliest window here or in another pool. Nothing is booked until you press Book."
        actions={
          <ButtonLink href="/reservations" size="small" variant="secondary" leadingIcon={RiArrowLeftLine}>
            Reservations
          </ButtonLink>
        }
      />
      <Grid>
        <Panel className="col-span-12 lg:col-span-5" title="Request" meta="reservations.create">
          <div className="flex flex-col gap-4">
            <Field label="Pool">
              <Select
                label="Pool"
                size="medium"
                value={row?.id ?? ''}
                onChange={(value) => {
                  setPoolId(value);
                  const max = snapshot.nodes.find((node) => node.poolId === value)?.gpus ?? 8;
                  setPerNode((current) => Math.min(current, max));
                }}
                options={gpuRows.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.short}`, description: `${entry.siteId} · ${fmtNum(entry.freeNow)} free now of ${fmtNum(entry.allocatable)}` }))}
              />
            </Field>
            <Field label="GPUs per node" hint={`this pool's nodes have ${perNodeMax}`}>
              <Segmented
                label="GPUs per node"
                value={String(Math.min(perNode, perNodeMax))}
                onChange={(value) => setPerNode(Number(value))}
                options={[1, 2, 4, 8].filter((n) => n <= perNodeMax).map((n) => ({ id: String(n), label: String(n) }))}
              />
            </Field>
            <Field label="Nodes" hint={nodes > 1 ? `a gang: all ${nodes} nodes or none, on one fabric domain` : 'one node'}>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={nodes}
                  onChange={(event) => setNodes(Number(event.target.value))}
                  className="flex-1 accent-[var(--color-signal-fill)]"
                  aria-label="Nodes"
                />
                <span className="w-24 text-right font-mono text-[13px] tabular-nums">
                  {nodes} → <span className="text-text-primary">{gpus} GPUs</span>
                </span>
              </div>
            </Field>
            <Field label="Duration">
              <Segmented label="Duration" value={duration} onChange={(value) => setDuration(value as typeof duration)} options={DURATIONS.map((entry) => ({ id: entry.id, label: entry.id }))} />
            </Field>
            <Field label="Start" hint={startMode === 'earliest' ? (earliest ? `${fmtStamp(earliest)} UTC (${fmtRelative(earliest, snapshot.now)})` : 'no window in 7 days') : undefined}>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="Start"
                  value={startMode}
                  onChange={(value) => setStartMode(value as StartMode)}
                  options={[
                    { id: 'now', label: 'now' },
                    { id: 'earliest', label: 'earliest fit' },
                    { id: 'at', label: 'at…' },
                  ]}
                />
                {startMode === 'at' && (
                  <input
                    type="datetime-local"
                    value={at}
                    onChange={(event) => setAt(event.target.value)}
                    className="h-8 border border-border-button-default bg-background-primary-default px-2 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                    aria-label="Start (UTC)"
                  />
                )}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tenant">
                <Select
                  label="Tenant"
                  value={tenant.id}
                  onChange={(value) => {
                    setTenantId(value);
                    setProjectId('');
                  }}
                  options={snapshot.tenants.filter((entry) => tenantsForPool.includes(entry.id)).map((entry) => ({ id: entry.id, label: entry.name }))}
                />
              </Field>
              <Field label="Project">
                <Select label="Project" value={projectId || tenant.projects[0] || ''} onChange={setProjectId} options={tenant.projects.map((project) => ({ id: project, label: project }))} />
              </Field>
            </div>
            <Switch isSelected={spot} onChange={setSpot} size="sm">
              <span className="text-body-regular">Spot: 60% cheaper, preemptible with notice</span>
            </Switch>
          </div>
        </Panel>

        <div className="col-span-12 flex flex-col gap-3 lg:col-span-7">
          <Panel
            title="Verdict"
            meta="capacity.preview"
            actions={<Led status={verdict === 'fits' ? 'live' : verdict === 'preempt' ? 'warn' : verdict === 'checking' ? 'pending' : 'crit'} />}
          >
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-mono text-[18px] leading-7 text-text-primary">
                  {verdict === 'fits' && <RiCheckboxCircleLine className="size-5 text-signal" aria-hidden />}
                  {verdict === 'no' && <RiCloseCircleLine className="size-5 text-text-error-primary" aria-hidden />}
                  {verdict === 'preempt' && <RiFlashlightLine className="size-5 text-signal" aria-hidden />}
                  {verdict === 'fits'
                    ? start > snapshot.now + 60_000
                      ? `Fits from ${fmtStamp(start)} UTC`
                      : 'Fits now'
                    : verdict === 'preempt'
                      ? `Fits by preempting ${preview!.preemptible!.reservations} spot reservation${preview!.preemptible!.reservations === 1 ? '' : 's'}`
                      : verdict === 'checking'
                        ? 'Checking…'
                        : !quota.fits
                          ? 'Over quota'
                          : "Doesn't fit in that window"}
                </p>
                <p className="mt-1 text-caption-1-regular text-text-secondary">
                  {!quota.fits
                    ? `${tenant.name} has ${fmtNum(quota.short[0]!.available)} GPUs of quota left in ${row?.id}; the request needs ${fmtNum(gpus)}.`
                    : preview?.reason ?? (preview?.fits ? `${preview.candidates.length} candidate node${preview.candidates.length === 1 ? '' : 's'}, best first. The server decides at booking time.` : '')}
                  {verdict === 'preempt' && ` Would start ${fmtRelative(preview!.preemptible!.startsAt, snapshot.now)}, after the notice.`}
                </p>
              </div>
              <div className="text-right">
                <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Estimated cost</div>
                <div className="font-mono text-[22px] leading-8 tabular-nums">{fmtMoney(cost)}</div>
                <div className="font-mono text-[11px] text-text-tertiary">
                  {gpus} × {fmtDuration(durationMs)} × {fmtMoney(price * (spot ? 0.4 : 1), { cents: true })}/GPU·h
                </div>
              </div>
            </div>
            {timeline && (
              <div className="mt-4">
                <FitStrip timeline={timeline} gpus={gpus} start={start} durationMs={durationMs} now={snapshot.now} earliest={earliest} />
                <p className="mt-1 font-mono text-[10px] text-text-tertiary">
                  bars: free GPUs per hour (pool-wide; the placer also needs them on {nodes > 1 ? `${nodes} nodes` : 'one node'}) · frame: the requested window
                </p>
              </div>
            )}
            {preview && preview.candidates.length > 0 && (
              <ul className="mt-4 flex flex-col gap-1.5">
                {preview.candidates.slice(0, 6).map((candidate, index) => (
                  <li key={candidate.nodeId} className="grid grid-cols-[1.5rem_11rem_1fr_3rem] items-center gap-2">
                    <span className="font-mono text-[11px] text-text-tertiary">#{index + 1}</span>
                    <EntityLink kind="node" id={candidate.nodeId} href={`/nodes/${candidate.nodeId}`} className="truncate" />
                    <div className="h-1.5 bg-background-secondary-default">
                      <div className={cx('h-full', index < nodes ? 'bg-signal-fill' : 'bg-text-tertiary/60')} style={{ width: `${candidate.score}%` }} />
                    </div>
                    <span className="text-right font-mono text-[11px] tabular-nums text-text-secondary">{candidate.score}</span>
                  </li>
                ))}
                <li className="font-mono text-[10px] text-text-tertiary">score: how full the node ends up (bin-packing keeps whole nodes free)</li>
              </ul>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-separator-border pt-3">
              <Button leadingIcon={RiRocketLine} disabled={!request || actions.state.busy || !quota.fits || verdict === 'checking'} onClick={() => void book()}>
                {verdict === 'fits' ? 'Book' : 'Book anyway (queues as pending)'}
              </Button>
              {actions.state.error && (
                <span className="flex items-center gap-1.5 text-caption-1-regular text-text-error-primary">
                  <SeverityIcon severity="critical" /> {actions.state.error}
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] text-text-tertiary">
                {tenant.name} · {projectId || tenant.projects[0]} · {spot ? 'spot' : 'on-demand'}
              </span>
            </div>
          </Panel>

          <Panel title="Other pools" meta="earliest window for the same request" flush>
            <table className="w-full text-body-regular">
              <tbody>
                {alternatives.map(({ entry, fit, sameModel }) => (
                  <tr key={entry.id} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-default">
                    <td className="px-3 py-1.5">
                      <button type="button" className="text-left hover:underline" onClick={() => setPoolId(entry.id)}>
                        {entry.name}
                      </button>
                      <span className="ml-2 font-mono text-[11px] text-text-tertiary">
                        {entry.short} · {entry.siteId}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">{sameModel && <Tag status="ok" led={false}>same model</Tag>}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{fmtMoney(entry.price * gpus * (durationMs / HOUR) * (spot ? 0.4 : 1))}</td>
                    <td className="px-3 py-1.5 text-right">
                      {fit === undefined ? <Tag status="off">none in 7 d</Tag> : fit <= snapshot.now + HOUR ? <Tag status="live">now</Tag> : <Tag status="ok" led={false}>{fmtRelative(fit, snapshot.now)}</Tag>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </Grid>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">{label}</span>
        {hint && <span className="truncate font-mono text-[11px] text-text-tertiary">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
