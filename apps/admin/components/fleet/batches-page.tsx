'use client';

import { useMemo, useState } from 'react';
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiFileCopyLine,
  RiQuillPenLine,
  RiRobot2Line,
  RiShieldCheckLine,
  RiUser3Line,
} from 'react-icons/ri';
import { useWorkspace } from '@/components/shell/workspace';
import { StackedBar } from '@/components/ui/charts';
import { useFeedback } from '@/components/ui/feedback';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { Led, Mono, Tag, type Status } from '@/components/ui/signal';
import type { BatchState, FleetSnapshot } from '@/lib/data/fleet';
import { fmtDuration, fmtRelative, fmtStamp } from '@/lib/data/format';
import { cx } from '@/utils/cx';
import { SubjectLink } from './activity-page';
import { useFleetCommands } from './commands';
import { ActionButton, CountChip, SectionLabel } from './ui';
import { useFleet } from './use-fleet';

// Quorum batches (PLAN §13): destructive commands (power, wipe, BMC firmware and credentials) are queued into a
// batch whose scope root the approvers sign; nothing runs until `requiredApprovals` keys have signed it.

type Batch = FleetSnapshot['batches'][number];

const batchStatus: Record<BatchState, Status> = { pending: 'pending', approved: 'live', expired: 'off', cancelled: 'off' };
const ME = 'you@legionedge.ai';

export function BatchesPage() {
  const snapshot = useFleet();
  const { now } = useWorkspace();
  const [filter, setFilter] = useState<BatchState | 'all'>('all');
  const counts = useMemo(() => {
    const out: Record<BatchState, number> = { pending: 0, approved: 0, expired: 0, cancelled: 0 };
    for (const batch of snapshot.batches) out[batch.state] += 1;
    return out;
  }, [snapshot.batches]);
  const batches = snapshot.batches
    .filter((batch) => filter === 'all' || batch.state === filter)
    .sort((a, b) => (a.state === 'pending' ? 0 : 1) - (b.state === 'pending' ? 0 : 1) || b.createdAt - a.createdAt);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Command batches"
        icon={RiShieldCheckLine}
        description="Destructive commands wait here under quorum: a batch runs only after enough approvers sign its scope root with their keys. Agents can propose batches; only people approve them."
      >
        <div className="flex flex-wrap gap-2">
          <CountChip status="pending" count={counts.pending} label="awaiting approval" active={filter === 'pending'} onPress={() => setFilter(filter === 'pending' ? 'all' : 'pending')} />
          <CountChip status="live" count={counts.approved} label="approved" active={filter === 'approved'} onPress={() => setFilter(filter === 'approved' ? 'all' : 'approved')} />
          <CountChip status="off" count={counts.expired} label="expired" active={filter === 'expired'} onPress={() => setFilter(filter === 'expired' ? 'all' : 'expired')} />
          <CountChip status="off" count={counts.cancelled} label="cancelled" active={filter === 'cancelled'} onPress={() => setFilter(filter === 'cancelled' ? 'all' : 'cancelled')} />
        </div>
      </PageHeader>
      {batches.length === 0 ? (
        <Panel>
          <EmptyState icon={RiShieldCheckLine} title="No batches here">
            Queued destructive commands show up here once approvers are configured (pki.approvers).
          </EmptyState>
        </Panel>
      ) : (
        batches.map((batch) => <BatchCard key={batch.batchId} batch={batch} now={now} />)
      )}
    </div>
  );
}

