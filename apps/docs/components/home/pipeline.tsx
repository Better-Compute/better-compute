import { highlight } from 'fumadocs-core/highlight';
import { RiArrowRightLine } from 'react-icons/ri';
import { TextLink } from '@/components/site/action';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { codeThemes } from '@/lib/code-themes';
import { cx } from '@/utils/cx';
import { PipelineCarousel } from './pipeline-carousel';
import { Points } from './section';

/**
 * One machine and one reservation, as CLI calls (commands and flags from the CLI manifest; `api` builds its
 * input from key=value and key:=json items). The numbered comments are the stages of the carousel, which lights
 * their lines as it plays; keep the line numbers in `stages` (pipeline-carousel.tsx) in step with this.
 */
const code = `# 01 Join: bcd trades a sealed, single-use token for a certificate.
BCD_JOIN_TOKEN=bcjt_… sudo -E sh install-bcd.sh

# 02 Inventory: GPUs reported, diag.nvml passed, node adopted.
better-compute api inventory.get tenantId=$OPS nodeId=node_…

# 03 Pool: the owner offers the pool to a tenant, with a quota.
better-compute api pools.offer tenantId=$OPS poolId=$POOL \\
  toTenantId=$ACME quota:='{"gpu": 64}'

# 04 Reserve: one IAM decision, then four GPUs are booked.
better-compute reserve --tenant $ACME --pool $POOL --gpus 4 --for 8h

# 05 Bind: the node writes CDI devices; the reservation is active.
better-compute reservations get rsv_… --tenant $ACME --query binding

# 06 Meter: hourly usage windows go to Better IAM's ledger.
# 07 Release: bookings truncated, quota refunded, billing stops.
better-compute release rsv_… --tenant $ACME`;

const points = [
  {
    lead: 'Disconnected is not dead.',
    body: 'A node that stops reporting turns unreachable and unschedulable, but nothing it holds is released, and bare metal is never declared lost on its own.',
  },
  {
    lead: 'Level-triggered.',
    body: 'Reconcilers compare desired state with what nodes report, by generation, so a lost message is repaired by the next pass.',
  },
  {
    lead: 'One clock.',
    body: 'SQL reads time only from compute_now(), so reservation ends, leases, and deadlines agree across every process.',
  },
];

/** Chapter 01: a machine's path from joining to a metered reservation, and the CLI calls that drive it. */
export async function Pipeline() {
  const highlighted = await highlight(code, {
    lang: 'sh',
    themes: codeThemes,
    defaultColor: false,
  });
  return (
    <Band id="pipeline">
      <div className={cx('grid gap-10 py-16 md:py-20 lg:grid-cols-12', gutter)}>
        <SectionHeading
          index="01"
          eyebrow="Lifecycle"
          title="From power-on to a metered booking"
          className="lg:col-span-6"
        >
          A machine joins and reports what it has. A pool makes its GPUs schedulable. A reservation
          books them, binds them on the node as CDI devices, meters the time, and gives them back.
          Every step is a row in Postgres, moved by a reconciler.
        </SectionHeading>
        <div className="flex flex-col gap-5 lg:col-span-5 lg:col-start-8 lg:pt-10">
          <Points points={points} />
          <TextLink href="/docs/guides/concepts/architecture" trailingIcon={RiArrowRightLine}>
            Read the architecture overview
          </TextLink>
        </div>
      </div>
      <PipelineCarousel code={highlighted} />
    </Band>
  );
}
