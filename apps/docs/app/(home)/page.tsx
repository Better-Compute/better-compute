import type { ComponentType } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  RiArrowRightLine,
  RiArrowRightUpLine,
  RiBookOpenLine,
  RiBracesLine,
  RiPuzzleLine,
  RiRoadMapLine,
  RiServerLine,
  RiTerminalBoxLine,
} from 'react-icons/ri';
import { CommandLanes } from '@/components/home/command-lanes';
import { CountUp } from '@/components/home/count-up';
import { DeepDives, type DeepDive } from '@/components/home/deep-dives';
import { FleetPlan } from '@/components/home/fleet-plan';
import { RunsOnStrip } from '@/components/home/framework-strip';
import { Hero } from '@/components/home/hero';
import { IamLanes } from '@/components/home/iam-lanes';
import { JoinFlow } from '@/components/home/join-flow';
import { MerkleAudit } from '@/components/home/merkle-audit';
import { MetalLifecycle } from '@/components/home/metal-lifecycle';
import { ModuleRack } from '@/components/home/module-rack';
import { MotionProvider } from '@/components/home/motion';
import { PlacementDemo } from '@/components/home/placement-demo';
import { QuickstartTerminal } from '@/components/home/quickstart-terminal';
import { Resources } from '@/components/home/resources';
import { SandboxPanel } from '@/components/home/sandbox-panel';
import { SignalPath } from '@/components/home/signal-path';
import { SpecSheet } from '@/components/home/spec-sheet';
import { JsonLd } from '@/components/json-ld';
import { LogoMark } from '@/components/logo';
import { ActionLink } from '@/components/site/action';
import { CreatorCredit } from '@/components/site/creator-credit';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { pageMetadata, siteDescription, siteImages, siteJsonLd, siteTitle } from '@/lib/metadata';
import { stats } from '@/lib/stats';
import { cx } from '@/utils/cx';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

export const metadata: Metadata = pageMetadata({
  title: siteTitle,
  absolute: true,
  description: siteDescription,
  path: '/',
  image: siteImages.home,
});

/**
 * The landing page, laid out as an operator's console rather than a scroll of chapters: the fleet board, one ledger
 * for three kinds of capacity, the signal path, the interactive diagrams as channels of one monitor, the datasheet,
 * the module rack, and a terminal session. Every claim is checked against the code (packages/*\/src), the generated
 * reference (generated/*.json, through lib/stats.ts), or PLAN.md where it says what is designed rather than shipped.
 */
