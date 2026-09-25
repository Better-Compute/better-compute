import { RiArrowRightLine, RiArrowRightUpLine } from 'react-icons/ri';
import { ActionLink } from '@/components/site/action';
import { Band, gutter } from '@/components/site/frame';
import { CreatorCredit } from '@/components/site/creator-credit';
import { WordReveal } from '@/components/site/motion-text';
import { stats } from '@/lib/stats';
import { cx } from '@/utils/cx';
import { FleetBoard } from './fleet-board';
import { InstallCommand } from './install-command';

/** What the control plane needs, as a spec plate. */
const plate: [string, string][] = [
  ['Runtime', 'Node.js 22.12+'],
  ['Database', 'PostgreSQL 16+ / PGlite'],
  ['Identity', 'Better IAM'],
  ['Agent', 'bcd · Go · Linux'],
];

/**
 * The console's first screen: the claim across the top, the pitch and actions beside it, then the simulated fleet
 * board at full width, where GPU reservations and CPU sandbox VMs book and release capacity under the placer's rules.
 */
export function Hero() {
  return (
    <Band frameClassName="overflow-hidden">
      <div aria-hidden className="grid-lines pointer-events-none absolute inset-0 opacity-60" />

      <div className={cx('relative flex flex-col gap-10 pt-14 pb-10 md:pt-20', gutter)}>
        <p className="eyebrow animate-float-in flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="led" data-on="true" />
          <span className="text-text-primary">better/compute v{stats.version}</span>
          <span className="text-text-tertiary">·</span>
          control plane for GPUs, CPUs and sandboxes
        </p>

        <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-end">
          {/* Plex Mono is 0.54em a character at this tracking, and the longest line is 21 characters: these sizes
              keep every line whole from 375 px up (full width below lg, eight of twelve columns from lg). */}
          <h1 className="font-mono text-[1.75rem] leading-[1.02] font-medium tracking-[-0.06em] min-[400px]:text-[1.875rem] sm:text-[2.75rem] md:text-[3.25rem] lg:col-span-8 lg:text-[3rem] xl:text-[3.5rem]">
            <WordReveal text="Every GPU and core" immediate delay={0.08} className="block" />
            <WordReveal text="accounted for." immediate delay={0.18} className="block" />
            <WordReveal
              text="Nothing booked twice."
              immediate
              delay={0.32}
              className="block text-signal"
            />
          </h1>

          <div className="animate-float-in flex flex-col gap-5 [animation-delay:240ms] lg:col-span-4">
            <p className="text-body-regular leading-6 text-pretty text-text-secondary md:text-headline-regular md:leading-7">
              A TypeScript control plane you embed. It knows what exists, what is free and who holds
              it, and Postgres referees every booking, from a whole NVLink set to a few vCPUs. It
              adopts running servers, deploys bare metal over PXE, and runs isolated VMs as
              sandboxes, with Better IAM deciding who may do what.
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
                Get started
              </ActionLink>
              <ActionLink
                href="/docs/guides/concepts/architecture"
                variant="secondary"
                trailingIcon={RiArrowRightUpLine}
              >
                Architecture
              </ActionLink>
            </div>
            <InstallCommand className="w-fit max-w-full" />
          </div>
        </div>
      </div>

      <div className={cx('relative pb-6', gutter)}>
        <FleetBoard className="animate-float-in [animation-delay:320ms]" />
        <p className="mt-3 font-mono text-[0.6875rem] leading-4 text-text-tertiary">
          Simulated, not live data: GPU reservations on the fuller node first, as whole NVLink sets
          for 4 GPUs; sandbox VMs claiming vCPUs on CPU hosts; a request that fits nowhere stays
          pending. Point at the board to hold it.
        </p>
      </div>

      <div className={cx('relative flex flex-col gap-4 pb-10 md:flex-row md:items-center', gutter)}>
        <dl className="grid flex-1 grid-cols-2 gap-px border border-separator-border bg-separator-border font-mono text-[0.6875rem] leading-4 sm:grid-cols-4">
          {plate.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 bg-background-full px-3 py-2">
              <dt className="tracking-[0.06em] text-text-tertiary uppercase">{label}</dt>
              <dd className="text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
        <CreatorCredit />
      </div>
    </Band>
  );
}
