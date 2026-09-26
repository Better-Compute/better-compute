'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { RiAddLine, RiBox3Line, RiCameraLensLine, RiDeleteBin6Line, RiFileCopyLine, RiFireLine, RiTimeLine } from 'react-icons/ri';
import { EntityLink } from '@/components/shell/peek';
import { useNow } from '@/components/shell/workspace';
import { Legend } from '@/components/ui/charts';
import { DataTable, type Column, type Facet } from '@/components/ui/data-table';
import { useFeedback } from '@/components/ui/feedback';
import { Drawer } from '@/components/ui/overlay';
import { KeyValue, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import { drift, MINUTE } from '@/lib/data/core';
import type { FleetSnapshot, Sandbox, SandboxTemplate } from '@/lib/data/fleet';
import { fmtBytes, fmtDuration, fmtNum, fmtPct, fmtRelative, fmtStamp } from '@/lib/data/format';
import { poolById, tenantById } from '@/lib/data/topology';
import { cx } from '@/utils/cx';
import { LiveNotice } from './live-notice';
import { useFleetCommands } from './commands';
import { ActionButton, SectionLabel, sandboxStatus } from './ui';
import { useFleet } from './use-fleet';

// Sandboxes (PLAN §3.7): short-lived microVMs for agents, claimed from per-template warm pools, deleted at their
// TTL unless extended. The page watches the pools and the population; the drawer is one sandbox.

const bootMs = (sandbox: Sandbox) => (sandbox.readyAt ? sandbox.readyAt - sandbox.createdAt : undefined);

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Idle warm VMs a template holds right now (bcd keeps between min and max; claims drain it). */
export function warmIdle(template: SandboxTemplate, now: number): number {
  const { min, max } = template.warm;
  if (max === 0) return 0;
  return Math.round(min + (max - min) * drift(`${template.id}:warm`, now, 7 * MINUTE));
}

function TtlBar({ sandbox, now }: { sandbox: Sandbox; now: number }) {
  const total = sandbox.expiresAt - sandbox.createdAt;
  const left = Math.max(0, sandbox.expiresAt - now);
  const ratio = total > 0 ? left / total : 0;
  const soon = left < 5 * MINUTE;
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="h-1 min-w-8 flex-1 bg-background-secondary-default">
        <span className="block h-full" style={{ width: `${ratio * 100}%`, background: soon ? 'var(--color-signal-fill)' : 'var(--color-text-secondary)' }} />
      </span>
      <span className={cx('w-14 shrink-0 text-right font-mono text-[11px] tabular-nums', soon ? 'text-signal' : 'text-text-secondary')}>{left ? fmtDuration(left).split(' ')[0] : 'expired'}</span>
    </span>
  );
}

