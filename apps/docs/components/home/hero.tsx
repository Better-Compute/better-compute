import { Fragment } from 'react';
import Link from 'next/link';
import { highlight } from 'fumadocs-core/highlight';
import { RiArrowRightLine, RiArrowRightUpLine } from 'react-icons/ri';
import api from '@/generated/api.json';
import { ActionLink } from '@/components/site/action';
import { Band, gutter } from '@/components/site/frame';
import { codeThemes } from '@/lib/code-themes';
import { stats } from '@/lib/stats';
import { cx } from '@/utils/cx';
import { CreatorCredit } from '@/components/site/creator-credit';
import { WordReveal } from '@/components/site/motion-text';
import { HeroGrid } from './hero-grid';
import { HeroWindow, type HeroModule } from './hero-window';
import { InstallCommand } from './install-command';

/**
 * Checked against the real APIs: `betterCompute` options (packages/server/src/options.ts), the IAM bridge's
 * `embedded()` and `modules` (packages/iam), `joinTokens.create` and `nodes.get` (packages/server/src/api), and
 * the typed client (packages/client). The client's inputs are the validated shapes, so `duration` is in
 * milliseconds there and `binding` is spelled out. The code pane shows 17 lines: keep each snippet at most that
 * long, and keep `lines` in hero-window.tsx in step with it.
 */
const snippets = [
  `import { betterCompute } from 'better-compute';
import { metal } from 'better-compute/metal';
import { postgres } from 'better-compute/postgres';
import { provisionModule } from 'better-compute/provision';
import { vps } from 'better-compute/vps';

const bareMetal = metal();
const provision = provisionModule({ modules: [bareMetal] });

export const compute = betterCompute({
  database: postgres({ url: process.env.DATABASE_URL! }),
  secret: process.env.BETTER_COMPUTE_SECRET!,
  baseURL: 'https://compute.example.com',
  iam: bridge.embedded(iam, { rootTenantId }),
  modules: [provision, bareMetal, vps(), ...bridge.modules],
});
await compute.initialize();`,
  `// A single-use join token for the pool, shown once.
const { token } = await compute.api.joinTokens.create(cred, {
  tenantId,
  poolId,
  ttlSeconds: 3600,
  idempotencyKey: 'rack-7-node-3',
});

// On the machine, the install script runs \`bcd join\`:
//   BCD_JOIN_TOKEN=<token> sudo -E sh install-bcd.sh

// It joins, reports its GPUs and passes diag.nvml.
const node = await compute.api.nodes.get(cred, {
  tenantId,
  nodeId,
});
// → { provisionState: 'adopted', connectivity: 'connected' }`,
  `import { createComputeClient } from 'better-compute/client';
import type { compute } from '@/lib/compute';
const client = createComputeClient<typeof compute>({ token });

const reservation = await client.reservations.create({
  tenantId,
  poolId,
  devices: [{ class: 'gpu', count: 4, topology: 'nvlink-all' }],
  duration: 8 * 3_600_000, // 8 h
  binding: 'hold',
  idempotencyKey: crypto.randomUUID(),
});
// Bound on the node: 'active', with CDI devices.
const { binding } = await client.reservations.get({
  tenantId,
  reservationId: reservation.id,
});`,
];

/** The modules the hero's configuration registers, in registration order, as the live registry reports them. */
const heroModules: { name: string; kind: HeroModule['kind'] }[] = [
  { name: 'server', kind: 'built in' },
  { name: 'inventory', kind: 'built in' },
  { name: 'capacity', kind: 'built in' },
  { name: 'provision', kind: 'injected' },
  { name: 'metal', kind: 'injected' },
  { name: 'vps', kind: 'injected' },
];

/** Each module's groups and the methods it serves today (generated/api.json, status `registered`). */
function registeredModules(): HeroModule[] {
  return heroModules.map(({ name, kind }) => {
    const groups = api
      .filter((group) => group.module === name)
      .map((group) => ({
        group: group.group,
        served: group.methods.filter((method) => method.status === 'registered').length,
      }))
      .filter((group) => group.served > 0);
    return {
      name,
      kind,
      groups: groups.map((group) => group.group),
      methods: groups.reduce((sum, group) => sum + group.served, 0),
    };
  });
}

export async function Hero() {
  // Keyed, because the array itself crosses to the client component.
  const code = await Promise.all(
    snippets.map(async (source, index) => (
      <Fragment key={index}>
        {await highlight(source, { lang: 'ts', themes: codeThemes, defaultColor: false })}
      </Fragment>
    )),
  );

  return (
    <Band frameClassName="overflow-hidden">
      <HeroGrid />

      <div className={cx('relative pt-14 pb-12 md:pt-20 md:pb-14', gutter)}>
        <Link
          href="/docs/reference/changelog"
          className="animate-float-in group inline-flex items-center gap-2 rounded-full border border-border-button-default bg-background-primary-default py-1 ps-1 pe-3 text-caption-1-medium text-text-secondary shadow-xs transition-colors hover:border-border-button-hover hover:text-text-primary"
        >
          <span className="rounded-full bg-text-primary px-2 py-0.5 font-mono text-background-full">
            v{stats.version}
          </span>
          Pre-release · read the changelog
          <RiArrowRightLine
            className="size-3.5 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>

        <h1 className="mt-7 max-w-[15ch] text-[2.5rem] leading-[1.04] font-semibold tracking-[-0.045em] text-balance sm:text-[3.5rem] lg:max-w-[17ch] lg:text-[4.5rem]">
          <WordReveal text="GPU and bare-metal capacity" immediate delay={0.08} />{' '}
          <WordReveal
            text="that lives in your codebase"
            immediate
            delay={0.26}
            className="text-text-secondary"
          />
        </h1>

        <div className="mt-10 grid gap-8 lg:grid-cols-12 lg:items-end">
          <div className="animate-float-in flex flex-col gap-5 [animation-delay:220ms] lg:col-span-6">
            <p className="text-headline-regular leading-7 text-pretty text-text-secondary md:text-[1.0625rem]">
              Better Compute is a TypeScript control plane for GPU fleets. It knows what exists,
              what is free, and who holds it, and Postgres referees every booking, so nothing is
              booked twice. It adopts running servers, deploys images over PXE, and runs VPS on your
              hosts or a provider&rsquo;s, with Better IAM deciding who may do what.
            </p>
            <CreatorCredit />
          </div>
          <div className="animate-float-in flex flex-col gap-4 [animation-delay:300ms] lg:col-span-6 lg:col-start-7 lg:items-end">
            <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
              <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
                Get started
              </ActionLink>
              <InstallCommand />
              <ActionLink
                href="/docs/guides/concepts/architecture"
                variant="ghost"
                trailingIcon={RiArrowRightUpLine}
                className="bg-transparent"
              >
                How it works
              </ActionLink>
            </div>
            <p className="text-caption-1-regular text-text-secondary lg:text-end">
              Node.js 22.12+ <Dot /> PostgreSQL 16+ or PGlite <Dot /> Better IAM <Dot /> bcd, a Go
              daemon for Linux
            </p>
            <p className="max-w-md text-caption-1-regular leading-5 text-text-tertiary lg:text-end">
              Not on npm yet: the command runs eight simulated GPU machines from a checkout of the
              repository. bcd is written but not released.
            </p>
          </div>
        </div>
      </div>

      <div className={cx('relative pb-10 md:pb-14', gutter)}>
        <HeroWindow code={code} modules={registeredModules()} />
      </div>
    </Band>
  );
}

function Dot() {
  return (
    <span className="mx-1.5 inline-block size-[3px] rounded-full bg-text-tertiary align-middle" />
  );
}
