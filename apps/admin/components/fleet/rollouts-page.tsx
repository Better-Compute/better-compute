'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { RiPauseLine, RiPlayLine, RiRocket2Line, RiStopLine } from 'react-icons/ri';
import { useWorkspace } from '@/components/shell/workspace';
import { Meter, StackedBar } from '@/components/ui/charts';
import { KeyValue, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag, type Status } from '@/components/ui/signal';
import { CURRENT_BCD, rolloutNodeStates, type FleetSnapshot, type RolloutNodeState, type RolloutState } from '@/lib/data/fleet';
import { fmtDuration, fmtPct, fmtRelative, fmtStamp } from '@/lib/data/format';
import { poolById } from '@/lib/data/topology';
import { cx } from '@/utils/cx';
import { LiveNotice } from './live-notice';
import { useFleetCommands } from './commands';
import { countBy } from './filters';
import { ActionButton, SectionLabel, rolloutNodeStatus } from './ui';
import { useFleet } from './use-fleet';

// bcd rollouts (rollout module): a release goes out in waves (1%, 5%, 25%, 100% of the eligible nodes), each
// soaking before the next; the rollout stops by itself when failures pass maxFailureRatio.

type RolloutView = FleetSnapshot['rollouts'][number];

const rolloutStatus: Record<RolloutState, Status> = { running: 'live', paused: 'warn', completed: 'ok', aborted: 'crit' };
const stateTone: Record<RolloutNodeState, 'signal' | 'neutral' | 'muted' | 'crit' | 'hatch'> = {
  succeeded: 'neutral',
  upgrading: 'signal',
  pending: 'muted',
  failed: 'crit',
  skipped: 'hatch',
  'rolling-back': 'crit',
  'rolled-back': 'hatch',
};