export function SandboxesPage() {
  const snapshot = useFleet();
  const now = useNow(5_000);
  const commands = useFleetCommands();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get('sandbox') ?? undefined;
  const setOpen = (id?: string) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('sandbox', id);
    else next.delete('sandbox');
    router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
  };
  const templates = new Map(snapshot.templates.map((template) => [template.id, template]));
  const sandboxes = snapshot.sandboxes;
  const ready = sandboxes.filter((sandbox) => sandbox.state === 'ready');
  const recent = sandboxes.filter((sandbox) => now - sandbox.createdAt < 30 * MINUTE);
  const warmHits = recent.filter((sandbox) => sandbox.warm).length;
  const warmBoot = median(sandboxes.filter((s) => s.warm).map(bootMs).filter((v): v is number => v !== undefined));
  const coldBoot = median(sandboxes.filter((s) => !s.warm).map(bootMs).filter((v): v is number => v !== undefined));
  const expiring = ready.filter((sandbox) => sandbox.expiresAt - now < 5 * MINUTE).length;
  const open = openId ? sandboxes.find((sandbox) => sandbox.id === openId) : undefined;

  const columns: Column<Sandbox>[] = [
    { id: 'id', header: 'Sandbox', pinned: true, width: 180, value: (s) => s.id, cell: (s) => <Mono>{s.id}</Mono> },
    { id: 'template', header: 'Template', width: 130, value: (s) => templates.get(s.templateId)?.name ?? '', cell: (s) => <span className="text-text-secondary">{templates.get(s.templateId)?.name}</span> },
    {
      id: 'state',
      header: 'State',
      width: 110,
      value: (s) => s.state,
      cell: (s) => <Tag status={sandboxStatus[s.state]}>{s.state}</Tag>,
    },
    { id: 'tenant', header: 'Tenant', width: 140, value: (s) => tenantById(s.tenantId)?.name ?? s.tenantId, cell: (s) => <span className="text-text-secondary">{tenantById(s.tenantId)?.name}</span> },
    { id: 'ttl', header: 'TTL left', width: 150, value: (s) => s.expiresAt - now, cell: (s) => <TtlBar sandbox={s} now={now} /> },
    {
      id: 'boot',
      header: 'Ready in',
      width: 100,
      align: 'right',
      value: (s) => bootMs(s) ?? -1,
      cell: (s) => (
        <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-text-secondary">
          {s.warm && <RiFireLine className="size-3 text-signal" aria-label="from the warm pool" />}
          {bootMs(s) !== undefined ? fmtDuration(bootMs(s)!) : '—'}
        </span>
      ),
    },
    { id: 'node', header: 'Node', width: 150, value: (s) => s.nodeId ?? '', cell: (s) => (s.nodeId ? <EntityLink kind="node" id={s.nodeId}>{s.nodeId.replace(/^n-/, '')}</EntityLink> : <span className="text-text-tertiary">—</span>) },
    { id: 'snap', header: 'Snap', width: 60, align: 'center', value: (s) => s.snapshots?.length ?? 0, cell: (s) => (s.snapshots?.length ? <RiCameraLensLine className="mx-auto size-3.5 text-text-secondary" aria-label="has a snapshot" /> : null) },
    { id: 'created', header: 'Created', width: 90, value: (s) => -s.createdAt, cell: (s) => <span className="font-mono text-[11px] text-text-tertiary">{fmtRelative(s.createdAt, now)}</span> },
    { id: 'owner', header: 'Agent', width: 150, defaultHidden: true, value: (s) => s.ownerIdentityId, cell: (s) => <Mono dim>{s.ownerIdentityId}</Mono> },
  ];
  const facets: Facet<Sandbox>[] = [
    { id: 'template', label: 'Template', value: (s) => templates.get(s.templateId)?.name ?? s.templateId },
    { id: 'state', label: 'State', value: (s) => s.state },
    { id: 'tenant', label: 'Tenant', value: (s) => tenantById(s.tenantId)?.name ?? s.tenantId },
    { id: 'warm', label: 'Pool', value: (s) => (s.warm ? 'warm' : 'cold') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <LiveNotice />
      <PageHeader
        title="Sandboxes"
        icon={RiBox3Line}
        description="Short-lived microVMs for agents: claimed from per-template warm pools in about a second, reached over exec tunnels, deleted at their TTL unless extended."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Panel>
          <Stat label="Live" value={fmtNum(ready.length)} hint={`${sandboxes.filter((s) => s.state === 'starting').length} starting`} />
        </Panel>
        <Panel>
          <Stat label="Warm-pool hits" value={recent.length ? fmtPct(warmHits / recent.length, 0) : '—'} hint={`${warmHits} of ${recent.length} in 30 min`} />
        </Panel>
        <Panel>
          <Stat label="Ready · warm" value={warmBoot !== undefined ? fmtDuration(warmBoot) : '—'} hint="median, claim to ready" />
        </Panel>
        <Panel>
          <Stat label="Ready · cold" value={coldBoot !== undefined ? fmtDuration(coldBoot) : '—'} hint="median, boot to ready" />
        </Panel>
        <Panel>
          <Stat label="Expiring ≤ 5 min" value={fmtNum(expiring)} hint="deleted unless extended" />
        </Panel>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <Panel title="Templates and warm pools" flush className="col-span-12 xl:col-span-7">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-separator-border font-mono text-[10px] tracking-wider text-text-tertiary uppercase">
                <th className="px-3 py-2">Template</th>
                <th className="px-3 py-2">Runtime · pool</th>
                <th className="px-3 py-2">Network</th>
                <th className="w-48 px-3 py-2">Warm pool</th>
                <th className="px-3 py-2 text-right">Live</th>
                <th className="px-3 py-2 text-right">TTL</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.templates.map((template) => {
                const idle = warmIdle(template, now);
                const live = sandboxes.filter((s) => s.templateId === template.id && s.state === 'ready').length;
                return (
                  <tr key={template.id} className="border-b border-separator-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-mono text-[12px] text-text-primary">{template.name}</div>
                      <div className="font-mono text-[10px] text-text-tertiary">
                        {template.flavor} · v{template.version}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-caption-1-regular text-text-secondary">
                      {template.runtime}
                      <div className="text-text-tertiary">{poolById(template.poolId)?.name}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Tag status={template.network === 'none' ? 'off' : 'ok'} led={false}>
                        {template.network}
                      </Tag>
                    </td>
                    <td className="px-3 py-2">
                      {template.warm.max ? (
                        <div className="flex flex-col gap-1">
                          <div className="relative h-2 bg-background-secondary-default">
                            <span className="absolute inset-y-0 left-0 bg-signal-fill" style={{ width: `${(idle / template.warm.max) * 100}%` }} />
                            <span className="absolute inset-y-[-2px] w-px bg-text-primary" style={{ left: `${(template.warm.min / template.warm.max) * 100}%` }} title={`min ${template.warm.min}`} />
                          </div>
                          <span className="font-mono text-[10px] text-text-tertiary">
                            {idle} idle · min {template.warm.min} · max {template.warm.max}
                          </span>
                        </div>
                      ) : (
                        <span className="font-mono text-[11px] text-text-tertiary">cold only</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-text-primary">{live}</td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-text-secondary">
                      {fmtDuration(template.defaultTtlSeconds * 1000)}
                      <div className="text-text-tertiary">max {fmtDuration(template.maxTtlSeconds * 1000)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
        <Panel title="Time to ready" meta="claim or boot → ready" className="col-span-12 xl:col-span-5">
          <BootHistogram sandboxes={sandboxes} />
        </Panel>
      </div>

      <Panel flush>
        <DataTable
          rows={sandboxes}
          columns={columns}
          facets={facets}
          rowId={(s) => s.id}
          onRowClick={(s) => setOpen(s.id)}
          activeId={openId}
          searchPlaceholder="Filter by id, template, tenant…"
          initialSort={{ id: 'created', dir: 'asc' }}
          exportName="sandboxes"
            viewKey="sandboxes"
          rowTone={(s) => (s.state === 'failed' ? 'crit' : s.expiresAt - now < 5 * MINUTE && s.state === 'ready' ? 'warn' : undefined)}
          bulkActions={(selected, clear) => (
            <>
              <ActionButton icon={RiTimeLine} onPress={() => (commands.extendSandboxes(selected, 30 * 60), clear())}>
                Extend 30 min
              </ActionButton>
              <ActionButton icon={RiDeleteBin6Line} danger onPress={() => void commands.deleteSandboxes(selected).then(clear)}>
                Delete
              </ActionButton>
            </>
          )}
          maxHeight="60dvh"
        />
      </Panel>

      <Drawer open={Boolean(open)} onOpenChange={(isOpen) => !isOpen && setOpen(undefined)} title={open?.id ?? ''} subtitle={open ? templates.get(open.templateId)?.name : undefined} width={600}>
        {open && <SandboxDetail sandbox={open} snapshot={snapshot} />}
      </Drawer>
    </div>
  );
}

const BINS = [
  { label: '<1s', max: 1_000 },
  { label: '1–2s', max: 2_000 },
  { label: '2–5s', max: 5_000 },
  { label: '5–10s', max: 10_000 },
  { label: '10–20s', max: 20_000 },
  { label: '20s+', max: Infinity },
];

function BootHistogram({ sandboxes }: { sandboxes: readonly Sandbox[] }) {
  const counts = BINS.map(() => ({ warm: 0, cold: 0 }));
  for (const sandbox of sandboxes) {
    const ms = bootMs(sandbox);
    if (ms === undefined) continue;
    const bin = BINS.findIndex((each) => ms < each.max);
    counts[bin]![sandbox.warm ? 'warm' : 'cold'] += 1;
  }
  const max = Math.max(1, ...counts.map((c) => Math.max(c.warm, c.cold)));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-36 items-end gap-3 border-b border-separator-border px-1">
        {counts.map((count, index) => (
          <div key={BINS[index]!.label} className="flex h-full flex-1 flex-col justify-end">
            <div className="flex h-full items-end justify-center gap-0.5">
              {(['warm', 'cold'] as const).map((kind) => (
                <span
                  key={kind}
                  title={`${count[kind]} ${kind} · ${BINS[index]!.label}`}
                  className="w-full max-w-4 rounded-t-[2px]"
                  style={{ height: `${(count[kind] / max) * 100}%`, minHeight: count[kind] ? 2 : 0, background: kind === 'warm' ? 'var(--color-signal-fill)' : 'var(--color-text-secondary)' }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-3 px-1">
        {BINS.map((bin) => (
          <span key={bin.label} className="flex-1 text-center font-mono text-[10px] text-text-tertiary">
            {bin.label}
          </span>
        ))}
      </div>
      <Legend
        items={[
          { label: 'warm pool claim', tone: 'signal' },
          { label: 'cold boot', tone: 'neutral' },
        ]}
      />
    </div>
  );
}

/** One sandbox: lifecycle, TTL, placement, exec, snapshots and actions (the drawer and the peek). */
export function SandboxDetail({ sandbox, snapshot }: { sandbox: Sandbox; snapshot: FleetSnapshot }) {
  const now = useNow(5_000);
  const commands = useFleetCommands();
  const { toast } = useFeedback();
  const template = snapshot.templates.find((each) => each.id === sandbox.templateId);
  const exec = `better-compute sandbox exec ${sandbox.id} -- bash`;
  const left = sandbox.expiresAt - now;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag status={sandboxStatus[sandbox.state]}>{sandbox.state}</Tag>
        <Tag status="ok" led={false}>
          instance {sandbox.instanceState}
        </Tag>
        {sandbox.warm && (
          <Tag status="live" led={false}>
            warm claim
          </Tag>
        )}
        {sandbox.identityRebound && <Tag status="ok">identity rebound</Tag>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <ActionButton icon={RiAddLine} onPress={() => commands.extendSandboxes([sandbox], 30 * 60)} disabled={sandbox.state !== 'ready'}>
          Extend 30 min
        </ActionButton>
        <ActionButton icon={RiAddLine} onPress={() => commands.extendSandboxes([sandbox], 2 * 3600)} disabled={sandbox.state !== 'ready'}>
          Extend 2 h
        </ActionButton>
        <ActionButton icon={RiDeleteBin6Line} danger onPress={() => void commands.deleteSandboxes([sandbox])} disabled={sandbox.state === 'deleting'}>
          Delete
        </ActionButton>
      </div>
      <div>
        <SectionLabel>Lifetime</SectionLabel>
        <TtlBar sandbox={sandbox} now={now} />
        <p className="mt-1 font-mono text-[11px] text-text-tertiary">
          created {fmtStamp(sandbox.createdAt)} · {left > 0 ? `deleted in ${fmtDuration(left)}` : 'past its TTL'} · TTL {fmtDuration(sandbox.ttlSeconds * 1000)}
          {template && ` (max ${fmtDuration(template.maxTtlSeconds * 1000)})`}
        </p>
      </div>
      <div>
        <SectionLabel>Placement</SectionLabel>
        <KeyValue
          items={[
            { label: 'Template', value: template ? `${template.name} · ${template.flavor}` : sandbox.templateId },
            { label: 'Runtime', value: template?.runtime ?? '—' },
            { label: 'Node', value: sandbox.nodeId ? <EntityLink kind="node" id={sandbox.nodeId}>{sandbox.nodeId.replace(/^n-/, '')}</EntityLink> : '—' },
            { label: 'Address', value: sandbox.addresses.join(', '), mono: true },
            { label: 'Network', value: template?.network ?? '—' },
            { label: 'Ready in', value: bootMs(sandbox) !== undefined ? fmtDuration(bootMs(sandbox)!) : 'not yet', mono: true },
            { label: 'Tenant', value: tenantById(sandbox.tenantId)?.name ?? sandbox.tenantId },
            { label: 'Agent', value: sandbox.ownerIdentityId, mono: true },
            { label: 'Instance', value: sandbox.instanceId, mono: true },
          ]}
        />
      </div>
      <div>
        <SectionLabel>Exec</SectionLabel>
        <div className="flex items-center gap-2 border border-separator-border bg-surface-sunken px-2 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">{exec}</code>
          <button
            type="button"
            aria-label="Copy exec command"
            onClick={() => {
              void navigator.clipboard?.writeText(exec);
              toast({ title: 'Copied', detail: 'Exec runs over a tunnel with a short-lived SSH certificate for this sandbox.', status: 'ok' });
            }}
            className="text-text-tertiary hover:text-text-primary"
          >
            <RiFileCopyLine className="size-4" aria-hidden />
          </button>
        </div>
        <p className="mt-1 text-caption-1-regular text-text-tertiary">No agent runs in the guest: exec is sandboxes.exec → a tunnel through the node&apos;s gateway session and an SSH certificate the guest trusts.</p>
      </div>
      {sandbox.snapshots?.length ? (
        <div>
          <SectionLabel>Snapshots</SectionLabel>
          <ul className="flex flex-col gap-1">
            {sandbox.snapshots.map((snap) => (
              <li key={snap.id} className="flex items-center gap-3 border border-separator-border px-3 py-2">
                <RiCameraLensLine className="size-4 text-text-tertiary" aria-hidden />
                <Mono>{snap.id}</Mono>
                <Tag status={snap.state === 'ready' ? 'ok' : 'pending'}>{snap.state}</Tag>
                <span className="text-caption-1-regular text-text-secondary">{snap.includeMemory ? 'disk + memory' : 'disk'}</span>
                {snap.keep && <Tag status="ok" led={false}>keep</Tag>}
                <span className="ml-auto font-mono text-[11px] text-text-tertiary">{snap.sizeBytes ? fmtBytes(snap.sizeBytes) : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
