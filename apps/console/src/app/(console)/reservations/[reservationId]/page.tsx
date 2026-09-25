'use client';

import { use, useMemo } from 'react';
import { createDetail } from '@better-compute/console-kit';
import { useDetail } from '@better-compute/console-kit/react';
import { useConsole, useDetailEvents } from '@/components/console-provider';
import { DetailActions } from '@/components/detail-actions';
import { Loading } from '@/components/ui';

const time = (value: unknown) =>
  typeof value === 'number' || (typeof value === 'string' && value)
    ? new Date(typeof value === 'number' ? value : Number(value) || value).toLocaleString()
    : '—';

/** One reservation: its request, placement and window, and the actions its state allows (release, cancel, …). */
export default function ReservationPage({
  params,
}: {
  params: Promise<{ reservationId: string }>;
}) {
  const { reservationId } = use(params);
  const { api, tenantId, permissions } = useConsole();
  const detail = useMemo(
    () => createDetail(api, { tenantId, kind: 'reservation', id: reservationId, permissions }),
    [api, tenantId, reservationId, permissions],
  );
  const state = useDetail(detail);
  useDetailEvents(detail);
  const reservation = state.item;

  return (
    <>
      <h2>{reservationId}</h2>
      {state.status === 'gone' ? (
        <p className="error">This reservation no longer exists or is not visible to you.</p>
      ) : (
        <Loading status={state.status} error={state.error}>
          {reservation && (
            <>
              <section className="panel">
                <table>
                  <tbody>
                    <tr>
                      <th>State</th>
                      <td>{String(reservation.state ?? '')}</td>
                    </tr>
                    <tr>
                      <th>Pool</th>
                      <td>{String(reservation.poolId ?? '')}</td>
                    </tr>
                    <tr>
                      <th>Request</th>
                      <td>
                        <code>
                          {JSON.stringify(reservation.request ?? reservation.devices ?? {})}
                        </code>
                      </td>
                    </tr>
                    <tr>
                      <th>Placed on</th>
                      <td>
                        {Array.isArray(reservation.nodeIds)
                          ? (reservation.nodeIds as string[]).join(', ') || '—'
                          : String(reservation.nodeId ?? '—')}
                      </td>
                    </tr>
                    <tr>
                      <th>Starts</th>
                      <td>{time(reservation.startsAt)}</td>
                    </tr>
                    <tr>
                      <th>Ends</th>
                      <td>{time(reservation.endsAt)}</td>
                    </tr>
                    {typeof reservation.reason === 'string' && (
                      <tr>
                        <th>Reason</th>
                        <td>{reservation.reason}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
              <section className="panel">
                <h3>Actions</h3>
                <DetailActions
                  detail={detail}
                  confirm={{
                    'reservations/release': `Release ${reservationId} now? Its GPUs go back to the pool and billing stops.`,
                    'reservations/cancel': `Cancel ${reservationId}? It will not start.`,
                  }}
                />
              </section>
            </>
          )}
        </Loading>
      )}
    </>
  );
}
