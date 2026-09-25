'use client';

import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useSpring } from 'motion/react';
import type { IconType } from 'react-icons';
import {
  RiCheckLine,
  RiCpuLine,
  RiFileCodeLine,
  RiPauseLine,
  RiPlayLine,
  RiRestartLine,
  RiServerLine,
  RiShieldCheckLine,
  RiStackLine,
} from 'react-icons/ri';
import { Chip } from '@/components/base/badges/chip';
import { cx } from '@/utils/cx';
import { ease, useReducedMotionSafe, useStepper } from './motion';

/**
 * The hero's product window. Three pillars play in turn: the control plane is composed from its modules and
 * initialized, a machine joins with a single-use token and is adopted (`node.adopted`), and a typed client reserves
 * four GPUs that the node binds as CDI devices (`reservation.active`). Each pillar runs its code in the middle
 * while the scene on the right plays it out: a band follows the lines the scene is on, and the status bar reports
 * the event the pillar ends with. Names, states, and events follow PLAN.md §3.3–3.4 and the server, capacity, and
 * gateway packages; the Compose scene's groups come from the live registry (generated/api.json, via hero.tsx).
 */
const INTERVAL = 6400;
/** The outgoing scene takes this long to leave, so the next script starts after it. */
const SWAP = 400;
/** The code pane's rhythm in rem (`leading-5`, `py-4`), shared by the text and the band that follows it. */
const LINE = 1.25;
const PAD = 1;

type Script = { stages: number; every: number; start: number };

type Pillar = {
  label: string;
  icon: IconType;
  body: string;
  file: string;
  /** A stage every `every` ms after `start`, from 0 up to `stages`. */
  script: Script;
  /** The 1-based line range of the snippet each stage is running, indexed by stage. */
  lines: readonly (readonly [first: number, last: number])[];
  /** What the pillar leaves behind once its script reaches stage `at`. */
  event: { at: number; action: string; note: string };
};

/** A module as the Compose scene lists it: its API groups with a method served today, and how many methods. */
export interface HeroModule {
  name: string;
  kind: 'built in' | 'injected';
  groups: string[];
  methods: number;
}

const pillars: readonly Pillar[] = [
  {
    label: 'Compose',
    icon: RiStackLine,
    body: 'One betterCompute() instance with the modules you run, on your Postgres.',
    file: 'lib/compute.ts',
    // Imports, the instance and its built-in modules, the injected modules, then initialize().
    script: { stages: 3, every: 900, start: 700 },
    lines: [
      [1, 5],
      [10, 14],
      [15, 15],
      [17, 17],
    ],
    event: {
      at: 3,
      action: 'compute.initialize()',
      note: 'registry checked, migrated, modules started',
    },
  },
  {
    label: 'Join',
    icon: RiServerLine,
    body: 'A machine trades a sealed, single-use token for a certificate and is adopted.',
    file: 'scripts/add-node.ts',
    // The token, the machine's Join call, its certificate, its session and inventory, then adoption.
    script: { stages: 4, every: 750, start: 500 },
    lines: [
      [1, 7],
      [9, 10],
      [9, 10],
      [12, 12],
      [12, 17],
    ],
    event: { at: 4, action: 'node.adopted', note: 'diag.nvml passed, its GPUs are bookable' },
  },
  {
    label: 'Reserve',
    icon: RiCpuLine,
    body: 'GPUs booked under one IAM decision, then bound on the node as CDI devices.',
    file: 'app/gpus/reserve.ts',
    // The request, the IAM decision on its draft, the placement, then the binding.
    script: { stages: 4, every: 800, start: 500 },
    lines: [
      [5, 12],
      [5, 12],
      [5, 12],
      [13, 17],
      [13, 17],
    ],
    event: { at: 3, action: 'reservation.active', note: 'bound on the node, metering started' },
  },
];

