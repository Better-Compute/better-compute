'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { createTimelineView, earliestFit } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { Loading } from '@/components/ui';

const levelColor = { free: '#16a34a', busy: '#d97706', full: '#dc2626' } as const;
const hour = 3_600_000;

/** One pool's booking calendar for the next 7 days (`capacity.timeline`), and the earliest slot for a request. */
export default function PoolPage({ params }: { params: Promise<{ poolId: string }> }) {
  const { poolId } = use(params);
  const { api, tenantId } = useConsole();
  const view = useMemo(() => {
    const from = Math.floor(Date.now() / hour) * hour;
    return createTimelineView(api, { tenantId, poolId, from, to: from + 7 * 24 * hour });
  }, [api, tenantId, poolId]);
  const state = useStore(view);
  const [gpus, setGpus] = useState(1);
  const [hours, setHours] = useState(4);
  useEffect(() => {
    void view.refresh();
  }, [view]);
  const timeline = state.value;
  const slot = timeline ? earliestFit(timeline.raw, gpus, hours * hour) : undefined;

  return (
    <>
      <h2>{poolId}</h2>
      <Loading status={state.status} error={state.error}>
        {timeline && (
          <>
            <section className="panel">
              <p>
                {timeline.allocatable} GPU(s) schedulable now; peak booking {timeline.peak.booked}
                {timeline.peak.start ? ` at ${new Date(timeline.peak.start).toLocaleString()}` : ''}
                .
              </p>
              <table>
                <tbody>
                  {timeline.days.map((day) => (
                    <tr key={day.day}>
                      <th style={{ whiteSpace: 'nowrap' }}>{day.day}</th>
                      <td style={{ width: '100%' }}>
                        <div className="timeline">
                          {day.buckets.map((bucket) => (
                            <span
                              key={bucket.start}
                              title={`${new Date(bucket.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${bucket.booked} booked, ${bucket.free} free`}
                              style={{
                                background: levelColor[bucket.level],
                                opacity: 0.25 + 0.75 * bucket.ratio,
                              }}
                            />
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">One cell per hour; darker is more booked.</p>
            </section>
            <section className="panel">
              <h3>Find a slot</h3>
              <div className="row">
                <label>
                  GPUs{' '}
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={gpus}
                    onChange={(event) => setGpus(Number(event.target.value))}
                  />
                </label>
                <label>
                  for{' '}
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={hours}
                    onChange={(event) => setHours(Number(event.target.value))}
                  />{' '}
                  hour(s)
                </label>
              </div>
              <p className={slot === undefined ? 'warning' : 'ok'}>
                {slot === undefined
                  ? 'No window in the next 7 days; a reservation would wait in the queue.'
                  : `Earliest: ${new Date(slot).toLocaleString()}.`}{' '}
                <Link href="/reservations">Reserve</Link>
              </p>
            </section>
          </>
        )}
      </Loading>
    </>
  );
}
