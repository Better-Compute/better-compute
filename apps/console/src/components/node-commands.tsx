'use client';

import { useEffect, useMemo, useState } from 'react';
import { commandStates } from 'better-compute/core';
import { createListResource, type Item } from '@better-compute/console-kit';
import { useList } from '@better-compute/console-kit/react';
import { useConsole } from './console-provider';
import { Loading } from './ui';

// A node's recent commands (`commands.list`, newest first): what the control plane asked the daemon to do and how
// it went, the first place to look when a node misbehaves.

type CommandRow = Item & {
  seq: number;
  kind: string;
  state: string;
  reason?: string;
  notAfter: number;
  attested: boolean;
};

const stateClass = (state: string) =>
  state === 'succeeded'
    ? 'ok'
    : state === 'failed' || state === 'rejected' || state === 'expired'
      ? 'error'
      : state === 'cancelled'
        ? 'muted'
        : 'warning';

export function NodeCommands({ nodeId }: { nodeId: string }) {
  const { api, tenantId, onEvent } = useConsole();
  const [state, setState] = useState('');
  const list = useMemo(
    () =>
      createListResource<CommandRow>({
        key: (command) => command.id,
        load: (cursor, signal) =>
          api.$request(
            'commands/list',
            {
              tenantId,
              nodeId,
              limit: 20,
              ...(state ? { state } : {}),
              ...(cursor ? { cursor } : {}),
            },
            { signal },
          ),
      }),
    [api, tenantId, nodeId, state],
  );
  const commands = useList(list);
  // Command events about this node refresh the list.
  useEffect(
    () =>
      onEvent((event) => {
        if (event.subject === `node/${nodeId}` && event.type.startsWith('command.'))
          void list.refresh();
      }),
    [onEvent, list, nodeId],
  );

  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>Recent commands</h3>
        <div className="row">
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">Any state</option>
            {commandStates.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button onClick={() => void list.refresh()}>Refresh</button>
        </div>
      </div>
      <Loading status={commands.status} error={commands.error}>
        {commands.items.length === 0 ? (
          <p className="muted">No commands.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Kind</th>
                <th>State</th>
                <th>Deadline</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {commands.items.map((command) => (
                <tr key={command.id} title={command.id}>
                  <td>{command.seq}</td>
                  <td>
                    <code>{command.kind}</code>
                    {command.attested && <span className="muted"> (attested)</span>}
                  </td>
                  <td className={stateClass(command.state)}>{command.state}</td>
                  <td>{new Date(command.notAfter).toLocaleString()}</td>
                  <td className="muted">{command.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {commands.hasMore && <button onClick={() => void list.loadMore()}>Load more</button>}
      </Loading>
    </section>
  );
}
