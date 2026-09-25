'use client';

import { useEffect, useMemo } from 'react';
import { createQuotaView } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { Loading } from '@/components/ui';

const levelColor = { ok: '#16a34a', warning: '#d97706', full: '#dc2626' } as const;

/** The organization's quotas per pool: used of max, colored from 80 %. */
export default function QuotasPage() {
  const { api, tenantId } = useConsole();
  const view = useMemo(() => createQuotaView(api, { tenantId }), [api, tenantId]);
  const state = useStore(view);
  useEffect(() => {
    void view.refresh();
  }, [view]);
  const quotas = state.value;

  return (
    <>
      <h2>Quotas</h2>
      <Loading status={state.status} error={state.error}>
        {quotas && quotas.pools.length === 0 && (
          <p className="muted">No quotas are set for this organization.</p>
        )}
        {quotas?.pools.map((pool) => (
          <section key={pool.poolId} className="panel">
            <h3>{pool.poolId}</h3>
            <table>
              <tbody>
                {pool.meters.map((meter) => (
                  <tr key={meter.resource}>
                    <th>{meter.resource}</th>
                    <td style={{ width: '50%' }}>
                      <div className="bar" role="img" aria-label={`${meter.used} of ${meter.max}`}>
                        <span
                          style={{
                            width: `${meter.ratio * 100}%`,
                            background: levelColor[meter.level],
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      {meter.used} / {meter.max}
                    </td>
                    <td
                      className={
                        meter.level === 'ok'
                          ? 'muted'
                          : meter.level === 'full'
                            ? 'error'
                            : 'warning'
                      }
                    >
                      {meter.available} left
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
