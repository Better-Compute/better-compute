'use client';

import { useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { RiCompass3Line, RiDownload2Line, RiPuzzle2Line, RiSettings3Line, RiUpload2Line } from 'react-icons/ri';
import { ConnectionPanel } from './connection-panel';
import { TOUR_EVENT } from './tour';
import { Button } from '@/components/base/buttons/button';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import { Grid, KeyValue, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { loadState, saveState, STORAGE_KEY, type DashboardState } from '@/components/widgets/layout';
import { modules } from '@/lib/modules';
import { RANGES, useWorkspace, type Density, type RangeKey } from './workspace';

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-separator-border/70 py-3 last:border-0">
      <div className="min-w-0">
        <div className="text-body-medium text-text-primary">{label}</div>
        {hint && <div className="text-caption-1-regular text-text-secondary">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Preferences, dashboard import/export and the installed modules. */
export function SettingsPage() {
  const { resolvedTheme, setTheme } = useTheme();
  const workspace = useWorkspace();
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const exportLayouts = () => {
    const blob = new Blob([JSON.stringify(loadState(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'better-compute-dashboards.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importLayouts = async (input: File) => {
    try {
      const parsed = JSON.parse(await input.text()) as DashboardState;
      if (parsed.version !== 1 || !Array.isArray(parsed.dashboards)) throw new Error('not a dashboards file');
      saveState(parsed);
      setMessage(`Imported ${parsed.dashboards.length} dashboards. Open the Overview to see them.`);
    } catch (error) {
      setMessage(`Import failed: ${(error as Error).message}`);
    }
  };

  return (
    <>
      <PageHeader icon={RiSettings3Line} title="Settings" description="Preferences are kept in this browser. Dashboards can be exported and shared as a file." />
      <Grid>
        <Panel className="col-span-12 lg:col-span-7" title="Workspace">
          <Row label="Theme" hint="Dark is the control-room default.">
            <SegmentedControl selectedKeys={[resolvedTheme ?? 'dark']} onSelectionChange={(keys) => setTheme([...keys][0] as string)} aria-label="Theme">
              <SegmentedControlItem id="dark">Dark</SegmentedControlItem>
              <SegmentedControlItem id="light">Light</SegmentedControlItem>
            </SegmentedControl>
          </Row>
          <Row label="Density" hint="Row height in tables and lists.">
            <SegmentedControl selectedKeys={[workspace.density]} onSelectionChange={(keys) => workspace.setDensity([...keys][0] as Density)} aria-label="Density">
              <SegmentedControlItem id="comfortable">Comfortable</SegmentedControlItem>
              <SegmentedControlItem id="compact">Compact</SegmentedControlItem>
            </SegmentedControl>
          </Row>
          <Row label="Time range" hint="The default window for charts and trends.">
            <SegmentedControl selectedKeys={[workspace.range]} onSelectionChange={(keys) => workspace.setRange([...keys][0] as RangeKey)} aria-label="Time range">
              {(Object.keys(RANGES) as RangeKey[]).map((key) => (
                <SegmentedControlItem key={key} id={key}>
                  {key}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Row>
          <Row label="Tour" hint="A one-minute walk through search, scope, time travel, dashboards and the status bar.">
            <Button variant="secondary" size="small" leadingIcon={RiCompass3Line} onClick={() => window.dispatchEvent(new Event(TOUR_EVENT))}>
              Take the tour
            </Button>
          </Row>
          <Row label="Live updates" hint="Pause to freeze every view on one instant (p).">
            <SegmentedControl selectedKeys={[workspace.live ? 'live' : 'paused']} onSelectionChange={(keys) => workspace.setLive([...keys][0] === 'live')} aria-label="Live updates">
              <SegmentedControlItem id="live">Live</SegmentedControlItem>
              <SegmentedControlItem id="paused">Paused</SegmentedControlItem>
            </SegmentedControl>
          </Row>
        </Panel>
        <Panel className="col-span-12 lg:col-span-5" title="Dashboards">
          <p className="mb-3 text-body-regular text-text-secondary">
            Layouts live in this browser under <Mono>{STORAGE_KEY}</Mono>. Export them to share a dashboard with the team, or import one.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="small" leadingIcon={RiDownload2Line} onClick={exportLayouts}>
              Export JSON
            </Button>
            <Button variant="secondary" size="small" leadingIcon={RiUpload2Line} onClick={() => file.current?.click()}>
              Import JSON
            </Button>
            <input ref={file} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void importLayouts(e.target.files[0])} />
          </div>
          {message && <p className="mt-3 font-mono text-[12px] text-signal">{message}</p>}
          <div className="mt-5 border-t border-separator-border pt-4">
            <KeyValue
              items={[
                { label: 'Data source', value: <Tag status={workspace.source === 'simulated' ? 'pending' : 'live'}>{workspace.source}</Tag> },
                { label: 'Clock', value: workspace.live ? 'live, 2 s tick' : 'paused', mono: true },
              ]}
            />
          </div>
        </Panel>
        <ConnectionPanel />
        <Panel className="col-span-12" title="Installed modules" icon={RiPuzzle2Line} meta={`${modules.length} modules`} flush>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
                <th className="px-3 py-2 font-medium">Module</th>
                <th className="px-3 py-2 font-medium">Pages</th>
                <th className="px-3 py-2 font-medium">Widgets</th>
                <th className="px-3 py-2 font-medium">Commands</th>
              </tr>
            </thead>
            <tbody>
              {modules.map((module) => (
                <tr key={module.id} className="border-b border-separator-border/70 align-top text-body-regular last:border-0">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-text-primary">{module.title}</div>
                    <Mono dim>{module.id}</Mono>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {module.nav.map((n) => (
                        <Tag key={n.href} status="ok" led={false}>
                          {n.href}
                        </Tag>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {module.widgets.map((w) => (
                        <Tag key={w.id} status="ok" led={false}>
                          {w.id}
                        </Tag>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[12px] text-text-secondary tabular-nums">{module.commands?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Grid>
    </>
  );
}
