'use client';

import Link from 'next/link';
import { useState } from 'react';
import { matchesType } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { LiveBadge, useConsole } from '@/components/console-provider';

// Live activity: the organization's events as they arrive on the event stream (from sign-in on, the last 300),
// newest first. History is `events.list` (`better-compute events list`), which pages from a cursor.

const detailPath: Record<string, string> = {
  reservation: '/reservations/',
  node: '/nodes/',
  instance: '/instances/',
  pool: '/pools/',
};

const time = (value: number | string | undefined) =>
  value === undefined ? '' : new Date(value).toLocaleTimeString();

export default function ActivityPage() {
  const { recent } = useConsole();
  const events = useStore(recent);
  const [filter, setFilter] = useState('');
  const pattern = filter.trim();
  const shown = pattern
    ? events.filter((event) =>
        pattern.includes('*') ? matchesType(pattern, event.type) : event.type.startsWith(pattern),
      )
    : events;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Activity</h2>
        <div className="row">
          <LiveBadge />
          <input
            placeholder="Filter: node. or reservation.*"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button onClick={() => recent.set([])} disabled={events.length === 0}>
            Clear
          </button>
        </div>
      </div>
      <section className="panel">
        {shown.length === 0 ? (
          <p className="muted">
            {events.length === 0
              ? 'Waiting for events. They appear here as they happen while this console is open.'
              : 'No events match.'}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>About</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((event) => {
                const [kind, id] = event.subject.split('/');
                const base = kind ? detailPath[kind] : undefined;
                return (
                  <tr key={event.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{time(event.time)}</td>
                    <td>
                      <code>{event.type}</code>
                    </td>
                    <td>
                      {base && id ? (
                        <Link href={`${base}${encodeURIComponent(id)}`}>{event.subject}</Link>
                      ) : (
                        event.subject
                      )}
                    </td>
                    <td>
                      {event.data && Object.keys(event.data).length > 0 && (
                        <details>
                          <summary className="muted">data</summary>
                          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                            {JSON.stringify(event.data, null, 2)}
                          </pre>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
