'use client';

import { StatusItem } from '@/components/shell/status-bar';
import { useFleet } from './use-fleet';

// Status-bar readouts from the fleet: nodes ready of total (amber when any is offline), the running rollout.

export function NodesStatus() {
  const snapshot = useFleet();
  const ready = snapshot.nodes.filter((node) => node.health === 'ready').length;
  const offline = snapshot.nodes.filter((node) => node.health === 'offline').length;
  return (
    <StatusItem
      label="nodes"
      value={`${ready}/${snapshot.nodes.length}`}
      {...(offline ? { tone: 'signal' as const } : {})}
      href={offline ? '/nodes?health=offline' : '/nodes'}
      title={offline ? `${offline} offline` : 'every node reachable'}
    />
  );
}

export function RolloutStatus() {
  const snapshot = useFleet();
  const rollout = snapshot.rollouts.find((each) => each.state === 'running' || each.state === 'paused');
  if (!rollout) return null;
  return (
    <StatusItem
      label={`bcd ${rollout.version}`}
      value={`${rollout.state === 'paused' ? 'paused · ' : ''}wave ${rollout.wave + 1}/${rollout.waves.length}`}
      {...(rollout.state === 'paused' || rollout.nodes.failed ? { tone: 'signal' as const } : {})}
      href="/rollouts"
    />
  );
}

export function BatchesStatus() {
  const snapshot = useFleet({ scoped: false });
  const pending = snapshot.batches.filter((batch) => batch.state === 'pending').length;
  if (!pending) return null;
  return <StatusItem label="batches" value={`${pending} to sign`} tone="signal" href="/batches" />;
}
