'use client';

import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RiCheckLine, RiFileCodeLine, RiPauseLine, RiPlayLine } from 'react-icons/ri';
import { Chip } from '@/components/base/badges/chip';
import { cx } from '@/utils/cx';
import { ease, useStepper } from './motion';

/**
 * A machine's lifecycle as one compact frame that plays by itself: a timeline of stages, hatched where the node's
 * daemon does the work and solid where the control plane does, and a horizontal track of stage panels that slides to
 * the stage in progress while the CLI calls beside it light the lines that stage runs. Readers can pick a stage
 * (which pauses the autoplay) or pause it outright. The wording follows PLAN.md §3.3 (join) and §3.4 (reserve) and
 * what the capacity, inventory, and iam packages implement.
 */
const INTERVAL = 4200;

type Stage = {
  label: string;
  title: string;
  body: ReactNode;
  detail: ReactNode;
  note?: string;
  /** This stage's share of the timeline, in percent. */
  bar: [number, number];
  /** Work the daemon on the machine does (hatched on the timeline). */
  onNode?: boolean;
  /** The 1-based lines of the CLI session (pipeline.tsx) this stage runs. */
  lines: [first: number, last: number];
};

const stages: Stage[] = [
  {
    label: 'Join',
    title: 'Join with a sealed token',
    detail: (
      <>
        <code>
          Join{'{'}sealed_token, csr, claims{'}'}
        </code>{' '}
        becomes a 24-hour SPIFFE certificate.
      </>
    ),
    body: 'The join token is encrypted to the JoinService key and bound to the machine’s CSR, so the gateway relaying it can neither read nor replay it. JoinService admits it in one transaction and signs the certificate the node’s Session stream presents. Until bcd is released, better-compute dev --sim joins simulated machines the same way.',
    note: 'ACCESS_DENIED, whatever the reason',
    bar: [0, 14],
    onNode: true,
    lines: [1, 2],
  },
  {
    label: 'Inventory',
    title: 'Report inventory, pass acceptance',
    detail: (
      <>
        8 × <code>H100-SXM5-80GB</code> become bookable GPU atoms, and <code>diag.nvml</code>{' '}
        passes.
      </>
    ),
    body: 'The daemon reports hashed inventory sections and the gateway pulls only those that changed. The inventory reconciler turns GPUs into bookable atoms with labels such as gpu.model and fabric.domain. Then the pool’s acceptance runs, and a node that passes is adopted.',
    note: 'a condition and NoSchedule',
    bar: [14, 28],
    onNode: true,
    lines: [4, 5],
  },
  {
    label: 'Pool',
    title: 'Schedulable in a pool',
    detail: 'Adopted, connected, not cordoned, and no NoSchedule reason: its GPUs count.',
    body: 'A pool is one site, one GPU model, and one sharing mode. Its owner offers it to other tenants with a quota and a priority, and the pool’s capacity rollup is updated in the same transaction as every booking, so reads never add up devices.',
    bar: [28, 38],
    lines: [7, 9],
  },
  {
    label: 'Reserve',
    title: 'Reserve under one IAM decision',
    detail: (
      <>
        <code>compute:reservations:create</code> on the draft <code>rsv_…</code> is allowed.
      </>
    ),
    body: 'The request becomes a draft whose id derives from the tenant, the caller, and the idempotency key. Better IAM decides on it once. Then quota is charged and the placer books GPU atoms, whose bookings an EXCLUDE constraint keeps from ever overlapping.',
    note: 'QUOTA_EXCEEDED · 409',
    bar: [38, 56],
    lines: [11, 12],
  },
  {
    label: 'Bind',
    title: 'Bind as CDI devices',
    detail: (
      <>
        <code>
          binding: {'{'} nodeId, cdiDevices, envFile {'}'}
        </code>
        , and the state is <code>active</code>.
      </>
    ),
    body: 'The node’s desired state gains the device assignments under a new generation. The daemon writes a CDI spec and an env file for the workload manager you run there, such as Slurm, Kubernetes, or containerd, and reports a signed AllocationBound.',
    note: 'bind timeout: re-placed twice, then failed',
    bar: [56, 72],
    onNode: true,
    lines: [14, 15],
  },
  {
    label: 'Meter',
    title: 'Meter the reserved time',
    detail: (
      <>
        <code>gpu.H100.hours</code>, from <code>active</code> to the release, in hourly windows.
      </>
    ),
    body: 'The capacity.usage reconciler writes final hourly usage windows, keyed by allocation and window start so a retry never bills twice. The IAM bridge records them in Better IAM’s billing ledger; work an agent does on someone’s behalf bills that person and names the agent.',
    bar: [72, 88],
    lines: [17, 17],
  },
  {
    label: 'Release',
    title: 'Release and refund',
    detail: 'Bookings truncated at compute_now(), quota refunded, GPUs back in the pool.',
    body: 'A release, the booked end, or a lapsed lease ends the reservation. The current booking is truncated, future ones are deleted, and past ones are kept. The node’s desired state drops the assignment, and pending reservations in the pool are woken to try again.',
    bar: [88, 100],
    lines: [18, 19],
  },
];