export function HeroWindow({ code, modules }: { code: ReactNode[]; modules: HeroModule[] }) {
  const { ref, step, select, toggle, paused, hovered, setHovered } = useStepper(pillars.length, {
    interval: INTERVAL,
    hold: INTERVAL,
  });
  const pillar = pillars[step]!;
  // Replaying remounts the scene and restarts its script.
  const [run, setRun] = useState(0);
  const stage = useScript(pillar.script, `${step}:${run}`);
  const reduced = useReducedMotionSafe();
  const rotateX = useSpring(0, { stiffness: 150, damping: 20 });
  const rotateY = useSpring(0, { stiffness: 150, damping: 20 });

  // A slight tilt toward the pointer, so the window feels like an object on the page.
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (reduced || event.pointerType !== 'mouse') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    rotateY.set(((event.clientX - bounds.left) / bounds.width - 0.5) * 3);
    rotateX.set(-((event.clientY - bounds.top) / bounds.height - 0.5) * 3);
  }
  function onPointerLeave() {
    rotateX.set(0);
    rotateY.set(0);
    setHovered(false);
  }
  function replay() {
    select(step);
    setRun((value) => value + 1);
  }

  return (
    <div
      className="[perspective:1800px]"
      onPointerEnter={(event) => event.pointerType === 'mouse' && setHovered(true)}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <motion.div
        ref={ref}
        style={{ rotateX, rotateY }}
        className="overflow-hidden rounded-2xl border border-border-button-default bg-surface-raised shadow-sm transition-[border-color,box-shadow] duration-300 hover:border-border-button-hover hover:shadow-lg"
      >
        {/* No window chrome: a product panel, not a browser. Rail | code | result share one header row. */}
        <div className="xl:grid xl:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="xl:flex xl:flex-col xl:border-e xl:border-separator-border">
            <div className="hidden xl:block">
              <PaneHeader>
                <span className="live-dot" aria-hidden />
                <span>Walkthrough</span>
                <span className="ms-auto font-mono text-text-tertiary tabular-nums">
                  0{step + 1} / 0{pillars.length}
                </span>
              </PaneHeader>
            </div>
            {/* While the pointer rests on the card the pillar holds, so its scene can be read to the end. */}
            <PillarTabs step={step} paused={paused || hovered} onSelect={select} />
          </div>

          <div
            id="hero-panel"
            role="tabpanel"
            aria-label={pillar.label}
            className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_21rem]"
          >
            <CodePane code={code[step]} step={step} stage={stage} />

            <div className="flex min-w-0 flex-col bg-surface-sunken">
              <PaneHeader>
                <span>Result</span>
                <button
                  type="button"
                  onClick={replay}
                  className="group/replay ms-auto -me-2 inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption-1-medium transition-colors hover:bg-background-secondary-default hover:text-text-primary"
                >
                  <RiRestartLine
                    className="size-3.5 transition-transform duration-500 group-hover/replay:-rotate-180"
                    aria-hidden
                  />
                  Replay
                </button>
              </PaneHeader>
              <div className="relative h-[25rem] overflow-hidden lg:h-auto lg:flex-1">
                <div
                  aria-hidden
                  className="grid-lines absolute inset-0 [background-size:28px_28px]"
                />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={`${step}:${run}`}
                    className="absolute inset-0 flex p-5"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: SWAP / 1000, ease }}
                  >
                    {step === 0 ? (
                      <ComposeScene stage={stage} modules={modules} />
                    ) : step === 1 ? (
                      <JoinScene stage={stage} />
                    ) : (
                      <ReserveScene stage={stage} />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        <StatusBar
          pillar={pillar}
          step={step}
          stage={stage}
          state={paused ? 'paused' : hovered ? 'held' : undefined}
          paused={paused}
          onToggle={toggle}
        />
      </motion.div>
    </div>
  );
}

/**
 * The pillars as steps. On wide screens they form a vertical rail of numbered nodes joined by a line that fills in as
 * the walkthrough moves along; narrower, they sit in a row of tabs. A ring around the active node shows its time.
 */
