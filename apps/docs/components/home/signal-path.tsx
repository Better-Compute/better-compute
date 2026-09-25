import { Fragment } from 'react';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { cx } from '@/utils/cx';

/**
 * How one request travels, as a schematic: six stations joined by wires with an amber pulse on them. Each station's
 * facts are checked against the code and the architecture guide: the envelope (packages/server/src/operations.ts),
 * bookings and the outbox in one transaction, reconcilers over the work queue with 256 shards and leases, the
 * gateway's mTLS sessions and three lanes, and bcd's journal. The fleet path never calls Better IAM
 * (tests/sim/iam-negative.test.ts).
 */
const stations: { id: string; name: string; role: string; facts: string[] }[] = [
  {
    id: 'caller',
    name: 'Caller',
    role: 'client · CLI · MCP · console',
    facts: ['a Better IAM credential', 'POST /api/compute/{group}/{method}'],
  },
  {
    id: 'api',
    name: 'API envelope',
    role: 'validate, then decide once',
    facts: ['one IAM decision on the draft', 'X-Better-Compute CSRF header'],
  },
  {
    id: 'postgres',
    name: 'Postgres',
    role: 'the only source of truth',
    facts: ['booking and outbox in one transaction', 'EXCLUDE: no double booking'],
  },
  {
    id: 'workers',
    name: 'Reconcilers',
    role: 'level-triggered workers',
    facts: ['work queue, 256 shards, leases', 'desired state by generation'],
  },
  {
    id: 'gateway',
    name: 'Gateway',
    role: 'holds the node sessions',
    facts: ['mTLS, outbound from nodes', 'control · provision · bulk lanes'],
  },
  {
    id: 'node',
    name: 'bcd on the node',
    role: 'converges the machine',
    facts: ['journal: nothing runs twice', 'CDI devices, VMs, reports back'],
  },
];

export function SignalPath() {
  return (
    <Band id="signal-path" unit="02" frameClassName="bg-surface-sunken">
      <div className={cx('flex flex-col gap-12 py-16 md:py-20', gutter)}>
        <SectionHeading index="02" eyebrow="Signal path" title="From one API call to a machine that converged">
          A request is decided once and written once. Everything after that is workers moving rows and
          daemons converging toward them, so a lost message is repaired by the next pass instead of
          lost with it.
        </SectionHeading>

        <ol className="grid lg:grid-cols-[repeat(5,minmax(0,1fr)_2rem)_minmax(0,1fr)] lg:items-stretch">
          {stations.map((station, index) => (
            <Fragment key={station.id}>
              <li className="flex min-w-0 flex-col border border-border-button-default bg-surface-raised">
                <span className="flex items-center justify-between gap-2 border-b border-separator-border px-3 py-1.5 font-mono text-[0.6875rem] tracking-[0.06em] text-text-tertiary uppercase">
                  <span>S{String(index + 1).padStart(2, '0')}</span>
                  <span className="led" data-on={index === 2} />
                </span>
                <span className="flex flex-col gap-2 px-3 py-3">
                  <span className="font-mono text-body-medium tracking-[-0.02em] text-text-primary">
                    {station.name}
                  </span>
                  <span className="text-caption-1-regular text-text-secondary">{station.role}</span>
                  <ul className="mt-1 flex flex-col gap-1 font-mono text-[0.6875rem] leading-4 text-text-secondary">
                    {station.facts.map((fact) => (
                      <li key={fact} className="flex min-w-0 gap-1.5 [overflow-wrap:anywhere]">
                        <span className="text-signal">›</span>
                        {fact}
                      </li>
                    ))}
                  </ul>
                </span>
              </li>
              {index < stations.length - 1 ? (
                <li aria-hidden className="flex items-center justify-center">
                  <span className="wire relative block h-6 w-px bg-separator-border lg:h-px lg:w-8" />
                </li>
              ) : null}
            </Fragment>
          ))}
        </ol>

        <div className="grid gap-px border border-separator-border bg-separator-border md:grid-cols-3">
          {[
            [
              'Reports flow back',
              'Nodes stream inventory, status and command results to the gateway, which writes them to Postgres with dedupe; reconcilers pick them up from there.',
            ],
            [
              'No IAM on the fleet path',
              'Joins, heartbeats, inventory and commands never call Better IAM. A ten-minute simulated run asserts zero calls.',
            ],
            [
              'Disconnected is not dead',
              'A node that goes quiet turns unreachable and unschedulable. Nothing it holds is released, and bare metal is never declared lost on its own.',
            ],
          ].map(([title, body]) => (
            <div key={title} className="flex flex-col gap-1.5 bg-background-full px-4 py-4">
              <span className="font-mono text-caption-1-medium text-text-primary">{title}</span>
              <span className="text-body-2-regular leading-5 text-text-secondary">{body}</span>
            </div>
          ))}
        </div>
      </div>
    </Band>
  );
}
