import { RiArrowRightLine, RiArrowRightUpLine } from 'react-icons/ri';
import { ActionLink } from '@/components/site/action';
import { Band, gutter } from '@/components/site/frame';
import { CreatorCredit } from '@/components/site/creator-credit';
import { WordReveal } from '@/components/site/motion-text';
import { cx } from '@/utils/cx';
import { FleetBoard } from './fleet-board';
import { InstallCommand } from './install-command';

/**
 * The first unit of the rack: the claim on the left and a simulated fleet board on the right, where GPU
 * reservations and CPU sandbox VMs book and release capacity under the placer's rules. (The Better IAM site opens with a full-width editorial headline
 * over a code walkthrough; the typed-API tour lives in the Build chapter here.)
 */
export function Hero() {
  return (
    <Band frameClassName="overflow-hidden">
      <div aria-hidden className="grid-lines pointer-events-none absolute inset-0 opacity-70" />

      <div
        className={cx(
          'relative grid gap-12 pt-16 pb-14 md:pt-20 md:pb-16 lg:grid-cols-12 lg:items-center lg:gap-10',
          gutter,
        )}
      >
        <div className="flex flex-col gap-7 lg:col-span-6 xl:col-span-5">
          <p className="eyebrow animate-float-in flex items-center gap-2.5">
            <span className="led" data-on="true" />
            Control plane · GPUs · CPUs · Sandboxes
          </p>

          {/* Set line by line: Plex Mono is wide, and balanced wrapping would orphan "for." */}
          {/* "Every GPU and core" is 18 characters of Plex Mono (0.54em each at this tracking): sizes keep it on one line. */}
          <h1 className="font-mono text-[1.75rem] leading-[1.06] font-medium tracking-[-0.06em] min-[400px]:text-[2rem] sm:text-[2.75rem] lg:text-[2.25rem] xl:text-[2.625rem]">
            <WordReveal text="Every GPU and core" immediate delay={0.08} className="block" />
            <WordReveal text="accounted for." immediate delay={0.16} className="block" />
            <WordReveal
              text="Nothing booked"
              immediate
              delay={0.3}
              className="block text-signal"
            />
            <WordReveal text="twice." immediate delay={0.38} className="block text-signal" />
          </h1>

          <p className="animate-float-in text-headline-regular leading-7 text-pretty text-text-secondary [animation-delay:220ms] md:text-[1.0625rem]">
            Better Compute is a TypeScript control plane for GPU and CPU fleets. It knows what
            exists, what is free, and who holds it, and Postgres referees every booking, from a
            whole NVLink set to a few vCPUs. It adopts running servers, deploys images over PXE, and
            runs isolated VMs as sandboxes on your hosts or a provider&rsquo;s, with Better IAM
            deciding who may do what.
          </p>

          <div className="animate-float-in flex flex-col gap-4 [animation-delay:300ms]">
            <div className="flex flex-wrap items-center gap-2.5">
              <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
                Get started
              </ActionLink>
              <ActionLink
                href="/docs/guides/concepts/architecture"
                variant="secondary"
                trailingIcon={RiArrowRightUpLine}
              >
                How it works
              </ActionLink>
            </div>
            <InstallCommand className="w-fit max-w-full" />
          </div>

          <dl className="animate-float-in grid grid-cols-2 gap-px border border-separator-border bg-separator-border font-mono text-[0.6875rem] leading-4 [animation-delay:380ms]">
            {[
              ['Runtime', 'Node.js 22.12+'],
              ['Database', 'PostgreSQL 16+ / PGlite'],
              ['Identity', 'Better IAM'],
              ['Agent', 'bcd, Go, Linux'],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 bg-background-full px-3 py-2">
                <dt className="tracking-[0.06em] text-text-tertiary uppercase">{label}</dt>
                <dd className="text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>

          <p className="text-caption-1-regular leading-5 text-text-tertiary">
            Not on npm yet: the command above runs eight simulated GPU machines from a checkout of
            the repository. bcd is written but not released.
          </p>
          <CreatorCredit />
        </div>

        <div className="animate-float-in min-w-0 [animation-delay:200ms] lg:col-span-6 xl:col-span-7">
          <FleetBoard />
          <p className="mt-3 font-mono text-[0.6875rem] leading-4 text-text-tertiary">
            An illustration of the placer&rsquo;s default scoring, not live data: GPU reservations
            on the fuller node first, as whole NVLink sets for 4 GPUs; sandbox VMs claiming vCPUs on
            CPU hosts; and a request that fits nowhere stays pending. Point at the board to hold it.
          </p>
        </div>
      </div>
    </Band>
  );
}