function PillarTabs({
  step,
  paused,
  onSelect,
}: {
  step: number;
  paused: boolean;
  onSelect: (index: number) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    const next = (step + (forward ? 1 : -1) + pillars.length) % pillars.length;
    onSelect(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="What Better Compute does"
      onKeyDown={onKeyDown}
      className="grid grid-cols-3 border-b border-separator-border xl:flex xl:flex-col xl:border-b-0 xl:py-2"
    >
      {pillars.map((pillar, index) => {
        const active = index === step;
        const done = index < step;
        const Icon = pillar.icon;
        return (
          <button
            key={pillar.label}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls="hero-panel"
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(index)}
            className={cx(
              'group relative flex min-w-0 items-start gap-3 px-3 py-3.5 text-start transition-colors duration-200 sm:px-4 xl:px-5',
              index > 0 && 'border-s border-separator-border xl:border-s-0',
              active
                ? 'bg-background-secondary-default/60'
                : 'hover:bg-background-secondary-default/40',
            )}
          >
            {/* Without the node (small screens), a line along the top shows the time left. */}
            {active ? (
              <motion.span
                key={`${step}-${paused}`}
                aria-hidden
                className="absolute inset-x-0 top-0 h-0.5 origin-left bg-text-primary sm:hidden"
                initial={{ scaleX: paused ? 1 : 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: paused ? 0 : INTERVAL / 1000, ease: 'linear' }}
              />
            ) : null}

            {/* The rail's line, in two halves around the node, ink once the walkthrough has passed it. */}
            {index > 0 ? (
              <span
                aria-hidden
                className={cx(
                  'absolute start-[calc(2.125rem-0.5px)] top-0 hidden h-2 w-px transition-colors duration-500 xl:block',
                  index <= step ? 'bg-text-primary' : 'bg-separator-border',
                )}
              />
            ) : null}
            {index < pillars.length - 1 ? (
              <span
                aria-hidden
                className={cx(
                  'absolute start-[calc(2.125rem-0.5px)] top-[3rem] bottom-0 hidden w-px transition-colors duration-500 xl:block',
                  index < step ? 'bg-text-primary' : 'bg-separator-border',
                )}
              />
            ) : null}

            <span className="relative hidden size-7 shrink-0 sm:block">
              <span
                className={cx(
                  'flex size-7 items-center justify-center rounded-full border font-mono text-caption-2-regular tabular-nums transition-colors duration-300',
                  active
                    ? 'border-text-primary bg-text-primary text-background-full'
                    : done
                      ? 'border-text-primary text-text-primary'
                      : 'border-border-button-hover text-text-tertiary group-hover:text-text-primary',
                )}
              >
                {done ? <RiCheckLine className="size-3.5" aria-hidden /> : `0${index + 1}`}
              </span>
              {active ? (
                <svg
                  aria-hidden
                  viewBox="0 0 36 36"
                  className="pointer-events-none absolute -inset-1 size-9 -rotate-90 text-text-primary"
                >
                  <motion.circle
                    key={`${step}-${paused}`}
                    cx="18"
                    cy="18"
                    r="17"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    initial={{ pathLength: paused ? 1 : 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: paused ? 0 : INTERVAL / 1000, ease: 'linear' }}
                  />
                </svg>
              ) : null}
            </span>

            <span className="flex min-w-0 flex-col gap-1 sm:pt-1">
              <span
                className={cx(
                  'flex items-center gap-2 text-body-medium transition-colors',
                  active
                    ? 'text-text-primary'
                    : 'text-text-secondary group-hover:text-text-primary',
                )}
              >
                <Icon className="hidden size-4 shrink-0 sm:block" aria-hidden />
                <span className="truncate">{pillar.label}</span>
              </span>
              <span
                className={cx(
                  'hidden text-caption-1-regular leading-[1.1rem] transition-colors duration-300 md:block',
                  active ? 'text-text-secondary' : 'text-text-tertiary',
                )}
              >
                {pillar.body}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The pillar's source with line numbers. A band slides to the lines the scene is running and the rest dim; pointing
 * at the code brings every line back.
 */
function CodePane({ code, step, stage }: { code: ReactNode; step: number; stage: number }) {
  const pillar = pillars[step]!;
  const [first, last] = pillar.lines[Math.min(stage, pillar.lines.length - 1)]!;
  const id = useId();
  const scope = `[data-hero-code="${id}"]`;

  return (
    <div className="flex min-w-0 flex-col border-b border-separator-border lg:border-e lg:border-b-0">
      <PaneHeader>
        <RiFileCodeLine className="size-3.5 shrink-0" aria-hidden />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={pillar.file}
            className="truncate font-mono"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            {pillar.file}
          </motion.span>
        </AnimatePresence>
        <span className="ms-auto hidden shrink-0 font-mono text-text-tertiary tabular-nums sm:inline">
          L{first}
          {last > first ? `–${last}` : ''}
        </span>
      </PaneHeader>
      <div className="relative h-[23.25rem]">
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bg-background-secondary-default"
          initial={false}
          animate={{
            top: `${PAD + (first - 1) * LINE}rem`,
            height: `${(last - first + 1) * LINE}rem`,
          }}
          transition={{ duration: 0.5, ease }}
        >
          <span className="absolute inset-y-0 start-0 w-0.5 bg-text-primary" />
        </motion.div>
        <div
          data-hero-code={id}
          data-lenis-prevent-horizontal
          className="hero-code home-code relative h-full overflow-x-auto px-4 py-4 font-mono text-[0.75rem] leading-5"
        >
          <style>{`${scope} .line:nth-child(n + ${first}):nth-child(-n + ${last}) { opacity: 1; }
${scope} .line:nth-child(n + ${first}):nth-child(-n + ${last})::before { color: var(--color-text-primary); }`}</style>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 16, filter: 'blur(4px)' }}
              animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, x: -16, filter: 'blur(4px)' }}
              transition={{ duration: 0.35, ease }}
            >
              {code}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** What the current pillar left behind, whether the walkthrough is running, held, or paused, and its play control. */
function StatusBar({
  pillar,
  step,
  stage,
  state,
  paused,
  onToggle,
}: {
  pillar: Pillar;
  step: number;
  stage: number;
  state?: 'paused' | 'held';
  paused: boolean;
  onToggle: () => void;
}) {
  const reached = stage >= pillar.event.at;
  return (
    <div className="flex h-10 items-center gap-3 border-t border-separator-border px-4 font-mono text-caption-1-regular">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={`${step}:${reached}`}
          className="flex min-w-0 items-center gap-2"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease }}
        >
          {reached ? (
            <>
              <Done />
              <span className="truncate">{pillar.event.action}</span>
              <span className="hidden truncate font-sans text-text-secondary sm:inline">
                {pillar.event.note}
              </span>
            </>
          ) : (
            <>
              <span
                aria-hidden
                className="size-4 shrink-0 rounded-full border border-dashed border-text-tertiary motion-safe:animate-spin"
              />
              <span className="truncate text-text-tertiary">running {pillar.file}</span>
            </>
          )}
        </motion.span>
      </AnimatePresence>
      <span className="ms-auto shrink-0 text-text-tertiary tabular-nums">
        {state ?? <span className="xl:hidden">{`0${step + 1} / 0${pillars.length}`}</span>}
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-label={paused ? 'Play the walkthrough' : 'Pause the walkthrough'}
        className="-me-2 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 font-sans text-caption-1-medium text-text-secondary transition-colors hover:bg-background-secondary-default hover:text-text-primary"
      >
        {paused ? (
          <RiPlayLine className="size-3.5" aria-hidden />
        ) : (
          <RiPauseLine className="size-3.5" aria-hidden />
        )}
        {paused ? 'Play' : 'Pause'}
      </button>
    </div>
  );
}

function PaneHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-separator-border px-4 text-caption-1-regular text-text-secondary">
      {children}
    </div>
  );
}

