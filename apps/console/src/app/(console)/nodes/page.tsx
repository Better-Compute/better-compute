'use client';

import Link from 'next/link';
import { useState } from 'react';
import { nodeTable, type Item, type NodeFilter, type NodeSort } from '@better-compute/console-kit';
import { useList } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { Loading } from '@/components/ui';

type NodeRow = Item & {
  poolId?: string;
  siteId?: string;
  connectivity?: string;
  provisionState?: string;
  cordoned?: boolean;
  conditions?: { type: string; status: string }[];
};

/** Sets or clears one filter field (`exactOptionalPropertyTypes`: absent, never `undefined`). */
function withField<K extends keyof NodeFilter>(
  filter: NodeFilter,
  key: K,
  value: NodeFilter[K] | undefined,
): NodeFilter {
  const next = { ...filter };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  return next;
}

/** Nodes the organization can see, filtered and sorted in the browser. */
export default function NodesPage() {
  const { resources } = useConsole();
  const list = useList(resources.nodes);
  const [filter, setFilter] = useState<NodeFilter>({});
  const [sort, setSort] = useState<NodeSort>('conditions');
  const rows = nodeTable(list.items as readonly NodeRow[], {
    filter,
    sort,
    descending: sort === 'conditions',
  });

  return (
    <>
      <h2>Nodes</h2>
      <div className="row panel">
        <input
          placeholder="Search id, pool, site, labels"
          value={filter.text ?? ''}
          onChange={(event) => setFilter(withField(filter, 'text', event.target.value))}
        />
        <select
          value={filter.connectivity?.[0] ?? ''}
          onChange={(event) =>
            setFilter(
              withField(
                filter,
                'connectivity',
                event.target.value ? [event.target.value] : undefined,
              ),
            )
          }
        >
          <option value="">Any connectivity</option>
          <option value="connected">Connected</option>
          <option value="disconnected">Disconnected</option>
          <option value="unreachable">Unreachable</option>
          <option value="lost">Lost</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as NodeSort)}>
          <option value="conditions">Most conditions first</option>
          <option value="id">Id</option>
          <option value="pool">Pool</option>
          <option value="connectivity">Connectivity</option>
          <option value="provisionState">State</option>
        </select>
        <label className="row">
          <input
            type="checkbox"
            checked={filter.cordoned === true}
            onChange={(event) =>
              setFilter(withField(filter, 'cordoned', event.target.checked ? true : undefined))
            }
          />
          Cordoned only
        </label>
        <button onClick={() => void resources.nodes.refresh()}>Refresh</button>
      </div>
      <section className="panel">
        <Loading status={list.status} error={list.error}>
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>Pool</th>
                <th>State</th>
                <th>Connectivity</th>
                <th>Conditions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((node) => {
                const conditions = (node.conditions ?? [])
                  .filter((condition) => condition.status === 'true')
                  .map((condition) => condition.type);
                return (
                  <tr key={node.id}>
                    <td>
                      <Link href={`/nodes/${encodeURIComponent(node.id)}`}>{node.id}</Link>
                      {node.cordoned === true && <span className="warning"> cordoned</span>}
                    </td>
                    <td>{node.poolId ?? ''}</td>
                    <td>{node.provisionState ?? ''}</td>
                    <td className={node.connectivity === 'connected' ? 'ok' : 'warning'}>
                      {node.connectivity ?? ''}
                    </td>
                    <td className={conditions.length ? 'error' : 'muted'}>
                      {conditions.join(', ') || 'none'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && list.status === 'ready' && <p className="muted">No nodes match.</p>}
          {list.hasMore && (
            <button onClick={() => void resources.nodes.loadMore()}>Load more</button>
          )}
        </Loading>
      </section>
    </>
  );
}
