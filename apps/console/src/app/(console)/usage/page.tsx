'use client';

import { useEffect, useMemo, useState } from 'react';
import { createUsageView, usageCsv, usageView } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { Loading, StackedBar } from '@/components/ui';

const day = 24 * 3_600_000;
const palette = ['#2563eb', '#7c3aed', '#16a34a', '#d97706', '#dc2626', '#0891b2', '#9ca3af'];
const PRICES_KEY = 'better-compute.console.prices';

function loadPrices(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRICES_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    );
  } catch {
    return {};
  }
}

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * Usage and estimated spend (`usage.list`): the hourly windows billed to IAM, per meter, day, project and
 * person. Prices are this browser's estimate only; IAM billing holds the real ones.
 */
export default function UsagePage() {
  const { api, tenantId } = useConsole();
  const [days, setDays] = useState(7);
  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => setPrices(loadPrices()), []);

  const view = useMemo(() => {
    const to = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    return createUsageView(api, { tenantId, from: to - days * day, to });
  }, [api, tenantId, days]);
  const state = useStore(view);
  useEffect(() => {
    void view.refresh();
  }, [view]);
  // Prices apply to the loaded windows; changing one never reloads them.
  const loaded = state.value;
  const usage = useMemo(
    () =>
      loaded && {
        ...usageView(loaded.raw, {
          from: loaded.from,
          to: loaded.to,
          prices,
          truncated: loaded.truncated,
        }),
        raw: loaded.raw,
      },
    [loaded, prices],
  );

  const setPrice = (meter: string, value: string) => {
    const next = { ...prices };
    const parsed = Number(value);
    if (value === '' || !Number.isFinite(parsed) || parsed < 0) delete next[meter];
    else next[meter] = parsed;
    setPrices(next);
    try {
      localStorage.setItem(PRICES_KEY, JSON.stringify(next));
    } catch {
      // Private mode: prices last for this page only.
    }
  };

  const download = () => {
    if (!usage) return;
    const url = URL.createObjectURL(new Blob([usageCsv(usage.raw)], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `usage-${tenantId}-${new Date(usage.from).toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const meters = usage?.meters.map((total) => total.meter) ?? [];
  const colorOf = (meter: string) => palette[meters.indexOf(meter) % palette.length]!;
  const peak = Math.max(
    1,
    ...(usage?.days.map((entry) => Object.values(entry.byMeter).reduce((a, b) => a + b, 0)) ?? []),
  );

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Usage &amp; spend</h2>
        <div className="row">
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button onClick={download} disabled={!usage?.raw.length}>
            Download CSV
          </button>
        </div>
      </div>
      <Loading status={state.status} error={state.error}>
        {usage && (
          <>
            {usage.truncated && (
              <p className="warning">
                The range has more windows than the console loads; totals are partial. Use a shorter
                range or the CSV export from the CLI.
              </p>
            )}
            {usage.deadLettered > 0 && (
              <p className="error">
                {usage.deadLettered} window(s) could not be billed (dead-lettered); an operator must
                redeliver them.
              </p>
            )}
            <section className="panel">
              <h3>Totals</h3>
              {usage.meters.length === 0 ? (
                <p className="muted">No usage in this range.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Meter</th>
                      <th>Quantity</th>
                      <th>Price / unit (estimate)</th>
                      <th>Estimated cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.meters.map((total) => (
                      <tr key={total.meter}>
                        <td>
                          <span className="swatch" style={{ background: colorOf(total.meter) }} />{' '}
                          {total.meter}
                        </td>
                        <td>{number(total.quantity)}</td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            style={{ width: 110 }}
                            defaultValue={prices[total.meter] ?? ''}
                            onBlur={(event) => setPrice(total.meter, event.target.value)}
                          />
                        </td>
                        <td>{total.cost === undefined ? '—' : number(total.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {usage.cost !== undefined && (
                <p>
                  <strong>Estimated total: {number(usage.cost)}</strong>{' '}
                  <span className="muted">(IAM billing has the invoiced amount)</span>
                </p>
              )}
            </section>
            <section className="panel">
              <h3>By day</h3>
              <table>
                <tbody>
                  {usage.days.map((entry) => {
                    const total = Object.values(entry.byMeter).reduce((a, b) => a + b, 0);
                    return (
                      <tr key={entry.day}>
                        <th style={{ whiteSpace: 'nowrap' }}>{entry.day}</th>
                        <td style={{ width: '70%' }}>
                          <div style={{ width: `${(100 * total) / peak}%` }}>
                            <StackedBar
                              total={total}
                              parts={Object.entries(entry.byMeter).map(([meter, value]) => ({
                                label: meter,
                                value,
                                color: colorOf(meter),
                              }))}
                            />
                          </div>
                        </td>
                        <td>{number(total)}</td>
                        <td className="muted">
                          {entry.cost === undefined ? '' : number(entry.cost)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <section className="panel" style={{ flex: 1 }}>
                <h3>By project</h3>
                <Breakdown
                  rows={usage.byProject.map((entry) => ({ key: entry.project, ...entry }))}
                />
              </section>
              <section className="panel" style={{ flex: 1 }}>
                <h3>By person or agent</h3>
                <Breakdown
                  rows={usage.byIdentity.map((entry) => ({ key: entry.identityId, ...entry }))}
                />
              </section>
            </div>
          </>
        )}
      </Loading>
    </>
  );
}

function Breakdown({ rows }: { rows: { key: string; quantity: number; cost?: number }[] }) {
  if (rows.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <table>
      <tbody>
        {rows.slice(0, 20).map((row) => (
          <tr key={row.key}>
            <td>{row.key}</td>
            <td>{number(row.quantity)}</td>
            <td className="muted">{row.cost === undefined ? '' : number(row.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