/**
 * Plays a scene's script from the top whenever `key` changes: how far along it is (0 to `stages`), or all the way
 * with reduced motion.
 */
function useScript({ stages, every, start }: Script, key: string) {
  const reduced = useReducedMotionSafe();
  const [progress, setProgress] = useState({ key, stage: 0 });
  useEffect(() => {
    if (reduced) {
      setProgress({ key, stage: stages });
      return;
    }
    setProgress({ key, stage: 0 });
    const timers = Array.from({ length: stages }, (_, index) =>
      setTimeout(() => setProgress({ key, stage: index + 1 }), SWAP + start + index * every),
    );
    return () => timers.forEach(clearTimeout);
  }, [reduced, stages, every, start, key]);
  // Until the effect catches up with a new key, the new script is at its start.
  if (progress.key === key) return progress.stage;
  return reduced ? stages : 0;
}

function Scene({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex h-full w-full max-w-md flex-col gap-3">{children}</div>;
}

function Done({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'flex size-4 shrink-0 items-center justify-center rounded-full bg-text-primary text-background-full',
        className,
      )}
    >
      <RiCheckLine className="size-3" aria-hidden />
    </span>
  );
}

/** A check that springs in once `on` turns true, over an empty ring. */
function Tick({ on }: { on: boolean }) {
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center rounded-full border border-border-button-hover">
      <AnimatePresence>
        {on ? (
          <motion.span
            className="absolute -inset-px"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 24 }}
          >
            <Done />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}

/**
 * Compose: the modules `betterCompute()` registers, built-ins first (the server's own groups, then the always-on
 * inventory and capacity modules), then the injected ones, then `initialize()`.
 */
