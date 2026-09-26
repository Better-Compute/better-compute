'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { RiAddLine, RiArrowDownSLine, RiDeleteBinLine, RiFlaskLine, RiLinkM, RiRefreshLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { usePageCommands } from '@/components/shell/page-commands';
import { Legend, TimeSeriesChart } from '@/components/ui/charts';
import { useFeedback } from '@/components/ui/feedback';
import { Menu, Select } from '@/components/ui/overlay';
import { EmptyState, Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { fmtDuration, fmtNum, fmtPct, fmtStamp } from '@/lib/data/format';
import { reservationGpus } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { HOUR, useHourWindow, usePoolRows, useTenantName, useTimelines } from '../data';
import { decodeScenario, encodeScenario, evaluate, KIND_LABEL, leastDisruptiveNodes, newId, type Change, type ChangeKind, type PoolOutcome } from '../scenarios';
import { utcDay } from '../ui';

const HORIZON = 168;

function NumberField({ label, value, onChange, min = 0, max, step = 1, suffix }: { label: string; value: number; onChange(value: number): void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Math.max(min, Math.min(max ?? Infinity, Math.round(Number(event.target.value) || 0))))}
          className="h-8 w-20 border border-border-button-default bg-background-primary-default px-2 text-right font-mono text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        />
        {suffix && <span className="font-mono text-[11px] text-text-tertiary">{suffix}</span>}
      </span>
    </label>
  );
}

/** Before → after, with the direction that is bad marked in amber. */
function Delta({ base, next, format, worseWhen }: { base: number | undefined; next: number | undefined; format(value: number | undefined): string; worseWhen: 'up' | 'down' }) {
  const same = base === next || (base !== undefined && next !== undefined && Math.abs(base - next) < 1e-9);
  const worse = !same && (base === undefined ? false : next === undefined ? true : worseWhen === 'up' ? next > base : next < base);
  return (
    <span className="font-mono text-[12px] tabular-nums whitespace-nowrap">
      {same ? (
        <span className="text-text-secondary">{format(next)}</span>
      ) : (
        <>
          <span className="text-text-tertiary">{format(base)} → </span>
          <span className={cx(worse ? 'text-signal' : 'text-text-primary')}>{format(next)}</span>
        </>
      )}
    </span>
  );
}

