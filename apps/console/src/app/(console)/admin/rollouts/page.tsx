'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createRolloutView,
  createValueResource,
  type RolloutDetail,
} from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine, Loading, StackedBar } from '@/components/ui';

type RolloutRow = Pick<RolloutDetail, 'id' | 'version' | 'state' | 'wave'> & { createdAt?: number };

const stateColor: Record<string, string> = {
  succeeded: '#16a34a',
  skipped: '#9ca3af',
  'rolled-back': '#7c3aed',
  failed: '#dc2626',
  pending: '#e5e7eb',
};

/** Daemon rollouts (v0.4): every rollout, and one's progress wave by wave with pause / resume / abort. */
export default function RolloutsPage() {
  const { api, tenantId, root } = useConsole();
  const list = useMemo(
    () =>
      createValueResource({
        load: (signal) =>
          api.$request<{ items: RolloutRow[] }>('rollouts/list', { tenantId }, { signal }),
      }),
    [api, tenantId],
  );
  const rollouts = useStore(list);
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    if (root) void list.refresh();
  }, [list, root]);

  if (!root) return <p className="error">Platform administrators only.</p>;
  return (
    <>
      <h2>Rollouts</h2>
      <section className="panel">
        <Loading status={rollouts.status} error={rollouts.error}>
          {rollouts.value?.items.length === 0 && (
            <p className="muted">
              No rollouts yet. Register a signed release and start one with the CLI.
            </p>
          )}
          <table>
            <tbody>
              {rollouts.value?.items.map((rollout) => (
                <tr key={rollout.id} aria-selected={rollout.id === selected}>
                  <td>
                    <button className="link" onClick={() => setSelected(rollout.id)}>
                      {rollout.id}
                    </button>
                  </td>
                  <td>{rollout.version}</td>
                  <td>{rollout.state}</td>
                  <td>wave {rollout.wave + 1}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
      </section>
      {selected && (
        <Rollout key={selected} rolloutId={selected} onChange={() => void list.refresh()} />
      )}
    </>
  );
}

function Rollout({ rolloutId, onChange }: { rolloutId: string; onChange: () => void }) {
  const { api, tenantId } = useConsole();
  const view = useMemo(
    () => createRolloutView(api, { tenantId, rolloutId }),
    [api, tenantId, rolloutId],
  );
  const state = useStore(view);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void view.refresh();
    const timer = setInterval(() => void view.refresh(), 10_000);
    return () => clearInterval(timer);
  }, [view]);

  const act = async (verb: 'pause' | 'resume' | 'abort') => {
    const reason =
      verb === 'resume' ? undefined : (prompt(`Why ${verb} this rollout?`) ?? undefined);
    if (verb === 'abort' && reason === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.$request(`rollouts/${verb}`, {
        tenantId,
        rolloutId,
        ...(reason ? { reason } : {}),
      });
      await view.refresh();
      onChange();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const progress = state.value;
  return (
    <section className="panel">
      <h3>{rolloutId}</h3>
      <Loading status={state.status} error={state.error}>
        {progress && (
          <>
            <p>
              {progress.version}: {progress.state}
              {progress.reason ? ` (${progress.reason})` : ''}. {progress.done} of {progress.total}{' '}
              node(s) done
              {progress.failed ? `, ${progress.failed} failed` : ''}.
            </p>
            <div className="row">
              <button disabled={busy || !progress.can.pause} onClick={() => void act('pause')}>
                Pause
              </button>
              <button disabled={busy || !progress.can.resume} onClick={() => void act('resume')}>
                Resume
              </button>
              <button disabled={busy || !progress.can.abort} onClick={() => void act('abort')}>
                Abort
              </button>
            </div>
            <ErrorLine error={error} />
            <table>
              <thead>
                <tr>
                  <th>Wave</th>
                  <th>Reaches</th>
                  <th>Nodes</th>
                  <th style={{ width: '40%' }}>Progress</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {progress.waves.map((wave) => (
                  <tr key={wave.index}>
                    <td>{wave.index + 1}</td>
                    <td>{wave.percent}%</td>
                    <td>{wave.nodes}</td>
                    <td>
                      <StackedBar
                        total={wave.nodes}
                        parts={Object.entries(wave.counts).map(([label, value]) => ({
                          label,
                          value,
                          color: stateColor[label] ?? '#2563eb',
                        }))}
                      />
                    </td>
                    <td
                      className={
                        wave.status === 'current'
                          ? 'warning'
                          : wave.status === 'done'
                            ? 'ok'
                            : 'muted'
                      }
                    >
                      {wave.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {progress.failures.length > 0 && (
              <>
                <h3>Failures</h3>
                <ul>
                  {progress.failures.map((node) => (
                    <li key={node.nodeId} className="error">
                      {node.nodeId} ({node.poolId}): {node.error ?? 'failed'}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Loading>
    </section>
  );
}