function ComposeScene({ stage, modules }: { stage: number; modules: HeroModule[] }) {
  const total = modules.reduce((sum, module) => sum + module.methods, 0);
  return (
    <Scene>
      <div className="rounded-xl border border-border-button-default bg-background-primary-default shadow-xs">
        <p className="flex items-center gap-2 border-b border-separator-border px-4 py-2.5 font-mono text-caption-1-regular text-text-secondary">
          betterCompute()
          <span className="ms-auto font-sans">registered modules</span>
        </p>
        <ul className="flex flex-col py-1">
          {modules.map((module) => {
            const shown = module.kind === 'built in' ? stage >= 1 : stage >= 2;
            return (
              <motion.li
                key={module.name}
                className="flex items-center gap-2.5 px-4 py-1.5"
                initial={false}
                animate={{ opacity: shown ? 1 : 0.25, x: shown ? 0 : 6 }}
                transition={{ duration: 0.4, ease }}
              >
                <Tick on={shown} />
                <span className="w-[4.5rem] shrink-0 font-mono text-caption-1-regular">
                  {module.name}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-caption-2-regular text-text-tertiary">
                  {module.groups.join(' · ')}
                </span>
                <Chip
                  variant="caption"
                  color={module.kind === 'built in' ? 'soft' : 'gray'}
                  className="shrink-0 px-1.5 py-0 font-sans"
                >
                  {module.kind}
                </Chip>
              </motion.li>
            );
          })}
        </ul>
      </div>
      <AnimatePresence>
        {stage >= 3 ? (
          <motion.div
            className="mt-auto flex items-center gap-3 rounded-xl bg-text-primary px-4 py-3 text-background-full"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease }}
          >
            <RiShieldCheckLine className="size-5 shrink-0" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="text-body-semibold">Initialized</span>
              <span className="truncate font-mono text-caption-2-regular opacity-70">
                {total} methods · POST /api/compute/{'{group}'}/{'{method}'}
              </span>
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Scene>
  );
}

