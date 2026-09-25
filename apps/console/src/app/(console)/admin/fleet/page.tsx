'use client';

import { useEffect, useMemo } from 'react';
import { createFleetDriftView } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { Loading } from '@/components/ui';

const actionClass = {
  create: 'ok',
  update: 'warning',
  delete: 'error',
  unchanged: 'muted',
} as const;

/** Drift between the fleet and its last applied FleetConfig (`fleet.status`), grouped by object kind. */
export default function FleetPage() {
  const { api, tenantId, root } = useConsole();
  const view = useMemo(() => createFleetDriftView(api, { tenantId }), [api, tenantId]);
  const state = useStore(view);
  useEffect(() => {
    if (root) void view.refresh();
  }, [view, root]);

  if (!root) return <p className="error">Platform administrators only.</p>;
  const drift = state.value;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Fleet drift</h2>
        <button onClick={() => void view.refresh()}>Refresh</button>
      </div>
      <Loading status={state.status} error={state.error}>
        {drift && !drift.managed && (
          <p className="muted">
            No FleetConfig has been applied. Export the fleet with{' '}
            <code>better-compute fleet export</code>, then apply it with{' '}
            <code>better-compute fleet apply</code>.
          </p>
        )}
        {drift?.managed && (
          <section className="panel">
            <p>
              Applied by {drift.appliedBy} on{' '}
              {drift.appliedAt ? new Date(drift.appliedAt).toLocaleString() : '—'}
              {drift.checkedAt ? `; checked ${new Date(drift.checkedAt).toLocaleString()}` : ''}.
            </p>
            <p className={drift.drifted ? 'warning' : 'ok'}>
              {drift.drifted
                ? 'The fleet has drifted from its FleetConfig.'
                : 'The fleet matches its FleetConfig.'}
              {drift.blocked && ' Some changes are blocked and need a person.'}
            </p>
          </section>
        )}
        {drift?.groups.map((group) => (
          <section key={group.kind} className="panel">
            <h3>{group.kind}</h3>
            <table>
              <tbody>
                {group.changes.map((change) => (
                  <tr key={change.name}>
                    <td>{change.name}</td>
                    <td className={actionClass[change.action]}>{change.action}</td>
                    <td>{change.fields?.join(', ') ?? ''}</td>
                    <td className={change.blocked ? 'error' : 'muted'}>
                      {change.blocked ?? change.note ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </Loading>
    </>
  );
}