export function ScenariosPage() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { toast } = useFeedback();
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
  const [changes, setChanges] = useState<Change[]>(() => decodeScenario(search.get('s')));
  const [focus, setFocus] = useState<string | undefined>();
  const { hour, to } = useHourWindow(0, HORIZON);
  const timelines = useTimelines(
    gpuRows.map((row) => row.id),
    hour,
    to,
  );
  const perNode = useMemo(() => new Map(gpuRows.map((row) => [row.id, snapshot.nodes.find((node) => node.poolId === row.id)?.gpus ?? 8])), [gpuRows, snapshot.nodes]);

  // Keep the URL in step so the scenario is shareable (replace, not push: no history spam while typing).
  useEffect(() => {
    const params = new URLSearchParams(search.toString());
    if (changes.length) params.set('s', encodeScenario(changes));
    else params.delete('s');
    const next = `${pathname}${params.size ? `?${params}` : ''}`;
    if (next !== `${pathname}${search.size ? `?${search}` : ''}`) router.replace(next, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes]);

  const baseline = useMemo(() => evaluate(timelines, perNode, [], hour, HORIZON), [timelines, perNode, hour]);
  const scenario = useMemo(() => evaluate(timelines, perNode, changes, hour, HORIZON), [timelines, perNode, changes, hour]);
  const touched = useMemo(() => new Set(changes.map((change) => change.poolId)), [changes]);
  const focusId = focus ?? changes[0]?.poolId ?? gpuRows[0]?.id;
  const focusBase = focusId ? baseline.pools.get(focusId) : undefined;
  const focusNext = focusId ? scenario.pools.get(focusId) : undefined;

  const totals = useMemo(() => {
    let displaced = 0;
    let unmet = 0;
    let fullHours = 0;
    for (const [poolId, outcome] of scenario.pools) {
      displaced += outcome.displacedGpuHours;
      unmet += outcome.unmetGpuHours;
      fullHours += outcome.hoursFull - (baseline.pools.get(poolId)?.hoursFull ?? 0);
    }
    return { displaced, unmet, fullHours };
  }, [scenario, baseline]);

  const add = (kind: ChangeKind, poolId = focusId ?? gpuRows[0]?.id ?? '') => {
    const change: Change =
      kind === 'maintenance'
        ? { id: newId(), kind, poolId, nodes: 2, startHours: 12, hours: 8 }
        : kind === 'expand'
          ? { id: newId(), kind, poolId, nodes: 4, startHours: 72 }
          : { id: newId(), kind, poolId, gpus: 64, startHours: 24, hours: 72 };
    setChanges((current) => [...current, change]);
    setFocus(poolId);
  };
  const update = (id: string, patch: Partial<Change>) => setChanges((current) => current.map((change) => (change.id === id ? ({ ...change, ...patch } as Change) : change)));
  const remove = (id: string) => setChanges((current) => current.filter((change) => change.id !== id));

  const presets = useMemo((): { label: string; changes: Change[] }[] => {
    const [a, b, c] = gpuRows;
    if (!a) return [];
    const tonight = (22 - new Date(hour).getUTCHours() + 24) % 24;
    return [
      { label: 'Rack maintenance tonight', changes: [{ id: '', kind: 'maintenance', poolId: a.id, nodes: 8, startHours: tonight, hours: 6 }] },
      { label: `Launch burst: +128 ${(b ?? a).short} for 3 days`, changes: [{ id: '', kind: 'burst', poolId: (b ?? a).id, gpus: 128, startHours: 24, hours: 72 }] },
      { label: `New ${(c ?? a).short} rack next week`, changes: [{ id: '', kind: 'expand', poolId: (c ?? a).id, nodes: 8, startHours: 120 }] },
    ];
  }, [gpuRows, hour]);

  usePageCommands(
    useMemo(
      () => [
        ...(['maintenance', 'expand', 'burst'] as ChangeKind[]).map((kind) => ({ id: `whatif.add.${kind}`, label: `What-if: ${KIND_LABEL[kind].toLowerCase()}`, group: 'This page', icon: RiAddLine, run: () => add(kind) })),
        { id: 'whatif.reset', label: 'What-if: start over', group: 'This page', icon: RiRefreshLine, run: () => setChanges([]) },
      ],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [focusId],
    ),
  );

  const at = (hours: number) => `${utcDay(hour + hours * HOUR)} ${new Date(hour + hours * HOUR).toISOString().slice(11, 16)}`;
  const format8x24 = (value: number | undefined) => (value === undefined ? '> 7 d' : value < HOUR ? 'now' : `in ${fmtDuration(value)}`);

  return (
    <>
      <PageHeader
        icon={RiFlaskLine}
        title="What-if"
        description="Plan maintenance, growth or a customer's launch against the real book: stack changes on the left and see, pool by pool over the next 7 days, what they cost — hours fully booked, the next 8-GPU window, reservations that would have to move, demand that would find no GPU."
        meta={
          <>
            <Tag status={changes.length ? 'pending' : 'ok'} led={Boolean(changes.length)}>
              {changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'baseline'}
            </Tag>
            <Tag status="ok" led={false}>
              {fmtStamp(hour)} → {fmtStamp(hour + HORIZON * HOUR)} UTC
            </Tag>
          </>
        }
        actions={
          <>
            <Button
              size="small"
              variant="secondary"
              leadingIcon={RiLinkM}
              disabled={!changes.length}
              onClick={() => {
                void navigator.clipboard?.writeText(window.location.href);
                toast({ title: 'Link copied', detail: 'Anyone with the admin panel sees this scenario.', status: 'ok' });
              }}
            >
              Copy link
            </Button>
            <Button size="small" variant="secondary" leadingIcon={RiRefreshLine} disabled={!changes.length} onClick={() => setChanges([])}>
              Start over
            </Button>
          </>
        }
      >
        {!changes.length && presets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-text-tertiary">try:</span>
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  setChanges(preset.changes.map((change) => ({ ...change, id: newId() })));
                  setFocus(preset.changes[0]!.poolId);
                }}
                className="h-7 border border-separator-border px-2 font-mono text-[11px] text-text-secondary hover:border-signal-fill hover:text-text-primary"
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </PageHeader>

      <Grid>
        <Panel
          className="col-span-12 xl:col-span-4"
          title="Changes"
          meta="applied in order"
          actions={
            <Menu
              label="Add a change"
              trigger={
                <Button size="xs" variant="secondary" leadingIcon={RiAddLine} trailingIcon={RiArrowDownSLine}>
                  Add
                </Button>
              }
              items={(['maintenance', 'expand', 'burst'] as ChangeKind[]).map((kind) => ({ id: kind, label: KIND_LABEL[kind], onAction: () => add(kind) }))}
            />
          }
          flush
        >
          {changes.length ? (
            <ul>
              {changes.map((change) => {
                const pool = gpuRows.find((row) => row.id === change.poolId);
                const plan =
                  change.kind === 'maintenance'
                    ? leastDisruptiveNodes(snapshot, change.poolId, change.nodes, hour + change.startHours * HOUR, hour + (change.startHours + change.hours) * HOUR)
                    : undefined;
                return (
                  <li key={change.id} className={cx('flex flex-col gap-3 border-b border-separator-border px-3 py-3 last:border-0', focusId === change.poolId && 'bg-signal-soft/40')}>
                    <div className="flex items-center gap-2">
                      <Tag status={change.kind === 'burst' ? 'warn' : change.kind === 'maintenance' ? 'pending' : 'ok'} led={false}>
                        {KIND_LABEL[change.kind]}
                      </Tag>
                      <button type="button" className="ml-auto grid size-7 place-items-center text-text-tertiary hover:text-text-primary" aria-label="Remove change" onClick={() => remove(change.id)}>
                        <RiDeleteBinLine className="size-4" aria-hidden />
                      </button>
                    </div>
                    <Select
                      label="Pool"
                      value={change.poolId}
                      onChange={(poolId) => {
                        update(change.id, { poolId });
                        setFocus(poolId);
                      }}
                      options={gpuRows.map((row) => ({ id: row.id, label: `${row.name} · ${row.short}`, description: `${row.siteId} · ${fmtNum(row.allocatable)} schedulable` }))}
                    />
                    <div className="flex flex-wrap gap-3">
                      {change.kind === 'burst' ? (
                        <NumberField label="GPUs" value={change.gpus} onChange={(gpus) => update(change.id, { gpus })} step={8} max={4096} />
                      ) : (
                        <NumberField label="Nodes" value={change.nodes} onChange={(nodes) => update(change.id, { nodes })} max={pool ? Math.ceil(pool.total / (perNode.get(pool.id) ?? 8)) * 4 : 256} suffix={`× ${perNode.get(change.poolId) ?? 8} GPU`} />
                      )}
                      <NumberField label="Starts in" value={change.startHours} onChange={(startHours) => update(change.id, { startHours })} max={HORIZON - 1} suffix="h" />
                      {change.kind !== 'expand' && <NumberField label="For" value={change.hours} onChange={(hours) => update(change.id, { hours })} min={1} max={HORIZON} suffix="h" />}
                    </div>
                    <p className="font-mono text-[11px] text-text-secondary">
                      {change.kind === 'expand'
                        ? `from ${at(change.startHours)} UTC, for good`
                        : `${at(change.startHours)} → ${at(change.startHours + change.hours)} UTC`}
                    </p>
                    {plan && (
                      <div className="border border-separator-border bg-surface-sunken p-2">
                        <p className="text-caption-1-regular text-text-secondary">
                          Least disruptive: {plan.nodes.length} node{plan.nodes.length === 1 ? '' : 's'} carrying {fmtNum(Math.round(plan.gpuHours))} booked GPU-hours in the window
                          {plan.reservations.length ? `, touching ${plan.reservations.length} reservation${plan.reservations.length === 1 ? '' : 's'}.` : '. Nothing has to move.'}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {plan.nodes.slice(0, 12).map((node) => (
                            <Link key={node.id} href={`/nodes/${node.id}`} className="border border-separator-border px-1 font-mono text-[10px] text-text-secondary hover:text-text-primary">
                              {node.id.split('-').slice(-2).join('-')}
                            </Link>
                          ))}
                          {plan.nodes.length > 12 && <span className="font-mono text-[10px] text-text-tertiary">+{plan.nodes.length - 12}</span>}
                        </div>
                        {plan.reservations.length > 0 && (
                          <ul className="mt-1.5 flex flex-col gap-0.5">
                            {plan.reservations.slice(0, 4).map((reservation) => (
                              <li key={reservation.id} className="flex items-center gap-2 font-mono text-[11px]">
                                <Link href={`/reservations?id=${reservation.id}`} className="hover:underline">
                                  <Mono>{reservation.id}</Mono>
                                </Link>
                                <span className="truncate text-text-tertiary">
                                  {tenantName(reservation.tenantId)} · {reservationGpus(reservation)} GPU
                                </span>
                              </li>
                            ))}
                            {plan.reservations.length > 4 && <li className="font-mono text-[10px] text-text-tertiary">and {plan.reservations.length - 4} more</li>}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={RiFlaskLine} title="No changes yet" action={<Button size="small" leadingIcon={RiAddLine} onClick={() => add('maintenance')}>Take nodes out</Button>}>
              Add a change, or start from one of the examples above. The right side compares every pool against today's book.
            </EmptyState>
          )}
        </Panel>

        <div className="col-span-12 flex flex-col gap-3 xl:col-span-8">
          <Panel title="Impact" meta="next 7 days · all GPU pools">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Must move</div>
                <div className={cx('font-mono text-[22px] leading-8 tabular-nums', totals.displaced > 0 ? 'text-signal' : 'text-text-primary')}>{fmtNum(Math.round(totals.displaced))}</div>
                <div className="text-caption-1-regular text-text-tertiary">booked GPU-hours on removed capacity</div>
              </div>
              <div>
                <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Unmet demand</div>
                <div className={cx('font-mono text-[22px] leading-8 tabular-nums', totals.unmet > 0 ? 'text-signal' : 'text-text-primary')}>{fmtNum(Math.round(totals.unmet))}</div>
                <div className="text-caption-1-regular text-text-tertiary">burst GPU-hours with no free GPU</div>
              </div>
              <div>
                <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Extra hours full</div>
                <div className={cx('font-mono text-[22px] leading-8 tabular-nums', totals.fullHours > 0 ? 'text-signal' : 'text-text-primary')}>
                  {totals.fullHours > 0 ? '+' : ''}
                  {fmtNum(totals.fullHours)}
                </div>
                <div className="text-caption-1-regular text-text-tertiary">pool-hours with nothing free</div>
              </div>
            </div>
          </Panel>

          <Panel title="Per pool" meta="click a row to chart it" flush>
            <div className="overflow-x-auto">
              <table className="w-full text-body-regular">
                <thead>
                  <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
                    <th className="px-3 py-2 text-left font-normal">Pool</th>
                    <th className="px-3 py-2 text-right font-normal">Hours full</th>
                    <th className="px-3 py-2 text-right font-normal">Least free</th>
                    <th className="px-3 py-2 text-right font-normal">Peak</th>
                    <th className="px-3 py-2 text-right font-normal">Next 8×24h</th>
                    <th className="px-3 py-2 text-right font-normal">Must move</th>
                  </tr>
                </thead>
                <tbody>
                  {[...gpuRows]
                    .sort((a, b) => Number(touched.has(b.id)) - Number(touched.has(a.id)))
                    .map((row) => {
                      const base = baseline.pools.get(row.id);
                      const next = scenario.pools.get(row.id);
                      if (!base || !next) return null;
                      return (
                        <tr
                          key={row.id}
                          onClick={() => setFocus(row.id)}
                          className={cx('cursor-pointer border-b border-separator-border last:border-0 hover:bg-background-secondary-default', focusId === row.id && 'bg-signal-soft/40')}
                        >
                          <td className="px-3 py-1.5">
                            <span className="text-body-medium">{row.name}</span>
                            <span className="ml-2 font-mono text-[11px] text-text-tertiary">{row.short}</span>
                            {touched.has(row.id) && <Tag status="pending" className="ml-2" led={false}>changed</Tag>}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Delta base={base.hoursFull} next={next.hoursFull} format={(value) => `${fmtNum(value ?? 0)} h`} worseWhen="up" />
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Delta base={base.minFree} next={next.minFree} format={(value) => fmtNum(value ?? 0)} worseWhen="down" />
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Delta base={base.peak} next={next.peak} format={(value) => fmtPct(value ?? 0, 0)} worseWhen="up" />
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Delta base={base.earliest8x24} next={next.earliest8x24} format={format8x24} worseWhen="up" />
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">
                            {next.displacedGpuHours + next.unmetGpuHours > 0 ? (
                              <span className="text-signal">{fmtNum(Math.round(next.displacedGpuHours + next.unmetGpuHours))} GPU·h</span>
                            ) : (
                              <span className="text-text-tertiary">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Panel>

          {focusBase && focusNext && <FocusChart base={focusBase} next={focusNext} from={hour} name={gpuRows.find((row) => row.id === focusId)?.name ?? ''} />}
        </div>
      </Grid>
    </>
  );
}

function FocusChart({ base, next, from, name }: { base: PoolOutcome; next: PoolOutcome; from: number; name: string }) {
  const times = base.free.map((_, index) => from + index * HOUR);
  return (
    <Panel title={`Free GPUs · ${name}`} meta="hourly, baseline vs scenario">
      <TimeSeriesChart
        times={times}
        height={220}
        series={[
          { id: 'scenario', label: 'With the changes', values: next.free, tone: 'signal', area: true },
          { id: 'baseline', label: 'Today’s book', values: base.free, tone: 'neutral', dashed: true },
        ]}
        yFormat={(value) => fmtNum(value)}
        xFormat={(t) => `${utcDay(t)} ${new Date(t).toISOString().slice(11, 13)}h`}
      />
      <Legend
        className="mt-2"
        items={[
          { label: 'free GPUs with the changes', tone: 'signal' },
          { label: "free GPUs in today's book (dashed)", tone: 'neutral' },
        ]}
      />
    </Panel>
  );
}