/** Where the machine's side ends and the reservation's begins, as a share of the timeline. */
const SCHEDULABLE = stages[2]!.bar[1];

export function PipelineCarousel({ code }: { code: ReactNode }) {
  const { ref, step, select, toggle, paused, hovered, setHovered } = useStepper(stages.length, {
    interval: INTERVAL,
    hold: INTERVAL + 1800,
  });
  const complete = step === stages.length - 1;
  const [first, last] = stages[step]!.lines;
  const id = useId();
  const scope = `[data-pipeline-code="${id}"]`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (step + delta + stages.length) % stages.length;
    select(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div
      ref={ref}
      className="border-t border-separator-border"
      onPointerEnter={(event) => event.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* Timeline */}
      <div className="px-5 pt-6 pb-5 sm:px-8 lg:px-12">
        <div className="mb-7 flex flex-wrap items-center gap-3">
          <span className="eyebrow">Trace · one machine, one reservation</span>
          <AnimatePresence mode="wait" initial={false}>
            {complete ? (
              <motion.span
                key="done"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease }}
                className="inline-flex items-center gap-1.5 rounded-full bg-text-primary px-2.5 py-0.5 text-caption-1-medium text-background-full"
              >
                <RiCheckLine className="size-3.5" aria-hidden /> Released · quota refunded
              </motion.span>
            ) : (
              <motion.span
                key={paused ? 'paused' : hovered ? 'held' : 'running'}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="inline-flex items-center gap-1.5 rounded-full bg-background-secondary-default px-2.5 py-0.5 text-caption-1-medium text-text-secondary"
              >
                {paused ? (
                  'Paused'
                ) : hovered ? (
                  'Held while you read'
                ) : (
                  <>
                    <span className="live-dot" /> Running
                  </>
                )}
              </motion.span>
            )}
          </AnimatePresence>
          <span className="hidden items-center gap-3 text-caption-1-regular text-text-tertiary md:inline-flex">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="trace-bar-after h-2 w-4 rounded-full" /> on the node
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2 w-4 rounded-full bg-text-primary" /> control plane
            </span>
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-label={paused ? 'Play the lifecycle' : 'Pause the lifecycle'}
            className="ms-auto inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-secondary-default hover:text-text-primary"
          >
            {paused ? <RiPlayLine className="size-3.5" /> : <RiPauseLine className="size-3.5" />}
            {paused ? 'Play' : 'Pause'}
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Lifecycle stages"
          onKeyDown={onKeyDown}
          className="relative flex gap-1.5"
        >
          {stages.map((stage, index) => {
            const state = index < step ? 'done' : index === step ? 'active' : 'pending';
            return (
              <button
                key={stage.label}
                type="button"
                role="tab"
                aria-selected={index === step}
                aria-controls="pipeline-panel"
                tabIndex={index === step ? 0 : -1}
                onClick={() => select(index)}
                style={{ ['--w' as string]: stage.bar[1] - stage.bar[0] }}
                className="group flex min-w-0 flex-1 cursor-pointer flex-col gap-2 text-start sm:grow-[var(--w)]"
              >
                <span className="relative block h-2 overflow-hidden rounded-full bg-background-tertiary-default transition-[height,margin] duration-200 group-hover:-my-0.5 group-hover:h-3">
                  <motion.span
                    key={state === 'active' ? `${step}-${paused}-${hovered}` : state}
                    className={cx(
                      'absolute inset-0 origin-left rounded-full',
                      stage.onNode ? 'trace-bar-after' : 'bg-text-primary',
                    )}
                    initial={{
                      scaleX: state === 'done' || (state === 'active' && hovered) ? 1 : 0,
                    }}
                    animate={{ scaleX: state === 'pending' ? 0 : 1 }}
                    transition={
                      state === 'active' && !paused && !hovered
                        ? { duration: INTERVAL / 1000, ease: 'linear' }
                        : { duration: 0.3, ease }
                    }
                  />
                  {state === 'pending' ? (
                    <span className="absolute inset-0 origin-left scale-x-0 rounded-full bg-text-tertiary transition-transform duration-300 group-hover:scale-x-100" />
                  ) : null}
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span
                    className={cx(
                      'font-mono text-caption-2-regular tabular-nums',
                      state === 'pending' ? 'text-text-tertiary' : 'text-text-primary',
                    )}
                  >
                    0{index + 1}
                  </span>
                  <span
                    className={cx(
                      'hidden truncate text-caption-1-medium transition-colors md:inline',
                      state === 'active'
                        ? 'text-text-primary'
                        : 'text-text-secondary group-hover:text-text-primary',
                    )}
                  >
                    {stage.label}
                  </span>
                </span>
              </button>
            );
          })}
          {/* Left of this line the machine becomes schedulable; right of it, a reservation uses it. */}
          <span
            aria-hidden
            className="pointer-events-none absolute -top-3 hidden h-8 border-s border-dashed border-text-tertiary sm:block"
            // Segments grow with their share; six 6px gaps shift the boundary after the third by 4.3px.
            style={{ left: `calc(${SCHEDULABLE}% + 4.3px)` }}
          >
            <span className="absolute -top-4 -translate-x-1/2 font-mono text-caption-2-regular whitespace-nowrap text-text-tertiary">
              schedulable
            </span>
          </span>
        </div>
      </div>

      {/* CLI calls beside the sliding stage panels */}
      <div className="grid border-t border-separator-border lg:grid-cols-12">
        <div className="flex min-w-0 flex-col border-b border-separator-border lg:col-span-5 lg:border-e lg:border-b-0">
          <div className="flex h-10 items-center gap-2 border-b border-separator-border px-5 text-caption-1-regular text-text-secondary sm:px-8 lg:ps-12 lg:pe-5">
            <RiFileCodeLine className="size-3.5" aria-hidden />
            <span className="font-mono">terminal</span>
            <span className="ms-auto font-mono text-text-tertiary tabular-nums">
              L{first}
              {last > first ? `–${last}` : ''}
            </span>
          </div>
          <div
            data-lenis-prevent-horizontal
            data-pipeline-code={id}
            className="pipeline-code home-code overflow-x-auto px-5 py-5 font-mono text-[0.78rem] leading-[1.35rem] sm:px-8 lg:ps-12 lg:pe-5"
          >
            <style>{`${scope} .line { opacity: 0.35; }
${scope} .line:nth-child(n + ${first}):nth-child(-n + ${last}) { opacity: 1; }
@media (prefers-reduced-motion: reduce) { ${scope} .line { opacity: 1; } }`}</style>
            {code}
          </div>
          <p className="mt-auto border-t border-separator-border px-5 py-3 text-caption-1-regular leading-5 text-text-secondary sm:px-8 lg:ps-12 lg:pe-5">
            The CLI calls the same POST /api/compute routes as the typed client and the MCP tools.
          </p>
        </div>

        <div
          id="pipeline-panel"
          role="tabpanel"
          aria-label={stages[step]!.title}
          className="relative min-w-0 overflow-hidden py-6 lg:col-span-7 lg:py-8"
        >
          <div className="ps-5 sm:ps-8">
            <motion.ol
              className="flex"
              initial={false}
              animate={{ x: `-${step * 84}%` }}
              transition={{ duration: 0.7, ease }}
            >
              {stages.map((stage, index) => {
                const current = index === step;
                return (
                  <li key={stage.label} className="w-[84%] shrink-0 pe-4" aria-hidden={!current}>
                    <motion.button
                      type="button"
                      tabIndex={-1}
                      onClick={() => select(index)}
                      className={cx(
                        'flex h-full w-full flex-col gap-3 rounded-2xl border p-5 text-start transition-[border-color,box-shadow] duration-300 sm:p-6',
                        current
                          ? 'cursor-default border-border-button-default bg-surface-raised shadow-sm hover:border-border-button-hover hover:shadow-md'
                          : 'cursor-pointer border-separator-border bg-transparent hover:border-border-button-hover',
                      )}
                      animate={{ opacity: current ? 1 : 0.4, scale: current ? 1 : 0.97 }}
                      // The next stage peeks in from the right; pointing at it brings it forward.
                      whileHover={current ? { y: -3 } : { opacity: 0.75, scale: 0.985 }}
                      whileTap={current ? undefined : { scale: 0.97 }}
                      transition={{ duration: 0.5, ease }}
                    >
                      <span className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-full bg-text-primary font-mono text-caption-2-semibold text-background-full tabular-nums">
                          {index + 1}
                        </span>
                        <span className="eyebrow">{stage.label}</span>
                        <Chip variant="caption" color="soft" className="ms-auto">
                          {stage.onNode ? 'on the node' : 'control plane'}
                        </Chip>
                      </span>
                      <span className="text-title-2-semibold tracking-[-0.015em]">
                        {stage.title}
                      </span>
                      <motion.span
                        key={current ? `detail-${step}` : 'detail'}
                        className="rounded-lg border border-dashed border-border-button-default px-3 py-2 text-body-2-regular text-text-primary [&_code]:font-mono [&_code]:text-caption-1-regular"
                        initial={current ? { opacity: 0, x: 12 } : false}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.5, ease, delay: 0.25 }}
                      >
                        {stage.detail}
                      </motion.span>
                      <span className="text-body-regular leading-6 text-text-secondary">
                        {stage.body}
                      </span>
                      {stage.note ? (
                        <span className="mt-auto w-fit rounded-md border border-border-button-default bg-background-secondary-default px-2 py-0.5 font-mono text-caption-2-regular text-text-secondary">
                          on failure: {stage.note}
                        </span>
                      ) : null}
                    </motion.button>
                  </li>
                );
              })}
            </motion.ol>
          </div>
        </div>
      </div>
    </div>
  );
}
