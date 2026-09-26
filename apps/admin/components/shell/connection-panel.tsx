'use client';

import { useState } from 'react';
import { RiPlugLine, RiRefreshLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import { api, ApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/data';
import { KeyValue, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { useConnection } from './connection';
import { useWorkspace } from './workspace';

/** Settings → Connection: the compute API this admin talks to, whether it answers, and simulated vs live. */
export function ConnectionPanel() {
  const { status, refresh } = useConnection();
  const { dataSource, setDataSource, source, wallNow } = useWorkspace();
  const [path, setPath] = useState('system/version');
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState<{ ok: boolean; text: string; ms: number } | null>(null);

  const state = !status ? 'checking' : !status.configured ? 'not configured' : status.ok ? 'connected' : 'unreachable';
  const tone = state === 'connected' ? 'live' : state === 'unreachable' ? 'crit' : state === 'checking' ? 'pending' : 'off';

  const call = async () => {
    const started = performance.now();
    try {
      const data = await api.$request(path.trim(), JSON.parse(input || '{}'));
      setResult({ ok: true, text: JSON.stringify(data, null, 2), ms: Math.round(performance.now() - started) });
    } catch (error) {
      const e = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
      setResult({ ok: false, text: e, ms: Math.round(performance.now() - started) });
    }
  };

  return (
    <Panel id="connection" className="col-span-12" title="Connection" icon={RiPlugLine} meta="compute API" actions={<Button variant="ghost" size="xs" leadingIcon={RiRefreshLine} onClick={refresh}>Test</Button>}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <KeyValue
            items={[
              { label: 'State', value: <Tag status={tone}>{state}</Tag> },
              { label: 'Latency', value: status?.latencyMs !== undefined ? `${status.latencyMs} ms` : '—', mono: true },
              { label: 'API', value: status?.url ?? '—', mono: true },
              { label: 'Server', value: status?.server ? `${status.server.name} ${status.server.version} · protocol ${status.server.protocol.min}–${status.server.protocol.max}` : '—', mono: true },
              { label: 'Credential', value: status?.configured ? (status.authenticated ? 'bearer token (server-side)' : 'none: public methods only') : '—' },
              { label: 'Checked', value: status?.checkedAt ? fmtRelative(status.checkedAt, wallNow) : '—', mono: true },
            ]}
          />
          {status?.error && <p className="font-mono text-[12px] text-text-error-primary">{status.error.code}: {status.error.message}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-body-medium text-text-primary">Data source</span>
            <SegmentedControl selectedKeys={[dataSource]} onSelectionChange={(keys) => setDataSource([...keys][0] as 'simulated' | 'live')} aria-label="Data source">
              <SegmentedControlItem id="simulated">Simulated</SegmentedControlItem>
              <SegmentedControlItem id="live" isDisabled={!status?.ok}>Live API</SegmentedControlItem>
            </SegmentedControl>
            <span className="font-mono text-[11px] text-text-tertiary">now: {source}</span>
          </div>
          <p className="text-caption-1-regular text-text-secondary">
            The URL and token are set on the admin server, never in the browser, so this page can't be pointed at
            another host: <Mono>ADMIN_COMPUTE_URL</Mono>, <Mono>ADMIN_COMPUTE_TOKEN</Mono> and <Mono>ADMIN_COMPUTE_TENANT</Mono>, or
            the same keys in <Mono>apps/admin/.upstream.json</Mono> for local development. Modules that have a live source switch to
            it; the rest stay simulated, and time travel always replays the simulation.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Try a method</span>
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              aria-label="Method path"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 border border-border-button-default bg-background-primary-default px-2 font-mono text-[12px] text-text-primary outline-none focus:ring-2 focus:ring-border-focus-ring"
            />
            <Button size="small" onClick={() => void call()} disabled={!status?.configured}>
              Call
            </Button>
          </div>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            aria-label="Input JSON"
            rows={2}
            spellCheck={false}
            className="resize-none border border-border-button-default bg-background-primary-default px-2 py-1.5 font-mono text-[12px] text-text-primary outline-none focus:ring-2 focus:ring-border-focus-ring"
          />
          {result && (
            <pre className={`max-h-64 overflow-auto border border-separator-border bg-surface-sunken p-2 font-mono text-[11px] ${result.ok ? 'text-text-secondary' : 'text-text-error-primary'}`}>
              {result.ms} ms{'\n'}
              {result.text}
            </pre>
          )}
        </div>
      </div>
    </Panel>
  );
}
