'use client';

import { useMemo, useState } from 'react';
import { RiDownloadLine, RiFileCopyLine, RiFileTextLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { useFeedback } from '@/components/ui/feedback';
import { Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { fmtMoney, fmtNum, fmtPct, fmtStamp } from '@/lib/data/format';
import { useHourWindow, usePoolRows, useTenantName, useTimelines } from '../data';
import { useInsights } from '../insights';
import { costOf, fleetTotals, rollup, runway } from '../model';
import { SourceNotice } from '../source-notice';
import { Segmented } from '../ui';

// A capacity report for a period: the numbers a weekly review or a hardware order needs, as a page and as
// Markdown to paste into a doc or a channel. Everything is derived from the same data the other pages show.

const PERIODS = { '7d': 7, '14d': 14, '30d': 30 } as const;

/** Names come from tenants and operators: keep them from breaking a Markdown table or line. */
const md = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/([*_`[\]<>])/g, '\\$1');
type PeriodKey = keyof typeof PERIODS;

export function ReportPage() {
  const { toast } = useFeedback();
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const { visible: insights } = useInsights();
  const [period, setPeriod] = useState<PeriodKey>('7d');
  const days = PERIODS[period];
  const { from, hour } = useHourWindow(days * 24, 0);
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
  const history = useTimelines(
    gpuRows.map((row) => row.id),
    from,
    hour,
  );
  const runwayWindow = useHourWindow(14 * 24, 0);
  const runwayTimelines = useTimelines(
    gpuRows.map((row) => row.id),
    runwayWindow.from,
    runwayWindow.hour,
  );
  const totals = useMemo(() => fleetTotals(rows), [rows]);

  const pools = useMemo(
    () =>
      gpuRows.map((row) => {
        const timeline = history.get(row.id);
        const ratios = timeline ? timeline.buckets.map((b) => (timeline.allocatable ? Math.min(1, b.booked / timeline.allocatable) : 0)) : [];
        const avg = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
        const peak = Math.max(0, ...ratios);
        const fullHours = timeline ? timeline.buckets.filter((b) => b.free <= 0).length : 0;
        const trend = runwayTimelines.get(row.id) ? runway(runwayTimelines.get(row.id)!) : undefined;
        return { row, avg, peak, fullHours, trend };
      }),
    [gpuRows, history, runwayTimelines],
  );

  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const windows = useMemo(() => snapshot.usage.filter((w) => w.windowStart >= from && inScope.has(w.tags.poolId ?? '')), [snapshot.usage, from, inScope]);
  const tenants = useMemo(() => rollup(windows, (w) => w.tags.tenantId ?? '', snapshot.prices).slice(0, 8), [windows, snapshot.prices]);
  const gpuHoursByTenant = useMemo(() => {
    const map = new Map<string, number>();
    for (const w of windows) if (w.meter.startsWith('gpu.')) map.set(w.tags.tenantId ?? '', (map.get(w.tags.tenantId ?? '') ?? 0) + w.quantity);
    return map;
  }, [windows]);
  const spend = windows.reduce((sum, w) => sum + costOf(w, snapshot.prices), 0);
  const gpuHours = [...gpuHoursByTenant.values()].reduce((a, b) => a + b, 0);
  const fleetAvg = pools.length ? pools.reduce((sum, p) => sum + p.avg * p.row.allocatable, 0) / Math.max(1, pools.reduce((sum, p) => sum + p.row.allocatable, 0)) : 0;
  const tightest = [...pools].sort((a, b) => b.avg - a.avg)[0];
  const soonest = [...pools].filter((p) => p.trend?.daysToCeiling !== undefined).sort((a, b) => a.trend!.daysToCeiling! - b.trend!.daysToCeiling!)[0];

  const headline = [
    `Over the last ${days} days the fleet's GPU pools averaged ${fmtPct(fleetAvg, 0)} booked; ${fmtNum(totals.allocated)} of ${fmtNum(totals.allocatable)} schedulable GPUs are allocated now.`,
    tightest ? `${tightest.row.name} was the busiest (${fmtPct(tightest.avg, 0)} average, ${tightest.fullHours} h fully booked).` : '',
    soonest ? `At its 14-day trend, ${soonest.row.name} reaches 95% booked ${soonest.trend!.daysToCeiling === 0 ? 'already' : `in about ${Math.round(soonest.trend!.daysToCeiling!)} days`}.` : 'No pool trends toward 95% booked.',
    `${fmtNum(Math.round(gpuHours))} GPU-hours were used, about ${fmtMoney(spend, { short: true })} at list price.`,
  ]
    .filter(Boolean)
    .join(' ');

  const markdown = useMemo(() => {
    const lines = [
      `# Capacity report · ${fmtStamp(from)} → ${fmtStamp(hour)} UTC`,
      '',
      headline,
      '',
      '## Pools',
      '',
      '| Pool | Model | Avg booked | Peak | Hours full | Trend (pt/wk) | 95% in |',
      '|---|---|---:|---:|---:|---:|---:|',
      ...pools.map(
        (p) =>
          `| ${md(p.row.name)} | ${md(p.row.short)} | ${fmtPct(p.avg, 0)} | ${fmtPct(p.peak, 0)} | ${p.fullHours} | ${p.trend ? (p.trend.slopePerWeek * 100).toFixed(1) : '—'} | ${p.trend?.daysToCeiling === undefined ? '—' : p.trend.daysToCeiling === 0 ? 'already' : `${Math.round(p.trend.daysToCeiling)} d`} |`,
      ),
      '',
      '## Top tenants',
      '',
      '| Tenant | GPU-hours | Spend (list) |',
      '|---|---:|---:|',
      ...tenants.map((t) => `| ${md(tenantName(t.key))} | ${fmtNum(Math.round(gpuHoursByTenant.get(t.key) ?? 0))} | ${fmtMoney(t.cost)} |`),
      '',
      '## Open items',
      '',
      ...(insights.length ? insights.map((i) => `- **${i.severity}** · ${md(i.title)}: ${md(i.detail)}`) : ['- Nothing open.']),
      '',
      `_Source: ${snapshot.source === 'sim' ? 'simulated fleet' : 'live compute API'}; generated ${fmtStamp(snapshot.now)} UTC._`,
    ];
    return lines.join('\n');
  }, [from, hour, headline, pools, tenants, tenantName, gpuHoursByTenant, insights, snapshot.source, snapshot.now]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `capacity-report-${new Date(hour).toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiFileTextLine}
        title="Capacity report"
        description="The period's numbers in one place: how full each pool ran, where it is heading, who used it and what is open. Copy it as Markdown for a doc or a channel."
        meta={
          <Tag status="ok" led={false}>
            {fmtStamp(from)} → {fmtStamp(hour)} UTC
          </Tag>
        }
        actions={
          <>
            <Segmented label="Period" value={period} onChange={(value) => setPeriod(value as PeriodKey)} options={(Object.keys(PERIODS) as PeriodKey[]).map((id) => ({ id, label: id }))} />
            <Button
              size="small"
              variant="secondary"
              leadingIcon={RiFileCopyLine}
              onClick={() => {
                void navigator.clipboard?.writeText(markdown);
                toast({ title: 'Report copied as Markdown', status: 'ok' });
              }}
            >
              Copy Markdown
            </Button>
            <Button size="small" variant="secondary" leadingIcon={RiDownloadLine} onClick={download}>
              .md
            </Button>
          </>
        }
      />
      <Grid>
        <Panel className="col-span-12" title="Summary">
          <p className="max-w-4xl text-body-regular leading-6 text-text-primary">{headline}</p>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Avg booked</div>
              <div className="font-mono text-[22px] tabular-nums">{fmtPct(fleetAvg, 0)}</div>
            </div>
            <div>
              <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">GPU-hours</div>
              <div className="font-mono text-[22px] tabular-nums">{fmtNum(Math.round(gpuHours), { short: true })}</div>
            </div>
            <div>
              <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Spend (list)</div>
              <div className="font-mono text-[22px] tabular-nums">{fmtMoney(spend, { short: true })}</div>
            </div>
            <div>
              <div className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Open items</div>
              <div className="font-mono text-[22px] tabular-nums">{insights.length}</div>
            </div>
          </div>
        </Panel>

        <Panel className="col-span-12 xl:col-span-7" title="Pools" meta={`${days} days · trend over 14`} flush bodyClassName="overflow-x-auto">
          <table className="w-full text-body-regular">
            <thead>
              <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
                <th className="px-3 py-2 text-left font-normal">Pool</th>
                <th className="px-3 py-2 text-right font-normal">Avg</th>
                <th className="px-3 py-2 text-right font-normal">Peak</th>
                <th className="px-3 py-2 text-right font-normal">Full</th>
                <th className="px-3 py-2 text-right font-normal">Trend</th>
                <th className="px-3 py-2 text-right font-normal">95% in</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <tr key={p.row.id} className="border-b border-separator-border last:border-0">
                  <td className="px-3 py-1.5">
                    {p.row.name} <span className="font-mono text-[11px] text-text-tertiary">{p.row.short}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{fmtPct(p.avg, 0)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{fmtPct(p.peak, 0)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{p.fullHours} h</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{p.trend ? `${p.trend.slopePerWeek >= 0 ? '+' : '−'}${Math.abs(p.trend.slopePerWeek * 100).toFixed(1)}` : '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">
                    {p.trend?.daysToCeiling === undefined ? '—' : p.trend.daysToCeiling === 0 ? 'already' : `${Math.round(p.trend.daysToCeiling)} d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel className="col-span-12 xl:col-span-5" title="Top tenants" meta="GPU-hours · spend" flush>
          <ul>
            {tenants.map((t) => (
              <li key={t.key} className="grid grid-cols-[1fr_6rem_5rem] items-center gap-3 border-b border-separator-border px-3 py-1.5 last:border-0">
                <span className="truncate text-caption-1-medium">{tenantName(t.key)}</span>
                <span className="text-right font-mono text-[12px] tabular-nums">{fmtNum(Math.round(gpuHoursByTenant.get(t.key) ?? 0), { short: true })}</span>
                <span className="text-right font-mono text-[12px] tabular-nums">{fmtMoney(t.cost, { short: true })}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="col-span-12" title="Markdown" meta="what Copy puts on the clipboard">
          <pre className="max-h-80 overflow-auto bg-surface-sunken p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-text-secondary">{markdown}</pre>
        </Panel>
      </Grid>
    </>
  );
}
