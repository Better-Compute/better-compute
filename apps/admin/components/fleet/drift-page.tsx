'use client';

import { RiCheckboxCircleLine, RiGitPullRequestLine } from 'react-icons/ri';
import { useWorkspace } from '@/components/shell/workspace';
import { EmptyState, KeyValue, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag, type Status } from '@/components/ui/signal';
import type { FleetChange } from '@/lib/data/fleet';
import { fmtRelative, fmtStamp } from '@/lib/data/format';
import { useFleet } from './use-fleet';

// Fleet drift (fleet.status): the applied FleetConfig against what the control plane holds now. Drift is what
// `better-compute fleet plan` would change; blocked changes need an operator before `fleet apply` can prune.

const actionStatus: Record<FleetChange['action'], Status> = { create: 'live', update: 'warn', delete: 'crit', unchanged: 'ok' };
const sign: Record<FleetChange['action'], string> = { create: '+', update: '~', delete: '−', unchanged: '=' };

export function DriftPage() {
  const snapshot = useFleet({ scoped: false });
  const { now } = useWorkspace();
  const status = snapshot.drift;
  const drift = status.drift;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Fleet drift"
        icon={RiGitPullRequestLine}
        description="The applied FleetConfig against the live control plane: what `better-compute fleet plan` would change, and what blocks it."
        meta={drift ? <Tag status="warn">drifted · {drift.changes.length} changes</Tag> : <Tag status="ok">converged</Tag>}
      />
      <Panel title="Applied plan">
        {status.applied ? (
          <KeyValue
            columns={4}
            items={[
              { label: 'Plan', value: status.applied.planHash, mono: true },
              { label: 'Applied', value: `${fmtStamp(status.applied.appliedAt)} · ${fmtRelative(status.applied.appliedAt, now)}` },
              { label: 'By', value: status.applied.appliedBy },
              { label: 'Checked', value: status.applied.checkedAt ? fmtRelative(status.applied.checkedAt, now) : '—' },
            ]}
          />
        ) : (
          <EmptyState title="No FleetConfig applied">Apply one with `better-compute fleet apply fleet.yaml`.</EmptyState>
        )}
      </Panel>
      <Panel title="Changes" meta={drift ? `${drift.summary.create} create · ${drift.summary.update} update · ${drift.summary.delete} delete · ${drift.summary.unchanged} unchanged` : undefined} flush>
        {!drift ? (
          <EmptyState icon={RiCheckboxCircleLine} title="In sync">Every site, pool, offer, quota, flavor and template matches the applied plan.</EmptyState>
        ) : (
          <ul className="divide-y divide-separator-border">
            {drift.changes.map((change) => (
              <li key={`${change.kind}:${change.name}`} className="grid grid-cols-[28px_120px_1fr_auto] items-start gap-3 px-3 py-2.5">
                <span className="font-mono text-[15px] leading-5 text-text-secondary">{sign[change.action]}</span>
                <span className="font-mono text-[11px] leading-5 text-text-tertiary">{change.kind}</span>
                <span className="min-w-0">
                  <span className="block font-mono text-[13px] text-text-primary">{change.name}</span>
                  {change.fields && <span className="block font-mono text-[11px] text-text-secondary">fields: {change.fields.join(', ')}</span>}
                  {change.blocked && <span className="block text-caption-1-regular text-text-error-primary">blocked: {change.blocked}</span>}
                  {change.note && <span className="block text-caption-1-regular text-text-tertiary">{change.note}</span>}
                </span>
                <Tag status={change.blocked ? 'crit' : actionStatus[change.action]}>{change.action}</Tag>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {drift && (
        <p className="text-caption-1-regular text-text-tertiary">
          Converge with <Mono dim>better-compute fleet plan fleet.yaml</Mono> then <Mono dim>fleet apply</Mono>; plan hash {drift.planHash}.
        </p>
      )}
    </div>
  );
}
