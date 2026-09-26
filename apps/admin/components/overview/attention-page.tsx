'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { RiAlarmWarningLine, RiCheckDoubleLine, RiCheckLine, RiArrowGoBackLine } from 'react-icons/ri';
import { fmtRelative, fmtStamp, HOUR, type AttentionItem } from '@/lib/data';
import { collectAttention } from '@/lib/modules';
import { Button } from '@/components/base/buttons/button';
import { usePageCommands } from '@/components/shell/page-commands';
import { useAcks } from '@/components/shell/pins';
import { useLive, useWorkspace } from '@/components/shell/workspace';
import { DataTable, type Column } from '@/components/ui/data-table';
import { useFeedback } from '@/components/ui/feedback';
import { Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, SeverityIcon, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';

type Row = AttentionItem & { state: 'open' | 'acknowledged' | 'resolved' };

// Few lookbacks: module attention reads their data sources (tens of ms per call).
const LOOKBACK = [1, 3, 8, 24];

/** The operator queue as a table: open, acknowledged and resolved in the last day, with bulk acknowledge. */
export function AttentionPage() {
  const router = useRouter();
  const { now } = useWorkspace();
  const acks = useAcks();
  const { toast } = useFeedback();
  const current = useLive((t, scope) => collectAttention(t, scope), { bucketMs: 10_000 });
  const past = useLive(
    (t, scope) => {
      const seen = new Map<string, AttentionItem>();
      for (const hours of LOOKBACK) for (const item of collectAttention(t - hours * HOUR, scope)) if (!seen.has(item.id)) seen.set(item.id, item);
      return [...seen.values()];
    },
    { bucketMs: 5 * 60_000 },
  );

  const rows = useMemo<Row[]>(() => {
    const open = new Set(current.map((i) => i.id));
    return [
      ...current.map((item) => ({ ...item, state: acks.has(item.id) ? ('acknowledged' as const) : ('open' as const) })),
      ...past.filter((item) => !open.has(item.id)).map((item) => ({ ...item, state: 'resolved' as const })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, past, acks.values]);

  const openRows = rows.filter((r) => r.state === 'open');
  const ackRows = (list: Row[]) => {
    const ids = list.filter((r) => r.state === 'open').map((r) => r.id);
    if (!ids.length) return;
    acks.add(ids);
    toast({ title: `Acknowledged ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`, status: 'ok', action: { label: 'undo', onAction: () => acks.remove(ids) } });
  };

  usePageCommands(
    useMemo(
      () => [
        { id: 'attention.ack-info', label: 'Acknowledge every info item', group: 'This page', icon: RiCheckLine, run: () => ackRows(openRows.filter((r) => r.severity === 'info')) },
        { id: 'attention.ack-all', label: 'Acknowledge everything open', group: 'This page', icon: RiCheckDoubleLine, run: () => ackRows(openRows) },
      ],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [openRows.length],
    ),
  );

  const columns: Column<Row>[] = [
    { id: 'severity', header: 'Sev', width: 56, value: (r) => ({ critical: 0, warning: 1, info: 2 })[r.severity], cell: (r) => <SeverityIcon severity={r.severity} /> },
    {
      id: 'title',
      header: 'Item',
      pinned: true,
      value: (r) => `${r.title} ${r.detail}`,
      cell: (r) => (
        <div className="min-w-0">
          <div className={r.state === 'open' ? 'truncate font-medium text-text-primary' : 'truncate text-text-secondary'}>{r.title}</div>
          <div className="truncate text-caption-1-regular text-text-tertiary">{r.detail}</div>
        </div>
      ),
    },
    { id: 'source', header: 'Owner', width: 96, value: (r) => r.source, cell: (r) => <Mono dim>{r.source}</Mono> },
    { id: 'subject', header: 'Subject', width: 200, value: (r) => r.subject, cell: (r) => <Mono dim>{r.subject}</Mono>, defaultHidden: false },
    { id: 'at', header: 'Opened', width: 120, align: 'right', value: (r) => r.at, cell: (r) => <span title={fmtStamp(r.at)} className="font-mono text-[12px] text-text-secondary" suppressHydrationWarning>{fmtRelative(r.at, now)}</span> },
    { id: 'state', header: 'State', width: 120, value: (r) => r.state, cell: (r) => <Tag status={r.state === 'open' ? (r.severity === 'critical' ? 'crit' : 'warn') : r.state === 'acknowledged' ? 'pending' : 'off'}>{r.state}</Tag> },
    {
      id: 'actions',
      header: '',
      width: 250,
      align: 'right',
      cell: (r) =>
        r.state === 'resolved' ? null : (
          <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {r.action && r.state !== 'acknowledged' && (
              <Link href={r.action.href} className="font-mono text-[11px] text-signal hover:underline">
                {r.action.label}
              </Link>
            )}
            {r.state === 'open' ? (
              <button type="button" onClick={() => ackRows([r])} className="font-mono text-[11px] text-signal hover:underline">ack</button>
            ) : (
              <button type="button" onClick={() => acks.remove([r.id])} className="font-mono text-[11px] text-text-tertiary hover:text-text-primary">unack</button>
            )}
            <Link href={r.href} className="font-mono text-[11px] text-text-secondary hover:text-text-primary">open →</Link>
          </span>
        ),
    },
  ];

  const count = (sev: string) => openRows.filter((r) => r.severity === sev).length;

  return (
    <>
      <PageHeader
        icon={RiAlarmWarningLine}
        title="Needs attention"
        description="Everything that needs an operator, from every module: failures, approvals waiting on a signature, quota pressure and forecasts. Acknowledging hides an item from the bell and the widget; it stays here until it resolves."
        actions={
          <Button size="small" variant="secondary" leadingIcon={RiCheckDoubleLine} onClick={() => ackRows(openRows)} disabled={!openRows.length}>
            Acknowledge all open
          </Button>
        }
      />
      <Grid>
        <Panel className="col-span-6 md:col-span-3"><Stat label="Critical open" value={count('critical')} tone="crit" hint="page the owner" /></Panel>
        <Panel className="col-span-6 md:col-span-3"><Stat label="Warnings open" value={count('warning')} hint="act today" /></Panel>
        <Panel className="col-span-6 md:col-span-3"><Stat label="Acknowledged" value={rows.filter((r) => r.state === 'acknowledged').length} hint="someone is on it" /></Panel>
        <Panel className="col-span-6 md:col-span-3"><Stat label="Resolved · 24h" value={rows.filter((r) => r.state === 'resolved').length} hint="cleared on their own or fixed" /></Panel>
        <Panel className="col-span-12" flush>
          <DataTable
            rows={rows}
            columns={columns}
            rowId={(r) => r.id}
            facets={[
              { id: 'state', label: 'State', value: (r) => r.state },
              { id: 'severity', label: 'Severity', value: (r) => r.severity },
              { id: 'source', label: 'Owner', value: (r) => r.source },
            ]}
            rowTone={(r) => (r.state !== 'open' ? undefined : r.severity === 'critical' ? 'crit' : r.severity === 'warning' ? 'warn' : undefined)}
            onRowClick={(r) => router.push(r.href)}
            initialSort={{ id: 'severity', dir: 'asc' }}
            exportName="attention"
            viewKey="attention"
            bulkActions={(selected, clear) => (
              <>
                <Button size="xs" variant="primary" leadingIcon={RiCheckLine} onClick={() => { ackRows(selected); clear(); }}>
                  Acknowledge
                </Button>
                <Button size="xs" variant="secondary" leadingIcon={RiArrowGoBackLine} onClick={() => { acks.remove(selected.map((r) => r.id)); clear(); }}>
                  Unacknowledge
                </Button>
              </>
            )}
          />
        </Panel>
      </Grid>
    </>
  );
}