export function RolloutsPage() {
  const snapshot = useFleet();
  const { now } = useWorkspace();
  const current = snapshot.rollouts.find((rollout) => rollout.state === 'running' || rollout.state === 'paused');
  const versions = useMemo(() => countBy(snapshot.nodes, (node) => node.daemonVersion), [snapshot.nodes]);
  const history = snapshot.rollouts.filter((rollout) => rollout !== current);
  return (
    <div className="flex flex-col gap-4">
      <LiveNotice />
      <PageHeader
        title="Rollouts"
        icon={RiRocket2Line}
        description="bcd releases go out wave by wave; each wave soaks before the next, and the rollout halts itself when failures pass its gate."
      />
      {current && <CurrentRollout rollout={current} now={now} />}
      <div className="grid grid-cols-12 gap-3">
        <Panel title="bcd versions in the fleet" meta={`${snapshot.nodes.length} nodes`} className="col-span-12 lg:col-span-4">
          <ul className="flex flex-col gap-2">
            {[...versions].map(([version, count]) => (
              <li key={version}>
                <Meter
                  value={count}
                  max={snapshot.nodes.length}
                  warnAt={2}
                  label={
                    <span className="flex items-center gap-2">
                      <Mono>{version}</Mono>
                      {version === CURRENT_BCD && <Tag status="ok">current</Tag>}
                      {current && version === current.version && <Tag status="live">rolling out</Tag>}
                    </span>
                  }
                  detail={`${count} · ${fmtPct(count / snapshot.nodes.length, 0)}`}
                />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="History" flush className="col-span-12 lg:col-span-8">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-separator-border font-mono text-[10px] tracking-wider text-text-tertiary uppercase">
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Nodes</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {history.map((rollout) => (
                <tr key={rollout.id} className="border-b border-separator-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <Mono>{rollout.version}</Mono>
                  </td>
                  <td className="px-3 py-2">
                    <Tag status={rolloutStatus[rollout.state]}>{rollout.state}</Tag>
                  </td>
                  <td className="w-48 px-3 py-2">
                    <StateBar rollout={rollout} />
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-text-secondary">{fmtStamp(rollout.createdAt)}</td>
                  <td className="max-w-80 truncate px-3 py-2 text-caption-1-regular text-text-secondary" title={rollout.reason}>
                    {rollout.reason ?? `by ${rollout.createdBy}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

function StateBar({ rollout, height = 6 }: { rollout: RolloutView; height?: number }) {
  return (
    <StackedBar
      height={height}
      parts={rolloutNodeStates.map((state) => ({ label: state, value: rollout.nodes[state], tone: stateTone[state] }))}
      title={rolloutNodeStates.filter((state) => rollout.nodes[state]).map((state) => `${rollout.nodes[state]} ${state}`).join(', ')}
    />
  );
}

function CurrentRollout({ rollout, now }: { rollout: RolloutView; now: number }) {
  const commands = useFleetCommands();
  const [focusWave, setFocusWave] = useState<number | undefined>(undefined);
  const total = rollout.nodeList.length;
  const done = rollout.nodes.succeeded + rollout.nodes.failed;
  const attempted = done + rollout.nodes.upgrading;
  const failureRatio = done ? rollout.nodes.failed / done : 0;
  const soakLeft = rollout.waveStartedAt + 25 * 60_000 - now;
  const waves = rollout.waves.map((pct, index) => {
    const members = rollout.nodeList.filter((node) => node.wave === index);
    const counts = Object.fromEntries(rolloutNodeStates.map((state) => [state, members.filter((node) => node.state === state).length])) as Record<RolloutNodeState, number>;
    return { index, pct, members, counts };
  });
  const failed = rollout.nodeList.filter((node) => node.state === 'failed');

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          bcd <Mono className="text-[12px]">{rollout.version}</Mono>
        </span>
      }
      meta={rollout.id}
      className={cx(rollout.state === 'running' && 'border-signal-fill/40')}
      actions={
        <div className="flex items-center gap-1.5">
          <Tag status={rolloutStatus[rollout.state]}>{rollout.state}</Tag>
          {rollout.state === 'running' ? (
            <ActionButton icon={RiPauseLine} onPress={() => void commands.rollout(rollout, 'paused')}>
              Pause
            </ActionButton>
          ) : (
            <ActionButton icon={RiPlayLine} primary onPress={() => void commands.rollout(rollout, 'running')}>
              Resume
            </ActionButton>
          )}
          <ActionButton icon={RiStopLine} danger onPress={() => void commands.rollout(rollout, 'aborted')}>
            Abort
          </ActionButton>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {rollout.reason && <p className="border-l-2 border-signal-fill pl-3 text-body-2-regular text-text-secondary">{rollout.reason}</p>}
        <div className="grid gap-4 md:grid-cols-4">
          <KeyValue
            columns={1}
            items={[
              { label: 'Progress', value: `${attempted} of ${total} nodes · ${fmtPct(attempted / (total || 1), 0)}`, mono: true },
              { label: 'Started', value: `${fmtRelative(rollout.createdAt, now)} by ${rollout.createdBy}` },
            ]}
          />
          <KeyValue
            columns={1}
            items={[
              { label: 'Wave', value: `${rollout.wave + 1} of ${rollout.waves.length} (${rollout.waves[rollout.wave]}%)`, mono: true },
              { label: 'Soak', value: soakLeft > 0 ? `${fmtDuration(soakLeft)} left in this wave` : 'next wave due', mono: true },
            ]}
          />
          <div className="md:col-span-2">
            <Meter
              value={failureRatio}
              max={rollout.maxFailureRatio}
              warnAt={0.5}
              label="Failure ratio against the gate"
              detail={`${fmtPct(failureRatio, 1)} of ${fmtPct(rollout.maxFailureRatio, 0)} · ${rollout.nodes.failed} failed`}
            />
            <p className="mt-2 text-caption-1-regular text-text-tertiary">
              The rollout halts by itself at {fmtPct(rollout.maxFailureRatio, 0)} failed; a node fails when bcd doesn&apos;t say Hello within {rollout.upgradeTimeoutSeconds} s of the swap.
            </p>
          </div>
        </div>

        <div>
          <SectionLabel>Waves</SectionLabel>
          <div className="grid gap-2 md:grid-cols-4">
            {waves.map((wave) => {
              const active = wave.index === rollout.wave;
              const finished = wave.index < rollout.wave;
              return (
                <button
                  key={wave.index}
                  type="button"
                  onClick={() => setFocusWave(focusWave === wave.index ? undefined : wave.index)}
                  aria-pressed={focusWave === wave.index}
                  className={cx(
                    'flex flex-col gap-2 border p-3 text-left transition-colors',
                    active ? 'border-signal-fill/60 bg-signal-soft' : 'border-separator-border hover:border-separator-border-strong',
                    focusWave === wave.index && 'ring-1 ring-text-primary',
                  )}
                >
                  <span className="flex items-baseline justify-between">
                    <span className="font-mono text-[12px] text-text-primary">
                      Wave {wave.index + 1} · {wave.pct}%
                    </span>
                    <span className="font-mono text-[10px] text-text-tertiary">{finished ? 'done' : active ? rollout.state : 'queued'}</span>
                  </span>
                  <StackedBar height={6} parts={rolloutNodeStates.map((state) => ({ label: state, value: wave.counts[state], tone: stateTone[state] }))} />
                  <span className="font-mono text-[11px] text-text-secondary">
                    {wave.counts.succeeded}/{wave.members.length} upgraded{wave.counts.upgrading ? ` · ${wave.counts.upgrading} upgrading` : ''}
                    {wave.counts.failed ? ` · ${wave.counts.failed} failed` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <SectionLabel action={<span className="font-mono text-[10px] text-text-tertiary">{focusWave === undefined ? 'every node' : `wave ${focusWave + 1}`} · hover for detail</span>}>Nodes</SectionLabel>
          <div className="flex flex-wrap gap-[3px]">
            {rollout.nodeList
              .filter((node) => focusWave === undefined || node.wave === focusWave)
              .map((node) => (
                <Link
                  key={node.nodeId}
                  href={`/nodes?node=${node.nodeId}`}
                  title={`${node.nodeId.replace(/^n-/, '')} · wave ${node.wave + 1} · ${node.state}${node.fromVersion ? ` · from ${node.fromVersion}` : ''}${node.error ? `\n${node.error}` : ''}`}
                  className={cx(
                    'size-2.5',
                    node.state === 'succeeded' && 'bg-text-secondary',
                    node.state === 'upgrading' && 'bg-signal-fill motion-safe:animate-pulse',
                    node.state === 'pending' && 'border border-separator-border-strong',
                    node.state === 'failed' && 'bg-red-500',
                    (node.state === 'skipped' || node.state === 'rolled-back') && 'hatch border border-separator-border',
                    node.state === 'rolling-back' && 'border border-red-500',
                  )}
                />
              ))}
          </div>
        </div>

        {failed.length > 0 && (
          <div>
            <SectionLabel>Failed nodes</SectionLabel>
            <ul className="flex flex-col divide-y divide-separator-border border border-separator-border">
              {failed.map((node) => (
                <li key={node.nodeId} className="flex items-center gap-3 px-3 py-2">
                  <Tag status={rolloutNodeStatus[node.state]}>{node.state}</Tag>
                  <Link href={`/nodes?node=${node.nodeId}`} className="font-mono text-[12px] text-text-primary hover:underline">
                    {node.nodeId.replace(/^n-/, '')}
                  </Link>
                  <span className="text-caption-1-regular text-text-tertiary">{poolById(node.poolId)?.name}</span>
                  <span className="truncate text-caption-1-regular text-text-secondary">{node.error}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-text-tertiary">from {node.fromVersion}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
