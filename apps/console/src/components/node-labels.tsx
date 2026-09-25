'use client';

import { useState } from 'react';
import type { Detail } from '@better-compute/console-kit';
import { useAction, useStore } from '@better-compute/console-kit/react';
import { ErrorLine } from './ui';

// A node's labels (selectors match them) and taints (each keeps the scheduler off the node, as a NoSchedule reason
// `taint:<taint>`), with nodes.label and nodes.taint behind the same gates as the other node actions: the node's
// state and IAM's answer (compute:nodes:update). The server still decides.

interface Label {
  key: string;
  value: string;
  source?: string;
}

const labelKey = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/;
const labelValue = /^[A-Za-z0-9._:/@+=-]{0,256}$/;
const taintPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._/=:-]{0,126}[A-Za-z0-9])?$/;

export function NodeLabels({ detail }: { detail: Detail }) {
  const state = useStore(detail);
  const label = useAction(detail, 'nodes/label');
  const taint = useAction(detail, 'nodes/taint');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [newTaint, setNewTaint] = useState('');
  const node = state.item;
  if (!node) return null;
  const enabled = (path: string) => {
    const action = state.actions.find((candidate) => candidate.path === path);
    return Boolean(action?.applicable && action.allowed !== false);
  };
  const canLabel = enabled('nodes/label') && !label.pending;
  const canTaint = enabled('nodes/taint') && !taint.pending;
  const labels = (node.labels as Label[] | undefined) ?? [];
  const taints = ((node.noScheduleReasons as string[] | undefined) ?? [])
    .filter((reason) => reason.startsWith('taint:'))
    .map((reason) => reason.slice('taint:'.length));

  return (
    <section className="panel">
      <h3>Labels and taints</h3>
      <table>
        <tbody>
          {labels.map((item) => (
            <tr key={item.key}>
              <th>{item.key}</th>
              <td>{item.value}</td>
              <td className="muted">{item.source ?? ''}</td>
              <td>
                {/* Inventory and system labels come back from the node; only an operator's can be removed. */}
                {item.source === 'operator' && (
                  <button
                    type="button"
                    disabled={!canLabel}
                    onClick={() => void label.run({ remove: [item.key] })}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void label.run({ set: { [key]: value } }).then((outcome) => {
            if (outcome?.status === 'done') {
              setKey('');
              setValue('');
            }
          });
        }}
      >
        <input placeholder="key" value={key} onChange={(event) => setKey(event.target.value)} />
        <input placeholder="value" value={value} onChange={(event) => setValue(event.target.value)} />
        <button type="submit" disabled={!canLabel || !labelKey.test(key) || !labelValue.test(value)}>
          Set label
        </button>
      </form>
      {label.outcome?.status === 'confirmation-required' && (
        <p className="warning">Awaiting approval ({label.outcome.confirmationId})</p>
      )}
      {label.error ? <ErrorLine error={label.error} /> : null}
      <h4>Taints</h4>
      {taints.length === 0 && <p className="muted">None: the scheduler may place work here.</p>}
      <ul>
        {taints.map((item) => (
          <li key={item}>
            <code>{item}</code>{' '}
            <button type="button" disabled={!canTaint} onClick={() => void taint.run({ remove: [item] })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void taint.run({ add: [newTaint] }).then((outcome) => {
            if (outcome?.status === 'done') setNewTaint('');
          });
        }}
      >
        <input placeholder="gpu-degraded" value={newTaint} onChange={(event) => setNewTaint(event.target.value)} />
        <button type="submit" disabled={!canTaint || !taintPattern.test(newTaint)}>
          Add taint
        </button>
      </form>
      {taint.outcome?.status === 'confirmation-required' && (
        <p className="warning">Awaiting approval ({taint.outcome.confirmationId})</p>
      )}
      {taint.error ? <ErrorLine error={taint.error} /> : null}
    </section>
  );
}
