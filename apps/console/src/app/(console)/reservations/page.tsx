'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { createReservationForm } from '@better-compute/console-kit';
import { useList, useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { EarliestStart } from '@/components/earliest-start';
import { ErrorLine, Loading } from '@/components/ui';

/** The organization's reservations, and the reservation form (preview, confirmation, idempotent submit). */
export default function ReservationsPage() {
  const { resources, api, tenantId } = useConsole();
  const list = useList(resources.reservations);
  const pools = useList(resources.pools);
  const form = useMemo(() => createReservationForm(api, { tenantId }), [api, tenantId]);
  const state = useStore(form);
  const values = state.values;
  // Kubernetes-bound GPUs are the pool owner's only (the kubelet can't tell tenants apart).
  const chosen = pools.items.find((pool) => pool.id === values.poolId) as
    | { ownerTenantId?: unknown; policy?: { kubernetes?: unknown } }
    | undefined;
  const kubernetesPool =
    chosen?.ownerTenantId === tenantId && typeof chosen?.policy?.kubernetes === 'object';
  const optionalInt = (value: string) => (value.trim() === '' ? undefined : Number(value));

  return (
    <>
      <h2>Reservations</h2>
      <section className="panel">
        <h3>Reserve GPUs</h3>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit().then((result) => {
              if (result.status === 'done') void resources.reservations.refresh();
            });
          }}
        >
          <label>
            Pool
            <select
              value={values.poolId ?? ''}
              onChange={(event) => form.change({ poolId: event.target.value })}
            >
              <option value="">Choose…</option>
              {pools.items.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.id} {typeof pool.gpuModel === 'string' ? `(${pool.gpuModel})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            GPUs
            <input
              type="number"
              min={1}
              max={64}
              value={values.gpus ?? ''}
              onChange={(event) => form.change({ gpus: Number(event.target.value) })}
            />
            {state.errors.gpus && values.gpus !== undefined && (
              <span className="error">{state.errors.gpus}</span>
            )}
          </label>
          <label>
            Duration
            <input
              placeholder="8h"
              value={values.duration ?? ''}
              onChange={(event) => form.change({ duration: event.target.value.trim() })}
            />
          </label>
          <label>
            GPU model (optional)
            <input
              placeholder="H100"
              value={values.gpuModel ?? ''}
              onChange={(event) =>
                form.change(
                  event.target.value
                    ? { gpuModel: event.target.value }
                    : { gpuModel: undefined as never },
                )
              }
            />
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={values.nvlink ?? false}
              onChange={(event) => form.change({ nvlink: event.target.checked })}
            />
            All GPUs on one NVLink domain
          </label>
          <label>
            Host CPUs (optional)
            <input
              type="number"
              min={0}
              max={4096}
              placeholder="the pool's share per GPU"
              value={values.vcpu ?? ''}
              onChange={(event) => form.change({ vcpu: optionalInt(event.target.value) as never })}
            />
            {state.errors.vcpu && <span className="error">{state.errors.vcpu}</span>}
          </label>
          <label>
            Host memory, GiB (optional)
            <input
              type="number"
              min={0}
              max={65536}
              placeholder="the pool's share per GPU"
              value={values.memoryGiB ?? ''}
              onChange={(event) =>
                form.change({ memoryGiB: optionalInt(event.target.value) as never })
              }
            />
            {state.errors.memoryGiB && <span className="error">{state.errors.memoryGiB}</span>}
          </label>
          {kubernetesPool && (
            <label className="row">
              <input
                type="checkbox"
                checked={values.kubernetes ?? false}
                onChange={(event) => form.change({ kubernetes: event.target.checked })}
              />
              Give the GPUs to the pool&apos;s Kubernetes cluster
            </label>
          )}
          <p className="muted">
            Host CPUs and memory below the pool&apos;s per-GPU share are raised to it; above it, they
            count against your CPU and memory quota.
          </p>
          <EarliestStart poolId={values.poolId} gpus={values.gpus} duration={values.duration} />
          {state.previewing && <p className="muted">Checking capacity…</p>}
          {state.preview && (
            <p className={state.preview.fits ? 'ok' : 'warning'}>
              {state.preview.fits
                ? `Fits now (${state.preview.candidates} candidate node(s)).`
                : `Does not fit now${state.preview.reason ? `: ${state.preview.reason}` : ''}. It will wait in the queue.`}
            </p>
          )}
          {state.status === 'awaiting-confirmation' && (
            <p className="warning">
              A person must approve this request ({state.confirmationId}). Submit again after they
              do; it will not book twice.
            </p>
          )}
          {state.status === 'error' && <ErrorLine error={state.error} />}
          {state.status === 'done' ? (
            <p className="ok">
              Reserved: {String(state.reservation?.id)}.{' '}
              <button type="button" onClick={() => form.reset()}>
                New reservation
              </button>
            </p>
          ) : (
            <button
              className="primary"
              type="submit"
              disabled={Object.keys(state.errors).length > 0 || state.status === 'submitting'}
            >
              {state.status === 'awaiting-confirmation' ? 'Retry after approval' : 'Reserve'}
            </button>
          )}
        </form>
      </section>
      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Your reservations</h3>
          <button onClick={() => void resources.reservations.refresh()}>Refresh</button>
        </div>
        <Loading status={list.status} error={list.error}>
          <table>
            <thead>
              <tr>
                <th>Reservation</th>
                <th>Pool</th>
                <th>State</th>
                <th>Ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.items.map((reservation) => (
                <tr key={reservation.id}>
                  <td>
                    <Link href={`/reservations/${encodeURIComponent(reservation.id)}`}>
                      {reservation.id}
                    </Link>
                  </td>
                  <td>{String(reservation.poolId ?? '')}</td>
                  <td>{String(reservation.state ?? '')}</td>
                  <td>
                    {reservation.endsAt
                      ? new Date(Number(reservation.endsAt)).toLocaleString()
                      : ''}
                  </td>
                  <td>
                    {['active', 'placed', 'binding'].includes(String(reservation.state)) && (
                      <button
                        onClick={() =>
                          void api
                            .$request('reservations/release', {
                              tenantId,
                              reservationId: reservation.id,
                            })
                            .then(() => resources.reservations.refresh())
                            .catch((error: unknown) => alert((error as Error).message))
                        }
                      >
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasMore && (
            <button onClick={() => void resources.reservations.loadMore()}>Load more</button>
          )}
        </Loading>
      </section>
    </>
  );
}