export default function HomePage() {
  const dives: DeepDive[] = [
    {
      id: 'join',
      label: 'Join',
      title: 'Machines join with a token, never a password',
      claim:
        'A node only dials out. It trades a single-use join token, sealed to the JoinService key and bound to its CSR, for a 24-hour SPIFFE certificate, reports its inventory, and passes acceptance before anything can book it.',
      href: '/docs/guides/nodes/joining',
      linkLabel: 'How a node joins',
      stage: <JoinFlow />,
    },
    {
      id: 'placement',
      label: 'Placement',
      title: 'The database referees every booking',
      claim:
        'Race two requests for the same GPUs and watch one win. Quota is charged first, the placer scores nodes, and an EXCLUDE constraint makes a double booking impossible however many replicas place at once.',
      href: '/docs/guides/capacity/placement',
      linkLabel: 'Placement',
      stage: <PlacementDemo />,
    },
    {
      id: 'sandboxes',
      label: 'Sandboxes',
      title: 'Isolated VMs, from flavor to teardown',
      claim:
        'A sandbox is an instance with its own VM: sized by a flavor, admitted like a reservation, reached only through single-use tunnel tickets, and gone without a trace when deleted.',
      href: '/docs/guides/vps/sandboxes',
      linkLabel: 'Sandboxes',
      stage: <SandboxPanel />,
    },
    {
      id: 'metal',
      label: 'Bare metal',
      title: 'From a BMC address to a booted image',
      claim:
        'Enroll a machine by its BMC, and metal takes it through inspection, commissioning and deployment as workflows of persisted steps, with node-signed wipes. The site and ramdisk halves run in bcd, which is not released yet.',
      href: '/docs/guides/bare-metal',
      linkLabel: 'The bare-metal lifecycle',
      stage: <MetalLifecycle />,
    },
    {
      id: 'commands',
      label: 'Commands',
      title: 'Commands that settle once, over any network',
      claim: `Standing facts travel as generation-numbered desired state; one-shot actions are durable commands on three lanes, with deadlines. ${stats.commandKinds} declared kinds, each with its lane, timeout and safety flags.`,
      href: '/docs/guides/nodes/commands',
      linkLabel: 'Commands and desired state',
      stage: <CommandLanes />,
    },
    {
      id: 'fleet',
      label: 'Fleet as code',
      title: 'Your fleet, reviewed like code',
      claim:
        'Describe sites, pools, offers and flavors in one FleetConfig document. Plan shows every call it would make; apply runs the reviewed plan in one transaction, or nothing when the fleet moved since.',
      href: '/docs/guides/fleet-config',
      linkLabel: 'FleetConfig',
      stage: <FleetPlan />,
    },
    {
      id: 'audit',
      label: 'Audit',
      title: 'An audit trail you can prove',
      claim:
        'Every allowed mutation is recorded with the IAM context that admitted it, then sealed hourly into signed Merkle checkpoints per tenant. Edit, delete or insert an event and verification fails.',
      href: '/docs/guides/events/audit',
      linkLabel: 'Audit checkpoints',
      stage: <MerkleAudit />,
    },
    {
      id: 'iam',
      label: 'IAM',
      title: 'Better IAM decides, and the fleet never waits on it',
      claim:
        'Each admission makes exactly one decision on a draft policies can inspect, usage lands in Better IAM’s ledger, and a delegated agent’s held-back request waits for a person to confirm.',
      href: '/docs/guides/iam',
      linkLabel: 'The Better IAM integration',
      stage: <IamLanes />,
    },
  ];

  return (
    <MotionProvider>
      <main className="relative flex flex-1 flex-col overflow-x-clip">
        <JsonLd data={siteJsonLd()} />
        <Hero />
        <RunsOnStrip />
        <Resources />
        <SignalPath />
        <Band id="deep-dives" unit="03">
          <div className={cx('flex flex-col gap-10 py-16 md:py-20', gutter)}>
            <SectionHeading index="03" eyebrow="Deep dives" title="Eight channels into the machine room">
              Each channel is a working model of one part of the system: race two placements, edit an
              audit row and watch its proof fail, cut a node&rsquo;s session mid-command. Pick a channel; only that one runs.
            </SectionHeading>
            <DeepDives dives={dives} />
          </div>
        </Band>
        <SpecSheet />
        <ModuleRack />
        <QuickstartTerminal />
        <Closing />
      </main>
    </MotionProvider>
  );
}