function BatchCard({ batch, now }: { batch: Batch; now: number }) {
  const commands = useFleetCommands();
  const { toast } = useFeedback();
  const [expanded, setExpanded] = useState(batch.state === 'pending' && batch.scopeSize <= 12);
  const signed = batch.approvals.length;
  const mine = batch.approvals.some((approval) => approval.approvedBy === ME);
  const left = batch.notAfter - now;
  const kind = batch.members[0]?.kind ?? 'command';
  const commandStates = Object.entries(batch.commands);

  return (
    <Panel
      className={cx(batch.state === 'pending' && 'border-signal-fill/40')}
      title={
        <span className="flex items-center gap-2">
          <Mono className="text-[12px]">{kind}</Mono>
          <span className="text-text-tertiary">×</span>
          <Mono className="text-[12px]">{batch.scopeSize}</Mono>
        </span>
      }
      meta={batch.batchId}
      actions={
        <Tag status={batchStatus[batch.state]}>
          {batch.state}
          {batch.state === 'pending' && ` · ${signed}/${batch.requiredApprovals}`}
        </Tag>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-body-medium text-text-primary">{batch.reason}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption-1-regular text-text-secondary">
            <span className="inline-flex items-center gap-1.5">
              {batch.createdByAgent ? <RiRobot2Line className="size-3.5 text-signal" aria-hidden /> : <RiUser3Line className="size-3.5" aria-hidden />}
              {batch.createdByAgent ? (
                <>
                  proposed by <Mono className="text-[12px]">{batch.createdByAgent}</Mono> under delegation <Mono dim>{batch.delegationId}</Mono>
                </>
              ) : (
                <>created by {batch.createdBy}</>
              )}
            </span>
            <span>{fmtRelative(batch.createdAt, now)}</span>
            <span className={cx(batch.state === 'pending' && left < 30 * 60_000 && 'text-signal')}>
              {batch.state === 'pending' ? (left > 0 ? `expires in ${fmtDuration(left)}` : 'expired') : batch.approvedAt ? `approved ${fmtStamp(batch.approvedAt)}` : `expired ${fmtStamp(batch.notAfter)}`}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Scope root</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(batch.scopeRoot);
                  toast({ title: 'Scope root copied', detail: 'Verify it offline with `better-compute batch show`.', status: 'ok' });
                }}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-text-tertiary hover:text-text-primary"
              >
                <RiFileCopyLine className="size-3" aria-hidden /> copy
              </button>
            </div>
            <code className="truncate border border-separator-border bg-surface-sunken px-2 py-1 font-mono text-[11px] text-text-secondary" title={batch.scopeRoot}>
              {batch.scopeRoot}
            </code>
            <span className="font-mono text-[10px] text-text-tertiary">trust domain {batch.trustDomain}</span>
          </div>

          {commandStates.length > 0 && (
            <div className="flex flex-col gap-1">
              <StackedBar
                height={6}
                parts={commandStates.map(([state, value]) => ({
                  label: state,
                  value,
                  tone: state === 'succeeded' ? 'neutral' : state === 'running' ? 'signal' : state === 'failed' ? 'crit' : state === 'cancelled' ? 'hatch' : 'muted',
                }))}
              />
              <span className="font-mono text-[11px] text-text-tertiary">{commandStates.map(([state, value]) => `${value} ${state}`).join(' · ')}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-separator-border lg:border-l lg:pl-4">
          <SectionLabel>
            Approvals {signed}/{batch.requiredApprovals}
          </SectionLabel>
          <ol className="flex flex-col gap-1.5">
            {Array.from({ length: Math.max(batch.requiredApprovals, signed) }, (_, index) => {
              const approval = batch.approvals[index];
              return (
                <li key={index} className={cx('flex items-center gap-2 border px-2 py-1.5', approval ? 'border-separator-border bg-surface-sunken' : 'border-dashed border-separator-border')}>
                  {approval ? <RiCheckboxCircleLine className="size-4 shrink-0 text-text-secondary" aria-hidden /> : <RiQuillPenLine className="size-4 shrink-0 text-text-tertiary" aria-hidden />}
                  {approval ? (
                    <>
                      <span className="truncate text-body-2-regular text-text-primary">{approval.approvedBy ?? approval.kid}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-text-tertiary">{fmtRelative(approval.at, now)}</span>
                    </>
                  ) : (
                    <span className="text-body-2-regular text-text-tertiary">signature {index + 1} needed</span>
                  )}
                </li>
              );
            })}
          </ol>
          {batch.state === 'pending' && (
            <div className="flex gap-1.5">
              <ActionButton primary icon={RiQuillPenLine} onPress={() => void commands.approveBatch(batch)} disabled={mine || left <= 0} title={mine ? 'You already signed this batch' : undefined}>
                {mine ? 'Signed' : 'Sign and approve'}
              </ActionButton>
              <ActionButton danger icon={RiCloseCircleLine} onPress={() => void commands.cancelBatch(batch)}>
                Cancel
              </ActionButton>
            </div>
          )}
        </div>
      </div>

      <button type="button" onClick={() => setExpanded(!expanded)} className="mt-3 inline-flex items-center gap-1 font-mono text-[11px] text-text-secondary hover:text-text-primary">
        {expanded ? <RiArrowDownSLine className="size-3.5" aria-hidden /> : <RiArrowRightSLine className="size-3.5" aria-hidden />}
        {batch.members.length} commands in scope
      </button>
      {expanded && (
        <div className="mt-2 max-h-72 overflow-y-auto border border-separator-border">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-surface-sunken">
              <tr className="border-b border-separator-border font-mono text-[10px] tracking-wider text-text-tertiary uppercase">
                <th className="px-2 py-1.5">Node</th>
                <th className="px-2 py-1.5">Leaf subject</th>
                <th className="px-2 py-1.5">Kind</th>
                <th className="px-2 py-1.5">State</th>
                <th className="px-2 py-1.5">Command</th>
              </tr>
            </thead>
            <tbody>
              {batch.members.map((member) => (
                <tr key={member.commandId} className="border-b border-separator-border/60 last:border-0">
                  <td className="px-2 py-1">
                    <SubjectLink subject={`node/${member.nodeId}`} />
                  </td>
                  <td className="px-2 py-1 font-mono text-[11px] text-text-secondary">{member.subject}</td>
                  <td className="px-2 py-1 font-mono text-[11px] text-text-secondary">{member.kind}</td>
                  <td className="px-2 py-1">
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
                      <Led status={member.state === 'succeeded' ? 'ok' : member.state === 'running' ? 'live' : member.state === 'cancelled' ? 'off' : 'pending'} className="size-1.5" />
                      {member.awaitingApproval ? 'awaiting approval' : member.state}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    <Mono dim className="text-[11px]">
                      {member.commandId}
                    </Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
