import Link from 'next/link';
import { RiArrowRightLine, RiArrowRightUpLine } from 'react-icons/ri';
import { ActionLink } from '@/components/site/action';
import { Band, gutter } from '@/components/site/frame';
import { stats } from '@/lib/stats';
import { cx } from '@/utils/cx';
import { CountUp } from './count-up';
import { FleetBoard } from './fleet-board';
import { InstallCommand } from './install-command';

/** What the control plane does, one tag each, below the pitch. */
const capabilities = ['Adopts running servers', 'Deploys bare metal', 'Runs sandbox VMs', 'Better IAM decides'];

/** What the control plane needs, as a spec plate. */
const plate: [string, string][] = [
  ['Runtime', 'Node.js 22.12+'],
  ['Database', 'PostgreSQL 16+ / PGlite'],
  ['Identity', 'Better IAM'],
  ['Agent', 'bcd · Go · Linux'],
];

/** The reference in numbers, read from the generated catalog (lib/stats.ts), each linking to its page. */
const readout = [
  {
    value: stats.methods,
    label: 'API methods',
    detail:
      stats.servedMethods === stats.methods
        ? `all served, ${stats.groups} groups`
        : `${stats.servedMethods} served, ${stats.groups} groups`,
    href: '/docs/reference/api',
  },
  { value: stats.errorCodes, label: 'error codes', detail: 'each with its HTTP status', href: '/docs/reference/errors' },
  { value: stats.cliCommands, label: 'CLI commands', detail: 'dev --sim to audit verify', href: '/docs/reference/cli' },
  {
    value: stats.commandKinds,
    label: 'command kinds',
    detail: 'lanes, timeouts, roles',
    href: '/docs/reference/command-kinds',
  },
];

/**
 * One line of the headline, its words blurring in one after another. Pure CSS (`.animate-blur-in`), so the largest
 * element on the page shows as soon as the HTML arrives instead of waiting for hydration, and reduced motion shows
 * it at once.
 */
function Line({ text, delay, className }: { text: string; delay: number; className?: string }) {
  const words = text.split(' ');
  return (
    <span className={cx('block', className)}>
      {words.map((word, index) => (
        <span key={index}>
          <span
            className="animate-blur-in inline-block"
            style={{ animationDelay: `${delay + index * 45}ms` }}
          >
            {word}
          </span>
          {index < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </span>
  );
}

/**
 * The console's first screen, one screen tall on a laptop: the claim, the pitch and the actions on the left, the
 * simulated fleet board on the right (GPU reservations and CPU sandbox VMs booking and releasing under the placer's
 * rules), and a readout strip across the bottom with the reference counts and what the control plane runs on.
 */
export function Hero() {
  return (
    <Band frameClassName="overflow-hidden">
      <div aria-hidden className="grid-lines pointer-events-none absolute inset-0 opacity-50" />

      <div
        className={cx(
          'relative grid grid-cols-1 gap-10 pt-12 pb-10 md:pt-16 lg:grid-cols-12 lg:items-center lg:gap-12 lg:pb-12',
          gutter,
        )}
      >
        <div className="flex flex-col gap-6 lg:col-span-5">
          <p className="eyebrow animate-float-in flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="led" data-on="true" />
            <span className="text-text-primary">better/compute v{stats.version}</span>
            <span className="text-text-tertiary">·</span>
            GPUs, CPUs and sandboxes
          </p>

          {/* Plex Mono is 0.54em a character at this tracking and the longest line is 21 characters, so these
              sizes keep every line whole: full width below lg, five of twelve columns from lg. */}
          <h1 className="font-mono text-[1.75rem] leading-[1.04] font-medium tracking-[-0.06em] min-[400px]:text-[1.875rem] sm:text-[2.75rem] md:text-[3.25rem] lg:text-[2.25rem] xl:text-[2.625rem]">
            <Line text="Every GPU and core" delay={80} />
            <Line text="accounted for." delay={180} />
            <Line text="Nothing booked twice." delay={320} className="text-signal" />
          </h1>

          <p className="animate-float-in max-w-xl text-body-regular leading-6 text-pretty text-text-secondary [animation-delay:200ms] md:text-headline-regular md:leading-7">
            A TypeScript control plane you embed. It knows what exists, what is free and who holds
            it, and Postgres referees every booking, from a whole NVLink set to a few vCPUs.
          </p>

          <ul className="animate-float-in flex flex-wrap gap-1.5 [animation-delay:240ms]">
            {capabilities.map((item) => (
              <li
                key={item}
                className="border border-separator-border px-2 py-0.5 font-mono text-[0.6875rem] leading-4 tracking-[0.04em] text-text-secondary"
              >
                {item}
              </li>
            ))}
          </ul>

          <div className="animate-float-in flex flex-col gap-3 [animation-delay:280ms]">
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

        <div className="flex min-w-0 flex-col gap-2 lg:col-span-7">
          <FleetBoard compact className="animate-float-in [animation-delay:320ms]" />
          <p className="font-mono text-[0.6875rem] leading-4 text-text-tertiary">
            Simulated, not live data: whole NVLink sets for 4-GPU jobs, sandbox VMs claiming vCPUs,
            and a request that fits nowhere stays pending. Point at the board to hold it.
          </p>
        </div>
      </div>

      <div className="relative grid grid-cols-2 gap-px border-t border-separator-border bg-separator-border sm:grid-cols-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
        {readout.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className="group flex flex-col gap-1 bg-background-full px-5 py-5 transition-colors hover:bg-background-secondary-default lg:px-6"
          >
            <CountUp
              value={item.value}
              className="font-mono text-[1.75rem] leading-none font-medium tracking-[-0.05em] text-text-primary tabular-nums group-hover:text-signal"
            />
            <span className="font-mono text-caption-1-medium text-text-primary">{item.label}</span>
            <span className="text-caption-1-regular text-text-tertiary">{item.detail}</span>
          </Link>
        ))}
        <dl className="col-span-2 grid grid-cols-2 gap-px bg-separator-border font-mono text-[0.6875rem] leading-4 sm:col-span-4 lg:col-span-1">
          {plate.map(([label, value]) => (
            <div key={label} className="flex flex-col justify-center gap-1 bg-background-full px-4 py-2.5">
              <dt className="tracking-[0.06em] text-text-tertiary uppercase">{label}</dt>
              <dd className="text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Band>
  );
}