/** Join (PLAN.md §3.3): token, sealed Join call, certificate, session and inventory, then acceptance and adoption. */
function JoinScene({ stage }: { stage: number }) {
  const steps: { title: string; detail: string }[] = [
    { title: 'Join token minted', detail: 'bcjt_… · 1 use · expires in 1 h' },
    { title: 'Join: sealed token and CSR', detail: 'the gateway relays, JoinService admits' },
    { title: 'Certificate issued', detail: 'spiffe://…/site/site_…/node/node_… · 24 h' },
    { title: 'Session and inventory', detail: 'Hello → Welcome · 8 × H100-SXM5-80GB' },
  ];
  return (
    <Scene>
      <div className="rounded-xl border border-border-button-default bg-background-primary-default p-4 shadow-xs">
        <p className="flex items-center gap-2">
          <RiServerLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="text-headline-semibold">rack-7-node-3</span>
          <span className="ms-auto font-mono text-caption-1-regular text-text-secondary">
            {stage >= 4 ? 'adopted' : stage >= 1 ? 'adopting' : 'not joined'}
          </span>
        </p>
        <ol className="mt-3 flex flex-col gap-2.5 border-t border-separator-border pt-3">
          {steps.map((step, index) => (
            <li key={step.title} className="flex items-start gap-2.5">
              <span className="mt-0.5">
                <Tick on={stage > index} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className={cx(
                    'text-body-2-regular transition-colors',
                    stage > index ? '' : 'text-text-tertiary',
                  )}
                >
                  {step.title}
                </span>
                <span
                  className={cx(
                    'truncate font-mono text-caption-2-regular transition-colors',
                    stage > index ? 'text-text-secondary' : 'text-text-tertiary/60',
                  )}
                >
                  {step.detail}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <AnimatePresence>
        {stage >= 4 ? (
          <motion.div
            className="flex items-center gap-3 rounded-xl bg-text-primary px-4 py-3 text-background-full"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26 }}
          >
            <RiShieldCheckLine className="size-5 shrink-0" aria-hidden />
            <span className="text-body-semibold">Adopted</span>
            <span className="ms-auto font-mono text-caption-2-regular opacity-70">
              diag.nvml passed
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Scene>
  );
}

const reservationStates = ['draft', 'placed', 'binding', 'active'] as const;
/** Four GPU UUIDs, shortened, as `binding.cdiDevices` names them (`bcd.dev/gpu=<uuid>`). */
const cdiDevices = ['GPU-3f1c…', 'GPU-8a07…', 'GPU-c2d9…', 'GPU-51be…'];

/** Reserve (PLAN.md §3.4): the draft, one IAM decision, placement on one NVLink set, then the node's binding. */
function ReserveScene({ stage }: { stage: number }) {
  const state = stage >= 3 ? 3 : stage >= 2 ? 1 : 0;
  return (
    <Scene>
      <div className="rounded-xl border border-border-button-default bg-background-primary-default p-4 shadow-xs">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-caption-1-regular leading-5">
          <dt className="text-text-secondary">action</dt>
          <dd className="truncate">compute:reservations:create</dd>
          <dt className="text-text-secondary">resource</dt>
          <dd className="truncate">compute-reservation/rsv_…</dd>
          <dt className="text-text-secondary">request</dt>
          <dd className="truncate">4 × gpu · nvlink-all · 8 h</dd>
        </dl>
        <div className="mt-3 flex items-center gap-1.5 border-t border-separator-border pt-3">
          {reservationStates.map((name, index) => (
            <span key={name} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span
                  aria-hidden
                  className={cx(
                    'h-px w-2.5 transition-colors duration-300',
                    index <= state ? 'bg-text-primary' : 'bg-separator-border',
                  )}
                />
              ) : null}
              <span
                className={cx(
                  'rounded-md px-1.5 py-0.5 font-mono text-caption-2-regular transition-colors duration-300',
                  index === state
                    ? 'bg-text-primary text-background-full'
                    : index < state
                      ? 'text-text-primary'
                      : 'text-text-tertiary',
                )}
              >
                {name}
              </span>
            </span>
          ))}
          <AnimatePresence>
            {stage >= 1 ? (
              <motion.span
                className="ms-auto inline-flex items-center gap-1 text-caption-1-medium"
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, ease }}
              >
                <RiShieldCheckLine className="size-3.5" aria-hidden />
                allowed
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div className="rounded-xl border border-border-button-default bg-background-primary-default px-4 py-3 shadow-xs">
        <p className="flex items-center gap-2 text-caption-1-regular text-text-secondary">
          <span className="font-mono">node_…</span>
          <span className="ms-auto">8 × H100-SXM5-80GB</span>
        </p>
        <div className="mt-2 grid grid-cols-8 gap-1">
          {Array.from({ length: 8 }, (_, gpu) => {
            const booked = gpu < 4 && stage >= 2;
            return (
              <motion.span
                key={gpu}
                className={cx(
                  'flex h-7 items-center justify-center rounded-md border font-mono text-caption-2-regular transition-colors duration-300',
                  booked
                    ? 'border-text-primary bg-text-primary text-background-full'
                    : 'border-border-button-default text-text-tertiary',
                )}
                initial={false}
                animate={booked ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                transition={{ duration: 0.35, delay: booked ? gpu * 0.06 : 0 }}
              >
                {gpu}
              </motion.span>
            );
          })}
        </div>
        <p className="mt-1.5 font-mono text-caption-2-regular text-text-tertiary">
          {stage >= 2 ? 'booked: GPUs 0–3, one NVLink set' : 'free: 8 of 8'}
        </p>
      </div>

      <AnimatePresence>
        {stage >= 3 ? (
          <motion.div
            className="mt-auto flex flex-col gap-1.5 rounded-xl bg-text-primary px-4 py-3 text-background-full"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease }}
          >
            <span className="flex items-center gap-2">
              <RiShieldCheckLine className="size-4 shrink-0" aria-hidden />
              <span className="text-body-semibold">Active</span>
              <span className="ms-auto font-mono text-caption-2-regular opacity-70">
                binding.cdiDevices
              </span>
            </span>
            <motion.span
              className="flex flex-wrap gap-1"
              initial={false}
              animate={{ opacity: stage >= 4 ? 1 : 0.35 }}
              transition={{ duration: 0.3 }}
            >
              {cdiDevices.map((device) => (
                <span
                  key={device}
                  className="rounded bg-background-full/15 px-1.5 py-0.5 font-mono text-caption-2-regular"
                >
                  bcd.dev/gpu={device}
                </span>
              ))}
            </motion.span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Scene>
  );
}
