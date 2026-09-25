'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  batchApproveCommand,
  createBatchesView,
  describeSubject,
  scopeByKind,
  timeLeft,
  type BatchMemberRow,
  type BatchRow,
  type BatchScopeItem,
  type BatchState,
} from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine, Loading } from '@/components/ui';

/**
 * Destructive batches (PLAN.md §13): fleet-wide reimages, wipes and power actions held until k operators approve
 * them with their approver keys. Approving happens in the approver's terminal (`better-compute batch approve`), which
 * recomputes the scope root from the listed commands before signing; here: what is waiting, what it touches, who
 * approved, and cancelling.
 */
export default function BatchesPage() {
  const { api, tenantId } = useConsole();
  const view = useMemo(() => createBatchesView(api, { tenantId }), [api, tenantId]);
  const state = useStore(view);
  const [filter, setFilter] = useState<BatchState | 'all'>('pending');
  const [open, setOpen] = useState<{
    batch: BatchRow;
    scope: BatchScopeItem[];
    truncated: boolean;
    members: BatchMemberRow[];
    moreMembers: boolean;
  }>();
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void view.refresh();
  }, [view]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const show = (batchId: string) =>
    act(async () => {
      const [batch, scope, members] = await Promise.all([
        view.detail(batchId),
        view.scope(batchId),
        view.members(batchId),
      ]);
      setOpen({ batch, scope: scope.items, truncated: scope.truncated, members: members.items, moreMembers: members.next !== undefined });
    });

  return (
    <>
      <h2>Destructive batches</h2>
      <p className="muted">
        A reimage, wipe or power action across many machines waits here until enough approvers sign it. Approvers
        run the command shown below in their terminal, where their key is: it lists every machine the batch touches,
        checks the list against what they sign, and submits the signature.
      </p>
      <div className="row">
        {(['pending', 'approved', 'expired', 'cancelled', 'all'] as const).map((item) => (
          <label key={item}>
            <input
              type="radio"
              name="state"
              checked={filter === item}
              onChange={() => {
                setFilter(item);
                void act(() => view.filter(item));
              }}
            />
            {item}
          </label>
        ))}
      </div>
      <ErrorLine error={error} />
      <Loading status={state.status} error={state.error}>
        {state.value && state.value.items.length === 0 && <p className="muted">No {filter === 'all' ? '' : filter} batches.</p>}
        {state.value && state.value.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Commands</th>
                <th>Approvals</th>
                <th>State</th>
                <th>Window</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.value.items.map((batch) => {
                const left = timeLeft(batch.notAfter, now);
                return (
                  <tr key={batch.batchId}>
                    <td>
                      {batch.reason}
                      <div className="muted">
                        <code>{batch.batchId}</code>
                        {batch.createdBy && !batch.createdByAgent ? ` · by ${batch.createdBy}` : ''}
                      </div>
                      {batch.createdByAgent && (
                        <div className="warning">
                          Proposed by agent {batch.createdByAgent} for {batch.createdBy ?? 'unknown'}
                          {batch.delegationId ? ` (delegation ${batch.delegationId})` : ''}: the reason is the
                          agent&apos;s own text.
                        </div>
                      )}
                    </td>
                    <td>{batch.scopeSize}</td>
                    <td>
                      {batch.approvals.length} of {batch.requiredApprovals}
                    </td>
                    <td>{batch.state}</td>
                    <td className={batch.state === 'pending' && left.urgent ? 'warning' : ''}>
                      {batch.state === 'pending' ? left.text : ''}
                    </td>
                    <td>
                      <div className="row">
                        <button type="button" disabled={busy} onClick={() => void show(batch.batchId)}>
                          Details
                        </button>
                        {batch.state === 'pending' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              window.confirm(`Cancel ${batch.batchId}? None of its ${batch.scopeSize} commands will run.`) &&
                              void act(() => view.cancel(batch.batchId))
                            }
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Loading>

      {open && (
        <section className="panel">
          <h3>{open.batch.reason}</h3>
          <p className="muted">
            <code>{open.batch.batchId}</code> · {open.batch.state} · {open.batch.approvals.length} of{' '}
            {open.batch.requiredApprovals} approvals · closes {new Date(open.batch.notAfter).toLocaleString()}
          </p>
          {open.batch.state === 'pending' && (
            <p>
              To approve: <code>{batchApproveCommand(open.batch.batchId, tenantId)}</code>
            </p>
          )}
          <p className="muted">
            Scope root <code>{open.batch.scopeRoot}</code>. The CLI recomputes it from this list before signing.
          </p>
          {scopeByKind(open.scope).map((group) => (
            <details key={group.kind} open={group.subjects.length <= 20}>
              <summary>
                {group.kind} × {group.subjects.length}
                {group.unbound > 0 && <span className="warning"> ({group.unbound} with any payload)</span>}
              </summary>
              <ul>
                {group.subjects.map((subject, index) => (
                  <li key={`${subject}#${index}`}>
                    <code>{describeSubject(subject)}</code>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {open.truncated && (
            <p className="warning">The listing is incomplete: review this batch with better-compute batch show.</p>
          )}
          {open.batch.approvals.length > 0 && (
            <>
              <h4>Approved by</h4>
              <ul>
                {open.batch.approvals.map((approval) => (
                  <li key={approval.kid}>
                    <code>{approval.kid}</code>
                    {approval.approvedBy ? ` (${approval.approvedBy})` : ''} at {new Date(approval.at).toLocaleString()}
                  </li>
                ))}
              </ul>
            </>
          )}
          {open.members.length > 0 && (
            <>
              <h4>Commands</h4>
              <table>
                <thead>
                  <tr>
                    <th>Command</th>
                    <th>Node</th>
                    <th>Kind</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {open.members.map((member) => (
                    <tr key={member.commandId}>
                      <td>
                        <code>{member.commandId}</code>
                      </td>
                      <td>
                        <code>{describeSubject(member.subject)}</code>
                        {member.subject !== member.nodeId && <div className="muted">via {member.nodeId}</div>}
                      </td>
                      <td>{member.kind}</td>
                      <td>
                        {member.awaitingApproval ? 'held for approval' : member.state}
                        {member.reason ? <div className="muted">{member.reason}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {open.moreMembers && <p className="muted">The first 100 commands are shown.</p>}
            </>
          )}
          <p className="muted">
            Commands:{' '}
            {Object.entries(open.batch.commands)
              .map(([commandState, count]) => `${count} ${commandState}`)
              .join(', ') || 'none enqueued yet'}
          </p>
          <button type="button" onClick={() => setOpen(undefined)}>
            Close
          </button>
        </section>
      )}
    </>
  );
}
