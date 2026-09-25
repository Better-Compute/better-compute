'use client';

import Link from 'next/link';
import { useList } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { Loading } from '@/components/ui';

/** The pools this organization owns or is offered, with their class, GPU model and sharing. */
export default function PoolsPage() {
  const { resources } = useConsole();
  const pools = useList(resources.pools);
  return (
    <>
      <h2>Pools &amp; capacity</h2>
      <section className="panel">
        <Loading status={pools.status} error={pools.error}>
          <table>
            <thead>
              <tr>
                <th>Pool</th>
                <th>Class</th>
                <th>GPU model</th>
                <th>Sharing</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {pools.items.map((pool) => (
                <tr key={pool.id}>
                  <td>
                    <Link href={`/pools/${encodeURIComponent(pool.id)}`}>{pool.id}</Link>
                  </td>
                  <td>{String(pool.class ?? '')}</td>
                  <td>{String(pool.gpuModel ?? '—')}</td>
                  <td>{String(pool.sharing ?? '')}</td>
                  <td>{pool.owned ? 'owned' : 'offered'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
      </section>
      <p className="muted">
        Capacity per pool is on the Overview page; open a pool for its 7-day booking calendar.
      </p>
    </>
  );
}
