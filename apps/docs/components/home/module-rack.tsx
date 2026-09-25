import Link from 'next/link';
import modulesData from '@/generated/modules.json';
import { Band, SectionHeading, gutter } from '@/components/site/frame';
import { stats } from '@/lib/stats';
import { cx } from '@/utils/cx';

/**
 * The modules as units in a rack, straight from the generated registry (generated/modules.json, written by
 * scripts/generate.mjs from a control plane with every module registered): each unit's API groups and migration
 * count. The server registers the built-in ones itself; the rest are injected through `modules`. The sandboxes unit
 * is decided (PLAN.md D24) but not built, so its LED is dark.
 */
const builtIn = new Set(['node-controllers', 'site-boot', 'inventory', 'capacity', 'pki']);

const docs: Record<string, string> = {
  'node-controllers': '/docs/guides/nodes/operating-nodes',
  'site-boot': '/docs/guides/bare-metal/sites',
  inventory: '/docs/guides/nodes/inventory-and-health',
  capacity: '/docs/guides/capacity',
  pki: '/docs/operations/pki',
  provision: '/docs/guides/bare-metal/workflows',
  metal: '/docs/guides/bare-metal',
  vps: '/docs/guides/vps',
  events: '/docs/guides/events',
  fleet: '/docs/guides/fleet-config',
  rollout: '/docs/guides/rollouts',
  audit: '/docs/guides/events/audit',
};

export function ModuleRack() {
  const units = modulesData.modules.map((module) => ({
    name: module.name,
    groups: module.groups,
    migrations: module.migrations.length,
    kind: builtIn.has(module.name) ? 'built in' : 'injected',
    href: docs[module.name] ?? '/docs/reference/modules',
    planned: false,
  }));
  units.push({
    name: 'sandboxes',
    groups: [],
    migrations: 0,
    kind: 'planned · D24',
    href: '/docs/guides/vps/sandboxes',
    planned: true,
  });

  return (
    <Band id="modules" unit="05" frameClassName="bg-surface-sunken">
      <div className={cx('grid grid-cols-1 gap-10 py-16 md:py-20 lg:grid-cols-12', gutter)}>
        <div className="flex flex-col gap-6 lg:col-span-4">
          <SectionHeading index="05" eyebrow="Modules" title="Rack only what you run">
            One betterCompute() instance, and the modules you pass it. Each module brings its own API
            groups, tables and reconcilers, and the typed client only grows the groups you registered.
          </SectionHeading>
          <dl className="grid grid-cols-2 gap-px border border-separator-border bg-separator-border font-mono">
            {[
              ['Modules', stats.modules],
              ['API groups', stats.groups],
              ['Jobs', stats.jobs],
              ['Packages', stats.packages],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5 bg-background-full px-3 py-2.5">
                <dt className="text-[0.6875rem] tracking-[0.06em] text-text-tertiary uppercase">
                  {label}
                </dt>
                <dd className="text-headline-medium text-text-primary tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <ol className="flex min-w-0 flex-col border border-border-button-default bg-surface-raised lg:col-span-8">
          {units.map((unit, index) => (
            <li
              key={unit.name}
              className={cx(
                'border-separator-border',
                index > 0 && 'border-t',
                unit.planned && 'border-dashed',
              )}
            >
              <Link
                href={unit.href}
                className="group grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-background-secondary-default sm:grid-cols-[2.75rem_9.5rem_minmax(0,1fr)_auto]"
              >
                <span className="font-mono text-[0.6875rem] text-text-tertiary">
                  U{String(index + 1).padStart(2, '0')}
                </span>
                <span className="flex items-center gap-2.5 font-mono text-body-2-medium text-text-primary group-hover:text-signal">
                  <span className="led" data-on={!unit.planned} />
                  {unit.name}
                </span>
                <span className="hidden min-w-0 truncate font-mono text-caption-1-regular text-text-secondary sm:block">
                  {unit.groups.length ? unit.groups.join(' · ') : unit.planned ? 'templates · TTL · snapshots · warm pools' : 'no API group'}
                </span>
                <span className="text-end font-mono text-[0.6875rem] tracking-[0.04em] text-text-tertiary uppercase">
                  {unit.kind}
                  {unit.migrations ? ` · ${unit.migrations} mig` : ''}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </Band>
  );
}
