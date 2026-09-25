import { RiArrowRightLine } from 'react-icons/ri';
import { ActionLink } from '@/components/site/action';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { cx } from '@/utils/cx';

/**
 * The quickstart as a terminal session. Commands and output lines are the ones in
 * content/docs/guides/quickstart.mdx (pinned pnpm, the CLI alias, `dev --memory --sim 8`, `reserve`), trimmed.
 */
const session: { kind: 'comment' | 'command' | 'output'; text: string }[] = [
  { kind: 'comment', text: '# 1. Build from a clone (nothing is on npm yet)' },
  { kind: 'command', text: 'git clone https://github.com/better-compute/better-compute.git' },
  { kind: 'command', text: 'cd better-compute && npx pnpm@11.19.0 install' },
  { kind: 'command', text: 'node node_modules/pnpm/bin/pnpm.mjs build' },
  { kind: 'command', text: `alias better-compute="node '$PWD/packages/cli/dist/index.js'"` },
  { kind: 'comment', text: '# 2. A control plane with eight simulated H100 machines' },
  { kind: 'command', text: 'cd examples/dev && better-compute dev --memory --sim 8' },
  { kind: 'output', text: 'better-compute listening on http://127.0.0.1:3000/api/compute' },
  { kind: 'output', text: 'Workers running: controllers, scheduler, sinks, iam' },
  { kind: 'output', text: '8 simulated node(s) adopted' },
  { kind: 'comment', text: '# 3. Book four GPUs for an hour' },
  { kind: 'command', text: 'better-compute reserve --pool $POOL --gpus 4 --for 1h' },
  { kind: 'command', text: 'better-compute reservations get rsv_… --query state' },
  { kind: 'output', text: 'active' },
];

export function QuickstartTerminal() {
  return (
    <Band id="quickstart" unit="06">
      <div className={cx('grid grid-cols-1 gap-10 py-16 md:py-20 lg:grid-cols-12', gutter)}>
        <div className="flex flex-col gap-6 lg:col-span-4">
          <SectionHeading index="06" eyebrow="Quickstart" title="From a clone to a booked GPU">
            PGlite in memory, an embedded Better IAM, and simulated machines that join through a real
            gateway: the whole control plane on your laptop. Add --sim-variant cpu for machines without
            GPUs.
          </SectionHeading>
          <div className="flex flex-wrap gap-2.5">
            <ActionLink href="/docs/guides/quickstart" trailingIcon={RiArrowRightLine}>
              Full quickstart
            </ActionLink>
            <ActionLink href="/docs/operations/local-development" variant="secondary">
              Local development
            </ActionLink>
          </div>
        </div>

        <div className="min-w-0 border border-border-button-default bg-neutral-950 text-neutral-200 shadow-lg lg:col-span-8">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2 font-mono text-[0.6875rem] tracking-[0.06em] text-neutral-500 uppercase">
            <span className="led" data-on="true" />
            tty · better-compute
          </div>
          <pre className="scanlines overflow-x-auto px-4 py-4 font-mono text-[0.8125rem] leading-6">
            {session.map((line, index) => (
              <div key={index} className="whitespace-pre">
                {line.kind === 'command' ? (
                  <>
                    <span className="text-signal-400">$ </span>
                    <span className="text-neutral-50">{line.text}</span>
                  </>
                ) : line.kind === 'comment' ? (
                  <span className={cx('text-neutral-500', index > 0 && 'mt-3 inline-block')}>
                    {line.text}
                  </span>
                ) : (
                  <span className="text-neutral-400">{line.text}</span>
                )}
              </div>
            ))}
            <div>
              <span className="text-signal-400">$ </span>
              <span className="caret inline-block h-4 w-2 translate-y-0.5 bg-signal-500" />
            </div>
          </pre>
        </div>
      </div>
    </Band>
  );
}