/** The last unit: the reference in numbers, and where to go next. */
function Closing() {
  const numbers = [
    {
      value: stats.methods,
      label: 'API methods',
      detail:
        stats.servedMethods === stats.methods
          ? `all served today, in ${stats.groups} groups`
          : `${stats.servedMethods} served today in ${stats.groups} groups`,
      href: '/docs/reference/api',
    },
    {
      value: stats.errorCodes,
      label: 'error codes',
      detail: 'each with its HTTP status',
      href: '/docs/reference/errors',
    },
    {
      value: stats.cliCommands,
      label: 'CLI commands',
      detail: 'dev --sim to audit verify',
      href: '/docs/reference/cli',
    },
    {
      value: stats.commandKinds,
      label: 'command kinds',
      detail: 'lanes, timeouts, roles',
      href: '/docs/reference/command-kinds',
    },
  ];
  const paths: { icon: Icon; title: string; body: string; href: string }[] = [
    {
      icon: RiBookOpenLine,
      title: 'Guides',
      body: 'Concepts, nodes, capacity, bare metal, VPS and sandboxes.',
      href: '/docs/guides',
    },
    {
      icon: RiBracesLine,
      title: 'API reference',
      body: 'Every method, generated from the live registry.',
      href: '/docs/reference/api',
    },
    {
      icon: RiPuzzleLine,
      title: 'Extending',
      body: 'Modules, methods, drivers, attestors and providers.',
      href: '/docs/extending',
    },
    {
      icon: RiServerLine,
      title: 'Operations',
      body: 'Deploy, secure, observe and scale.',
      href: '/docs/operations',
    },
    {
      icon: RiTerminalBoxLine,
      title: 'Daemon and protocol',
      body: 'bcd, sessions, delivery and the gateway.',
      href: '/docs/daemon',
    },
    {
      icon: RiRoadMapLine,
      title: 'Roadmap',
      body: 'What is built, and what comes next.',
      href: '/docs/reference/roadmap',
    },
  ];
  return (
    <Band id="reference" unit="07" marks={false}>
      <div className="grid grid-cols-1 lg:grid-cols-12">
        <div
          className={cx(
            'relative flex flex-col items-start gap-6 overflow-hidden border-b border-separator-border py-16 md:py-20 lg:col-span-5 lg:border-e lg:border-b-0',
            gutter,
          )}
        >
          <div aria-hidden className="hatch pointer-events-none absolute inset-0 opacity-50" />
          <LogoMark className="relative size-10 text-signal-fill" />
          <h2 className="relative font-mono text-[1.875rem] leading-[1.1] font-medium tracking-[-0.05em] text-balance md:text-[2.25rem]">
            Run your own GPU, CPU and sandbox capacity, with the guarantees of a database
          </h2>
          <p className="relative max-w-md text-body-regular leading-6 text-text-secondary">
            Pre-release: nothing is on npm yet, and bcd is written but not released. Everything
            else runs today from a checkout, on PGlite or PostgreSQL.
          </p>
          <CreatorCredit label="Built and maintained by" className="relative" />
          <div className="relative flex flex-wrap gap-2.5">
            <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
              Start the quickstart
            </ActionLink>
            <ActionLink href="/llms.txt" variant="secondary" trailingIcon={RiArrowRightUpLine}>
              llms.txt
            </ActionLink>
          </div>
        </div>

        <div className="flex flex-col lg:col-span-7">
          <ul className="grid grid-cols-2 gap-px border-b border-separator-border bg-separator-border sm:grid-cols-4">
            {numbers.map((item) => (
              <li key={item.label} className="bg-background-full">
                <Link
                  href={item.href}
                  className="group flex h-full flex-col gap-1 px-5 py-6 transition-colors hover:bg-background-secondary-default"
                >
                  <CountUp
                    value={item.value}
                    className="font-mono text-[2rem] leading-none font-medium tracking-[-0.05em] text-text-primary tabular-nums group-hover:text-signal"
                  />
                  <span className="font-mono text-caption-1-medium text-text-primary">
                    {item.label}
                  </span>
                  <span className="text-caption-1-regular text-text-tertiary">{item.detail}</span>
                </Link>
              </li>
            ))}
          </ul>
          <ul className="grid flex-1 grid-cols-2 gap-px bg-separator-border sm:grid-cols-3">
            {paths.map(({ icon: PathIcon, title, body, href }) => (
              <li key={href} className="bg-background-full">
                <Link
                  href={href}
                  className="group flex h-full flex-col justify-between gap-6 px-5 py-5 transition-colors hover:bg-background-secondary-default"
                >
                  <span className="flex items-center justify-between">
                    <PathIcon
                      className="size-4 shrink-0 text-foreground-icon-secondary group-hover:text-signal"
                      aria-hidden
                    />
                    <RiArrowRightLine
                      className="size-3.5 text-foreground-icon-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-signal"
                      aria-hidden
                    />
                  </span>
                  <span className="flex flex-col gap-1">
                    <span className="font-mono text-body-2-medium text-text-primary">{title}</span>
                    <span className="text-caption-1-regular leading-4 text-text-tertiary">{body}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Band>
  );
}
