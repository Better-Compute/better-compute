'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RiPulseLine } from 'react-icons/ri';
import { useConnection } from '@/components/shell/connection';
import { TimeSeriesChart } from '@/components/ui/charts';
import { Panel } from '@/components/ui/panel';
import { Led, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';

interface Sample {
  t: number;
  roundTripMs: number;
  databaseMs: number | null;
  ok: boolean;
}

const WINDOW = 60;

/**
 * Real numbers from the connected compute API: its /health every 5 s (round trip from the admin server and the
 * database latency the API reports). Only shown when an API is configured; everything else on the page is the
 * simulated control plane.
 */
export function LiveVitals() {
  const { status } = useConnection();
  const [samples, setSamples] = useState<Sample[]>([]);
  const configured = Boolean(status?.configured);

  useEffect(() => {
    if (!configured) return;
    let stopped = false;
    const sample = async () => {
      try {
        const response = await fetch('/api/upstream/health', { cache: 'no-store' });
        const body = (await response.json()) as { ok?: boolean; roundTripMs?: number; latencyMs?: number; database?: string };
        if (stopped) return;
        setSamples((all) =>
          [...all, { t: Date.now(), roundTripMs: body.roundTripMs ?? 0, databaseMs: typeof body.latencyMs === 'number' ? body.latencyMs : null, ok: Boolean(body.ok) && body.database !== 'error' }].slice(-WINDOW),
        );
      } catch {
        if (!stopped) setSamples((all) => [...all, { t: Date.now(), roundTripMs: 0, databaseMs: null, ok: false }].slice(-WINDOW));
      }
    };
    void sample();
    const timer = window.setInterval(() => void sample(), 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [configured]);

  if (!configured) {
    return (
      <Panel className="col-span-12" title="Live vitals" icon={RiPulseLine} meta="no API connected">
        <p className="text-body-regular text-text-secondary">
          Everything on this page is simulated. Connect a compute API in{' '}
          <Link href="/settings#connection" className="text-signal hover:underline">
            Settings → Connection
          </Link>{' '}
          to see its real health here.
        </p>
      </Panel>
    );
  }

  const last = samples.at(-1);
  const good = samples.filter((s) => s.ok);
  const avg = good.length ? good.reduce((sum, s) => sum + s.roundTripMs, 0) / good.length : 0;
  const worst = good.length ? Math.max(...good.map((s) => s.roundTripMs)) : 0;
  const uptime = samples.length ? good.length / samples.length : 1;

  return (
    <Panel
      className="col-span-12"
      title="Live vitals"
      icon={RiPulseLine}
      meta={status?.url}
      actions={<Tag status={last?.ok === false ? 'crit' : 'live'}>{last?.ok === false ? 'unhealthy' : 'live'}</Tag>}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Round trip" value={last ? `${last.roundTripMs}` : '—'} unit="ms" size="sm" hint={`avg ${avg.toFixed(1)} · worst ${worst.toFixed(1)}`} />
          <Stat label="Database" value={last?.databaseMs ?? '—'} unit="ms" size="sm" hint="as the API reports it" />
          <Stat label="Answered" value={`${Math.round(uptime * 100)}%`} size="sm" hint={`${samples.length} probes, every 5 s`} />
          <div className="flex flex-col justify-center gap-1">
            <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Server</span>
            <span className="flex items-center gap-2 font-mono text-[12px] text-text-primary">
              <Led status={status?.ok ? 'live' : 'crit'} />
              {status?.server ? `${status.server.name} ${status.server.version}` : 'unknown'}
            </span>
          </div>
        </div>
        {samples.length > 1 ? (
          <TimeSeriesChart
            height={160}
            times={samples.map((s) => s.t)}
            xFormat={(t) => new Date(t).toISOString().slice(14, 19)}
            yFormat={(v) => `${Math.round(v)}`}
            series={[
              { id: 'rtt', label: 'Round trip (ms)', values: samples.map((s) => s.roundTripMs), tone: 'signal', area: true },
              { id: 'db', label: 'Database (ms)', values: samples.map((s) => s.databaseMs ?? 0), tone: 'neutral', dashed: true },
            ]}
          />
        ) : (
          <p className="self-center font-mono text-[12px] text-text-tertiary">collecting samples…</p>
        )}
      </div>
    </Panel>
  );
}
