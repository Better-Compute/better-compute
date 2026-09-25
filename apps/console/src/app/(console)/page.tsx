'use client';

import { useEffect, useMemo } from 'react';
import {
  capacityChart,
  createQuotaView,
  type CapacitySummaryInput,
} from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { colors, Loading, StackedBar } from '@/components/ui';

/** Capacity at a glance: GPUs per pool (allocated, reserved, available), totals by model, quota alerts. */
export default function OverviewPage() {
  const { resources, api, tenantId } = useConsole();
  const capacity = useStore(resources.capacity);
  const quotas = useMemo(() => createQuotaView(api, { tenantId }), [api, tenantId]);
  const quota = useStore(quotas);
  useEffect(() => {
    if (resources.capacity.get().status === 'idle') void resources.capacity.refresh();
    void quotas.refresh();
  }, [resources, quotas]);
  const chart = capacity.value
    ? capacityChart(capacity.value as unknown as CapacitySummaryInput)
    : undefined;

  return (
    <>
      <h2>Overview</h2>
      <section className="panel">
        <h3>GPUs</h3>
        <Loading status={capacity.status} error={capacity.error}>
          {chart && (
            <>
              <p>
                {chart.totals.allocated} of {chart.totals.total} GPUs in use (
                {Math.round(chart.totals.utilization * 100)}%), {chart.totals.available} available.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Pool</th>
                    <th>Model</th>
                    <th style={{ width: '45%' }}>Allocated · reserved · available</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {chart.bars.map((bar) => (
                    <tr key={bar.poolId}>
                      <td>
                        {bar.poolId} {bar.owned ? '' : <span className="muted">(offered)</span>}
                      </td>
                      <td>{bar.gpuModel}</td>
                      <td>
                        <StackedBar
                          total={bar.total}
                          parts={[
                            { label: 'allocated', value: bar.allocated, color: colors.allocated },
                            { label: 'reserved', value: bar.reserved, color: colors.reserved },
                            { label: 'available', value: bar.available, color: colors.available },
                            {
                              label: 'unavailable',
                              value: bar.unavailable,
                              color: colors.unavailable,
                            },
                          ]}
                        />
                      </td>
                      <td>{bar.total}</td>
                    </tr>
                  ))}
                  {chart.bars.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
                        No pools are visible to this organization yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </Loading>
      </section>
      <section className="panel">
        <h3>Quota alerts</h3>
        <Loading status={quota.status} error={quota.error}>
          {quota.value && quota.value.alerts.length === 0 && (
            <p className="ok">Every quota has room.</p>
          )}
          <ul>
            {quota.value?.alerts.map((alert) => (
              <li
                key={`${alert.poolId}/${alert.resource}`}
                className={alert.level === 'full' ? 'error' : 'warning'}
              >
                {alert.poolId}: {alert.used} of {alert.max} {alert.resource} used
                {alert.level === 'full' ? ' (full)' : ''}
              </li>
            ))}
          </ul>
        </Loading>
      </section>
    </>
  );
}
