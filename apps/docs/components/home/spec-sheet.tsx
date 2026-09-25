import Link from 'next/link';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { cx } from '@/utils/cx';

/**
 * The guarantees as a datasheet: what holds, the mechanism that makes it hold, and what checks it. The invariant
 * names follow packages/testing/src/sim/invariants.ts (I1 no overlapping bookings, I2 at most one execution per
 * command, I4 no liveness false positives, I5 no release caused by a disconnect); the test files exist in tests/.
 */
const rows: { guarantee: string; mechanism: string; checked: string; href: string }[] = [
  {
    guarantee: 'Nothing is booked twice',
    mechanism:
      'EXCLUDE constraint on device bookings over time ranges; guarded counters for vCPU and memory; a fixed lock order',
    checked: 'I1 in the fleet simulator · tests/capacity-torture.test.ts',
    href: '/docs/guides/capacity',
  },
  {
    guarantee: 'A command runs at most once',
    mechanism:
      'Commands written to Postgres first, delivered on lanes with credits, deduplicated by the daemon’s journal',
    checked: 'I2 in the fleet simulator, with crashes and journal loss',
    href: '/docs/daemon/delivery',
  },
  {
    guarantee: 'Disconnected is not dead',
    mechanism:
      'Liveness only moves a node to unreachable; releases need an allowed cause; bare metal is never lost automatically',
    checked: 'I4 and I5 in the fleet simulator, with partitions and gateway kills',
    href: '/docs/guides/concepts/consistency',
  },
  {
    guarantee: 'One decision per request, none on the fleet path',
    mechanism:
      'The envelope asks Better IAM once, on the draft; joins, heartbeats and commands never call it',
    checked: 'tests/sim/iam-negative.test.ts: zero IAM calls in a 10-minute run',
    href: '/docs/guides/iam',
  },
  {
    guarantee: 'Only the node can confirm what it did',
    mechanism:
      'Signed commands and specs; a reservation goes active only on the node’s own signed AllocationBound',
    checked: 'tests/e2e/attested-bindings.test.ts: a gateway-forged binding is rejected',
    href: '/docs/operations/security',
  },
  {
    guarantee: 'The audit trail is provable',
    mechanism:
      'Hourly signed Merkle checkpoints per tenant (RFC 6962) over audit_events, in commit order',
    checked: 'better-compute audit verify · audit prove',
    href: '/docs/guides/events/audit',
  },
];

export function SpecSheet() {
  return (
    <Band id="guarantees" unit="04">
      <div className={cx('flex flex-col gap-10 py-16 md:py-20', gutter)}>
        <SectionHeading index="04" eyebrow="Guarantees" title="The datasheet">
          What holds under load, crashes and partitions, the mechanism behind each guarantee, and the
          test or tool in the repository that checks it.
        </SectionHeading>

        <div className="overflow-x-auto border border-border-button-default">
          <table className="w-full min-w-[44rem] border-collapse text-start">
            <thead>
              <tr className="bg-surface-sunken font-mono text-[0.6875rem] tracking-[0.06em] text-text-tertiary uppercase">
                <th scope="col" className="w-[26%] px-4 py-2 text-start font-normal">
                  Guarantee
                </th>
                <th scope="col" className="px-4 py-2 text-start font-normal">
                  Mechanism
                </th>
                <th scope="col" className="w-[30%] px-4 py-2 text-start font-normal">
                  Checked by
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.guarantee}
                  className="group border-t border-separator-border transition-colors hover:bg-background-secondary-default"
                >
                  <th scope="row" className="px-4 py-3 text-start align-top font-normal">
                    <Link
                      href={row.href}
                      className="flex items-start gap-2.5 font-mono text-body-2-medium tracking-[-0.02em] text-text-primary group-hover:text-signal"
                    >
                      <span className="led mt-1.5" data-on="true" />
                      {row.guarantee}
                    </Link>
                  </th>
                  <td className="px-4 py-3 align-top text-body-2-regular leading-5 text-text-secondary">
                    {row.mechanism}
                  </td>
                  <td className="px-4 py-3 align-top font-mono text-caption-1-regular leading-5 text-text-secondary">
                    {row.checked}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Band>
  );
}
