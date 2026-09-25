import type { ComponentType } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  RiArrowRightLine,
  RiArrowRightUpLine,
  RiBookOpenLine,
  RiBracesLine,
  RiCloudLine,
  RiCpuLine,
  RiPuzzleLine,
  RiRoadMapLine,
  RiServerLine,
  RiTerminalBoxLine,
} from 'react-icons/ri';
import { ChapterNav } from '@/components/home/chapter-nav';
import { CodeTour } from '@/components/home/code-tour';
import { CommandLanes } from '@/components/home/command-lanes';
import { CountUp } from '@/components/home/count-up';
import { FleetPlan } from '@/components/home/fleet-plan';
import { RunsOnStrip } from '@/components/home/framework-strip';
import { Hero } from '@/components/home/hero';
import { IamLanes } from '@/components/home/iam-lanes';
import { JoinFlow } from '@/components/home/join-flow';
import { MerkleAudit } from '@/components/home/merkle-audit';
import { MetalLifecycle } from '@/components/home/metal-lifecycle';
import { MotionProvider, Reveal } from '@/components/home/motion';
import { Pipeline } from '@/components/home/pipeline';
import { PlacementDemo } from '@/components/home/placement-demo';
import { SplitExplainer, StackedExplainer } from '@/components/home/section';
import { LogoMark } from '@/components/logo';
import { ActionLink, TextLink } from '@/components/site/action';
import { CreatorCredit } from '@/components/site/creator-credit';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { StaggerChild, StaggerList } from '@/components/site/motion-text';
import { JsonLd } from '@/components/json-ld';
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
 * The landing page. Every claim on it is checked against the code (packages/*\/src), the generated reference
 * (generated/*.json, through lib/stats.ts), or PLAN.md where it says what is designed rather than shipped.
 */
export default function HomePage() {
  return (
    <MotionProvider>
      <main className="relative flex flex-1 flex-col overflow-x-clip">
        <JsonLd data={siteJsonLd()} />
        <Hero />
        <RunsOnStrip />
        {/* The chapter bar stays pinned only while the chapters (01 to 10) are on screen. */}
        <div>
          <ChapterNav />
          <Pipeline />

          <StackedExplainer
            id="build"
            index="02"
            eyebrow="Build"
            sunken
            title="One typed API, from the control plane to the CLI"
            lede="Configure one instance with the modules you run. Every method is then a typed call on the server, in the browser client, and in the CLI, through the same envelope and the same IAM decision."
            points={[
              {
                lead: 'Typed end to end.',
                body: 'The client is inferred from typeof compute, so client.instances exists only when vps() is registered.',
              },
              {
                lead: 'Stable errors.',
                body: `Every failure carries one of ${stats.errorCodes} documented codes with its HTTP status.`,
              },
              {
                lead: 'Modules, not forks.',
                body: 'provision, metal, vps, events, fleet, rollout, and audit are passed in. The server never imports them.',
              },
            ]}
            href="/docs/guides/quickstart"
            linkLabel="Start the quickstart"
            visual={<CodeTour />}
          />

          <StackedExplainer
            id="join"
            index="03"
            eyebrow="Join"
            title="Machines join with a token, never a password"
            lede="A node only dials out. It trades a single-use join token, sealed to the JoinService key, for a 24-hour SPIFFE certificate, reports its inventory, and passes acceptance before anything can book it."
            points={[
              {
                lead: 'Relays cannot read it.',
                body: 'The sealed token is bound to the machine’s CSR, so the gateway that relays it can neither read nor replay it.',
              },
              {
                lead: 'Short-lived identity.',
                body: 'Node certificates last at most 24 hours, 2 in the ramdisk, and renew with a proof of possession of the current key.',
              },
              {
                lead: 'More ways in.',
                body: 'Certificate reclaim, provisioned and discovery tokens, AWS and GCP instance identity, and TPM attestors plug into the same JoinService.',
              },
              {
                lead: 'No IAM on the fleet path.',
                body: 'Joins, heartbeats, inventory, and commands never call Better IAM. A simulated run asserts zero calls.',
              },
            ]}
            href="/docs/guides/nodes/joining"
            linkLabel="How a node joins"
            visual={<JoinFlow />}
          />

          <StackedExplainer
            id="capacity"
            index="04"
            eyebrow="Capacity"
            sunken
            title="The database referees every booking"
            lede="Reservations book GPU atoms in Postgres. An EXCLUDE constraint on device bookings, guarded counters, and row locks make a double booking impossible, however many API replicas place at once."
            points={[
              {
                lead: 'One decision per request.',
                body: 'Better IAM decides compute:reservations:create once, on a draft that carries the GPU model, count, duration, and region for policies to test.',
              },
              {
                lead: 'Quota first.',
                body: 'Quota is charged all or nothing before placement. Running out is QUOTA_EXCEEDED, with the limit and the usage.',
              },
              {
                lead: 'Topology aware.',
                body: 'The placer prefers complete NVLink sets and the fewest NUMA nodes, and nvlink-all accepts nothing less.',
              },
              {
                lead: 'Two placers, one guarantee.',
                body: 'Inline placement answers in the request; pool-lease placement batches up to 64 per pool. Neither can double-book.',
              },
            ]}
            href="/docs/guides/capacity"
            linkLabel="How capacity works"
            visual={<PlacementDemo />}
          />

          <SplitExplainer
            id="bare-metal"
            index="05"
            eyebrow="Bare metal"
            reverse
            title="From a BMC address to a booted image"
            lede="Enroll a machine by its BMC, and metal takes it through inspection, commissioning, and deployment as workflows of persisted steps. The control plane side is built; the drivers that talk to BMCs and disks run in the site and ramdisk modes of bcd, which is not released yet."
            points={[
              {
                lead: 'Verified wipes.',
                body: 'A machine returns to ready only when the node signed the wipe result and every disk’s read-back passed.',
              },
              {
                lead: 'Resumable workflows.',
                body: 'Profiles expand into steps stored in Postgres, one active workflow per node, so the next worker resumes a crashed one.',
              },
              {
                lead: 'Sealed credentials.',
                body: 'BMC passwords become secret:// references at once and reach the site agent only as a JWE for one request.',
              },
              {
                lead: 'Your operating system.',
                body: 'Ubuntu autoinstall and Talos are written as outside profiles and steps, with no edits to the packages.',
              },
            ]}
            href="/docs/guides/bare-metal"
            linkLabel="The bare-metal lifecycle"
            visual={<MetalLifecycle />}
          />

          <StackedExplainer
            id="commands"
            index="06"
            eyebrow="Commands"
            sunken
            title="Commands that settle once, over any network"
            lede="Standing facts travel as generation-numbered desired state; one-shot actions are durable commands with a deadline. Each command is written to Postgres first, sent on one of three lanes, and settled in the database exactly once."
            points={[
              {
                lead: 'Three lanes.',
                body: 'Control, provision, and bulk lanes hold 8, 4, and 2 credits per session, so a log upload never blocks a reboot.',
              },
              {
                lead: 'Resumable.',
                body: 'After a reconnect, commands are replayed in order and the daemon’s journal drops the ones it already ran.',
              },
              {
                lead: 'Deadlines.',
                body: 'Every command carries not_after. The sweeper expires what never ran and fails what outlived its timeout.',
              },
              {
                lead: `${stats.commandKinds} declared kinds.`,
                body: 'Each kind names its lane, timeout, and agent roles, and whether it is retry-safe, attested, or destructive.',
              },
            ]}
            href="/docs/guides/nodes/commands"
            linkLabel="Commands and desired state"
            visual={<CommandLanes />}
          />

          <SplitExplainer
            id="fleet"
            index="07"
            eyebrow="Fleet as code"
            title="Your fleet, reviewed like code"
            lede="Describe a tenant’s sites, provider accounts, pools, offers, and flavors in one FleetConfig document. Plan shows every change and the exact calls it would make; apply runs all of them in one transaction, or none."
            points={[
              {
                lead: 'Exactly the reviewed plan.',
                body: 'Apply takes the planHash you reviewed. If the fleet moved since, nothing is applied and it fails with CONFIG_DRIFT.',
              },
              {
                lead: 'Decided call by call.',
                body: 'Every underlying call is checked for the caller first, so fleet:admin alone is never enough.',
              },
              {
                lead: 'Drift detection.',
                body: 'Each applied document is planned again every 15 minutes, publishing fleet.drifted and fleet.converged.',
              },
              {
                lead: 'Careful deletes.',
                body: 'Nothing is deleted without prune, and pruned pools are archived while their bookings keep running.',
              },
            ]}
            href="/docs/guides/fleet-config"
            linkLabel="FleetConfig"
            visual={<FleetPlan />}
          />

          <StackedExplainer
            id="audit"
            index="08"
            eyebrow="Audit"
            sunken
            title="An audit trail you can prove"
            lede="Every allowed mutation is recorded with the IAM context that admitted it. The audit module seals those events every hour into signed Merkle checkpoints per tenant, and a proof that any one event is sealed can be checked offline against the key’s pin."
            points={[
              {
                lead: 'Appended freely, sealed after.',
                body: 'Writers never wait on a chain head. Checkpoints follow commit order, so a slow transaction cannot land in a sealed range.',
              },
              {
                lead: 'Inclusion proofs.',
                body: 'audit prove writes an RFC 6962 proof for one event, and audit check-proof verifies it offline.',
              },
              {
                lead: 'Tampering shows.',
                body: 'audit verify recomputes every root, link, and signature, and exits AUDIT_TAMPERED on an edited, deleted, or inserted event.',
              },
            ]}
            href="/docs/guides/events/audit"
            linkLabel="How audit checkpoints work"
            visual={<MerkleAudit />}
          />

          <StackedExplainer
            id="iam"
            index="09"
            eyebrow="IAM"
            title="Better IAM decides, and the fleet never waits on it"
            lede="Better IAM is the only identity provider, policy decision point, and billing ledger. Each admission makes exactly one decision, while the fleet’s joins, heartbeats, inventory reports, and commands make none."
            points={[
              {
                lead: 'Requests are resources.',
                body: 'A reservation is decided as a draft, so policies can test its GPU model, count, duration, and region.',
              },
              {
                lead: 'Outsiders learn nothing.',
                body: 'A caller from another tenant gets ACCESS_DENIED before compute reads or writes its database.',
              },
              {
                lead: 'Usage in the ledger.',
                body: 'Reserved time lands in Better IAM’s billing as gpu.<model>.hours, from active to release.',
              },
              {
                lead: 'Agents ask first.',
                body: 'When a delegated agent’s session holds an action back, the request waits up to 30 minutes for a person to confirm.',
              },
            ]}
            href="/docs/guides/iam"
            linkLabel="The Better IAM integration"
            visual={<IamLanes />}
          />

          <MoreSection />
          <ReferenceSection />
        </div>
        <FinalCta />
      </main>
    </MotionProvider>
  );
}

function MoreSection() {
  const cards: { icon: Icon; title: string; href: string; items: string[] }[] = [
    {
      icon: RiCloudLine,
      title: 'VPS and providers',
      href: '/docs/guides/vps',
      items: [
        'Hosted VMs on your own GPU hosts, with whole GPUs passed through VFIO',
        'Hetzner Cloud and Proxmox VE as provider pools',
        'Hetzner Robot servers bootstrapped into metal pools',
        'Flavors, pool IPAM, and provider credentials only as secret references',
        'No platform agent or join token inside a tenant VM',
      ],
    },
    {
      icon: RiServerLine,
      title: 'Operations',
      href: '/docs/operations',
      items: [
        'PostgreSQL 16+ in production, PGlite for development and tests',
        'One configuration for the api, gateway, and worker processes',
        'Prometheus metrics whose labels never name a tenant',
        'A deterministic fleet simulator with chaos and invariant checks',
        `A CLI with ${stats.cliCommands} commands, from pki init to audit verify`,
      ],
    },
    {
      icon: RiPuzzleLine,
      title: 'Extending',
      href: '/docs/extending',
      items: [
        'Modules and plugins with their own API groups, tables, and reconcilers',
        'Drivers per concern (power, boot, deploy, and more), bound per hardware profile',
        'Workflow steps and profiles, as the Talos and Ubuntu walkthroughs show',
        'Providers, attestors, event sinks, and scheduler plugins',
      ],
    },
  ];
  return (
    <Band id="more">
      <div className={cx('py-16 md:py-20', gutter)}>
        <SectionHeading eyebrow="And more" title="The rest of the platform">
          VPS, operations, and extensions share the same pools, the same admission, and the same
          audit trail as everything above.
        </SectionHeading>
      </div>
      <StaggerList className="grid gap-px border-t border-separator-border bg-separator-border md:grid-cols-3">
        {cards.map(({ icon: CardIcon, ...card }) => (
          <li key={card.title} className="bg-background-full">
            <StaggerChild className="h-full">
              <Link href={card.href} className={cellLink}>
                <HoverHatch />
                <span className="relative flex items-center gap-3">
                  <IconTile icon={CardIcon} />
                  <span className="text-title-3-semibold">{card.title}</span>
                  <CellArrow className="ms-auto" />
                </span>
                <ul className="relative flex flex-col gap-2.5">
                  {card.items.map((item, index) => (
                    <li
                      key={item}
                      className="flex gap-2.5 text-body-regular leading-6 text-text-secondary transition-colors duration-300 group-hover:text-text-primary"
                      style={{ transitionDelay: `${index * 40}ms` }}
                    >
                      <span
                        aria-hidden
                        className="mt-[0.7rem] h-px w-2.5 shrink-0 bg-text-tertiary transition-[width,background-color] duration-300 group-hover:w-4 group-hover:bg-text-primary"
                        style={{ transitionDelay: `${index * 40}ms` }}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </Link>
            </StaggerChild>
          </li>
        ))}
      </StaggerList>
    </Band>
  );
}

function ReferenceSection() {
  const numbers = [
    {
      value: stats.methods,
      label: 'API methods',
      detail: `${stats.servedMethods} served today in ${stats.groups} groups, the rest planned`,
      href: '/docs/reference/api',
    },
    {
      value: stats.errorCodes,
      label: 'stable error codes',
      detail: 'each with its HTTP status and meaning',
      href: '/docs/reference/errors',
    },
    {
      value: stats.cliCommands,
      label: 'CLI commands',
      detail: 'from dev --sim to fleet apply and audit verify',
      href: '/docs/reference/cli',
    },
    {
      value: stats.commandKinds,
      label: 'command kinds',
      detail: 'each with its lane, timeout, and agent roles',
      href: '/docs/reference/command-kinds',
    },
    {
      value: stats.packages,
      label: 'packages',
      detail: 'the umbrella and every @better-compute package, none on npm yet',
      href: '/docs/reference/packages',
    },
  ];
  const resources: [string, string][] = [
    ['llms.txt', '/llms.txt'],
    ['llms-full.txt', '/llms-full.txt'],
    ['Command kinds', '/docs/reference/command-kinds'],
    ['Glossary', '/docs/reference/glossary'],
    ['Modules', '/docs/reference/modules'],
  ];
  return (
    <Band id="reference" frameClassName="bg-surface-sunken">
      <div className={cx('grid gap-8 py-16 md:py-20 lg:grid-cols-12', gutter)}>
        <SectionHeading
          index="10"
          eyebrow="Reference"
          title="Generated from the source"
          className="lg:col-span-6"
        >
          The reference is extracted from the live method registry, the CLI manifest, and the
          command kind table, so every count, route, and flag on it comes from the code.
        </SectionHeading>
        <div className="flex flex-wrap content-end gap-2 lg:col-span-5 lg:col-start-8 lg:justify-end">
          {resources.map(([label, href]) => (
            <ActionLink
              key={href}
              href={href}
              variant="secondary"
              size="small"
              trailingIcon={RiArrowRightUpLine}
              className="font-mono text-caption-1-regular"
            >
              {label}
            </ActionLink>
          ))}
        </div>
      </div>
      <StaggerList className="grid gap-px border-t border-separator-border bg-separator-border sm:grid-cols-2 lg:grid-cols-5">
        {numbers.map((item, index) => (
          <li
            key={item.label}
            // Five cells: the first spans the two-column row, so no row is left half empty.
            className={cx('bg-surface-sunken', index === 0 && 'sm:col-span-2 lg:col-span-1')}
          >
            <StaggerChild className="h-full">
              <Link href={item.href} className={cx(cellLink, 'gap-2')}>
                <HoverHatch />
                <CountUp
                  value={item.value}
                  className="relative text-display-2-medium tracking-[-0.04em] tabular-nums transition-transform duration-300 ease-out group-hover:-translate-y-1"
                />
                <span className="relative text-body-medium">{item.label}</span>
                <span className="relative text-body-2-regular text-text-secondary">
                  {item.detail}
                </span>
                <CellArrow className="relative mt-3" />
              </Link>
            </StaggerChild>
          </li>
        ))}
      </StaggerList>
    </Band>
  );
}

function FinalCta() {
  const paths: { icon: Icon; title: string; body: string; href: string }[] = [
    {
      icon: RiBookOpenLine,
      title: 'Read the guides',
      body: 'Concepts first, then nodes, capacity, bare metal, and VPS.',
      href: '/docs/guides',
    },
    {
      icon: RiCpuLine,
      title: 'Understand capacity',
      body: 'Pools, placement, reservations, quotas, and why nothing is booked twice.',
      href: '/docs/guides/capacity',
    },
    {
      icon: RiBracesLine,
      title: 'Browse the API',
      body: `${stats.methods} methods with their routes, IAM actions, and phases.`,
      href: '/docs/reference/api',
    },
    {
      icon: RiTerminalBoxLine,
      title: 'Run it locally',
      body: 'Simulated GPU machines on PGlite, with one command.',
      href: '/docs/operations/local-development',
    },
  ];
  return (
    <Band marks={false}>
      <div className="grid lg:grid-cols-2">
        <div
          className={cx(
            'relative flex flex-col items-start gap-6 overflow-hidden border-b border-separator-border py-16 md:py-20 lg:border-e lg:border-b-0',
            gutter,
          )}
        >
          <div
            aria-hidden
            className="hatch hatch-drift pointer-events-none absolute inset-0 opacity-60"
          />
          <Reveal className="relative flex flex-col items-start gap-6">
            <LogoMark className="size-10 text-signal-fill" />
            <h2 className="max-w-md text-display-4-semibold tracking-[-0.03em] text-balance md:text-display-3-semibold md:leading-[1.12]">
              Run your own GPU capacity, with the guarantees of a database
            </h2>
            <p className="max-w-md text-headline-regular leading-7 text-pretty text-text-secondary">
              Start with simulated machines on PGlite, move to PostgreSQL, and keep every node,
              booking, and audit event in your own database. Better Compute is pre-release: nothing
              is on npm yet, and bcd is written but not released.
            </p>
            <CreatorCredit label="Built and maintained by" />
            <div className="mt-2 flex flex-wrap gap-2.5">
              <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
                Start the quickstart
              </ActionLink>
              <ActionLink
                href="/docs/reference/roadmap"
                variant="secondary"
                leadingIcon={RiRoadMapLine}
              >
                See the roadmap
              </ActionLink>
            </div>
          </Reveal>
        </div>
        <StaggerList className="grid gap-px bg-separator-border sm:grid-cols-2">
          {paths.map(({ icon: PathIcon, ...path }) => (
            <li key={path.title} className="bg-background-full">
              <StaggerChild className="h-full">
                <Link href={path.href} className={cx(cellLink, 'gap-2')}>
                  <HoverHatch />
                  <IconTile icon={PathIcon} className="relative" />
                  <span className="relative mt-2 flex items-center gap-1.5 text-headline-medium">
                    {path.title}
                    <CellArrow />
                  </span>
                  <span className="relative text-body-regular leading-6 text-text-secondary">
                    {path.body}
                  </span>
                </Link>
              </StaggerChild>
            </li>
          ))}
        </StaggerList>
      </div>
      <p
        className={cx(
          'border-t border-separator-border py-5 text-body-regular text-text-secondary',
          gutter,
        )}
      >
        New to fleets, pools, and reservations?{' '}
        <TextLink
          href="/docs/guides/concepts"
          trailingIcon={RiArrowRightLine}
          className="inline-flex"
        >
          Start with the concepts
        </TextLink>
      </p>
    </Band>
  );
}

/** Grid cell links in the closing sections: full-cell hit area, press feedback, and a hatched hover fill. */
const cellLink =
  'group relative flex h-full flex-col gap-5 overflow-hidden p-6 transition-colors duration-200 hover:bg-background-secondary-default active:bg-background-secondary-hover sm:p-8';

function HoverHatch() {
  return (
    <span
      aria-hidden
      className="hatch pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
    />
  );
}

/** A BoardUI icon tile that inverts to solid ink when its cell is hovered. */
function IconTile({ icon: TileIcon, className }: { icon: Icon; className?: string }) {
  return (
    <span
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-2lg border border-border-button-default bg-background-primary-default text-foreground-icon-primary shadow-xs transition-[background-color,border-color,color,transform] duration-300 group-hover:-rotate-6 group-hover:border-text-primary group-hover:bg-text-primary group-hover:text-background-full',
        className,
      )}
    >
      <TileIcon className="size-[18px]" aria-hidden />
    </span>
  );
}

function CellArrow({ className }: { className?: string }) {
  return (
    <RiArrowRightLine
      className={cx(
        'size-4 shrink-0 text-foreground-icon-tertiary transition-[color,transform] duration-300 group-hover:translate-x-1 group-hover:text-foreground-icon-primary',
        className,
      )}
      aria-hidden
    />
  );
}
