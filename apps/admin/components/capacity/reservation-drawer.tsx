'use client';

import { EntityLink } from '@/components/shell/peek';
import { useMemo } from 'react';
import { RiAddLine, RiArrowDownSLine, RiCloseCircleLine, RiFileCopyLine, RiStopCircleLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { Drawer, Menu } from '@/components/ui/overlay';
import { KeyValue } from '@/components/ui/panel';
import { Mono, SeverityIcon, Tag } from '@/components/ui/signal';
import { fmtDuration, fmtMoney, fmtNum, fmtRelative, fmtStamp } from '@/lib/data/format';
import { HOUR, reservationGpus, type Reservation, type ReservationState } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { useCapacity, useCapacityActions, useTenantName } from './data';
import { reservationSpend, stateStyle } from './model';
import { StateTag } from './ui';

// One reservation, everything about it, and what an operator can do to it. Destructive actions confirm inline
// (a second press), never in a modal on top of a modal.

const PATH: ReservationState[] = ['pending', 'placed', 'binding', 'active', 'releasing', 'released'];

function Lifecycle({ reservation, now }: { reservation: Reservation; now: number }) {
  const terminal = ['failed', 'cancelled', 'expired', 'denied'].includes(reservation.state);
  const reached = terminal ? -1 : PATH.indexOf(reservation.state === 'awaiting-confirmation' ? 'pending' : reservation.state);
  const during = reservation.during;
  // Only times the API tells us: the window's start and end (placement time is not returned).
  const when: Partial<Record<ReservationState, number | undefined>> = {
    binding: during?.start,
    active: during ? during.start + 2 * 60_000 : undefined,
    releasing: during?.end,
    released: during?.end,
  };
  return (
    <ol className="flex flex-col">
      {PATH.map((state, index) => {
        const done = !terminal && index <= reached;
        const current = !terminal && index === reached;
        const t = when[state];
        return (
          <li key={state} className="grid grid-cols-[16px_1fr_auto] items-start gap-x-3">
            <span className="flex h-full flex-col items-center">
              <span
                className={cx(
                  'mt-1 size-2.5 shrink-0 rounded-full border',
                  current ? 'border-signal-fill bg-signal-fill shadow-[0_0_0_3px_var(--color-signal-soft)]' : done ? 'border-text-secondary bg-text-secondary' : 'border-separator-border-strong',
                )}
              />
              {index < PATH.length - 1 && <span className={cx('w-px flex-1', done && index < reached ? 'bg-text-secondary' : 'bg-separator-border')} style={{ minHeight: 18 }} />}
            </span>
            <span className={cx('pb-3 font-mono text-[12px]', current ? 'text-text-primary' : done ? 'text-text-secondary' : 'text-text-tertiary')}>{stateStyle[state].label}</span>
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">
              {t !== undefined && (done || t > now) ? `${fmtStamp(t)}${t > now ? ` · ${fmtRelative(t, now)}` : ''}` : ''}
            </span>
          </li>
        );
      })}
      {terminal && (
        <li className="mt-1 flex items-center gap-2">
          <StateTag state={reservation.state} />
          <span className="text-caption-1-regular text-text-secondary">ended outside the normal path</span>
        </li>
      )}
    </ol>
  );
}

export function ReservationDrawer({ reservation, onClose }: { reservation?: Reservation; onClose(): void }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const actions = useCapacityActions();
  // Follow the reservation through mutations: re-read it from the snapshot by id.
  const current = useMemo(
    () => (reservation ? snapshot.reservations.find((entry) => entry.id === reservation.id) ?? reservation : undefined),
    [snapshot, reservation],
  );
  const spend = useMemo(() => (current ? reservationSpend(current, snapshot.usage, snapshot.prices) : 0), [current, snapshot]);
  if (!current) return null;

  const r = current;
  const gpus = reservationGpus(r);
  const perNode = r.request.devices[0]?.class === 'node' ? 'whole node' : `${r.request.devices[0]?.count ?? 0} per node`;
  const owner = snapshot.identities.find((identity) => identity.id === r.ownerIdentityId);
  const live = r.state === 'active' || r.state === 'binding' || r.state === 'releasing';
  const cancellable = r.state === 'placed' || r.state === 'pending' || r.state === 'awaiting-confirmation';
  const progress = r.during ? Math.min(1, Math.max(0, (snapshot.now - r.during.start) / (r.during.end - r.during.start))) : 0;
  const cli = `better-compute reservations get ${r.id} --tenant ${r.tenantId}`;

  return (
    <Drawer
      open={Boolean(reservation)}
      onOpenChange={(open) => {
        if (!open) {
          actions.reset();
          onClose();
        }
      }}
      title={
        <span className="flex items-center gap-2">
          {r.id} <StateTag state={r.state} />
        </span>
      }
      subtitle={`${tenantName(r.tenantId)} · ${r.poolId}${r.projectId ? ` · ${r.projectId}` : ''}`}
      width={600}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          {live && (
            <>
              <Menu
                label="Extend"
                trigger={
                  <Button variant="secondary" size="small" leadingIcon={RiAddLine} trailingIcon={RiArrowDownSLine} disabled={actions.state.busy || !actions.live}>
                    Extend
                  </Button>
                }
                items={[1, 6, 24, 72].map((hours) => ({
                  id: String(hours),
                  label: `+${hours} h (until ${fmtStamp((r.during?.end ?? snapshot.now) + hours * HOUR)})`,
                  onAction: () => void actions.extend(r.id, hours * HOUR),
                }))}
              />
              <Button variant="secondary" size="small" leadingIcon={RiStopCircleLine} disabled={actions.state.busy || !actions.live} onClick={() => void actions.release(r.id, gpus)}>
                Release
              </Button>
            </>
          )}
          {cancellable && (
            <Button variant="secondary" size="small" leadingIcon={RiCloseCircleLine} disabled={actions.state.busy || !actions.live} onClick={() => void actions.cancel(r.id)}>
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="small"
            leadingIcon={RiFileCopyLine}
            onClick={() => void navigator.clipboard?.writeText(cli)}
            title={cli}
          >
            Copy CLI
          </Button>
          {!actions.live && (live || cancellable) && <Tag status="warn">viewing the past: read-only</Tag>}
        </div>
        {actions.state.error && (
          <p className="flex items-center gap-2 border border-red-500/40 bg-red-500/10 px-3 py-2 text-caption-1-regular text-text-error-primary">
            <SeverityIcon severity="critical" /> {actions.state.error}
          </p>
        )}
        {actions.state.done && !actions.state.error && <p className="font-mono text-[11px] text-text-secondary">✓ {actions.state.done}</p>}

        {r.during && (
          <section>
            <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11px] text-text-tertiary">
              <span>{fmtStamp(r.during.start)} UTC</span>
              <span>{fmtDuration(r.during.end - r.during.start)}</span>
              <span>{fmtStamp(r.during.end)} UTC</span>
            </div>
            <div className="h-2 bg-background-secondary-default">
              <div className={cx('h-full', live ? 'bg-signal-fill' : 'bg-text-tertiary/50')} style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-text-secondary">
              {snapshot.now < r.during.start
                ? `starts ${fmtRelative(r.during.start, snapshot.now)}`
                : snapshot.now < r.during.end && live
                  ? `${fmtDuration(r.during.end - snapshot.now)} left`
                  : `ended ${fmtRelative(r.during.end, snapshot.now)}`}
              {r.leaseExpiresAt && ` · lease renews by ${fmtStamp(r.leaseExpiresAt)}`}
            </p>
          </section>
        )}

        <KeyValue
          columns={2}
          items={[
            { label: 'GPUs', value: `${fmtNum(gpus)} (${perNode}${r.request.gang ? ` × ${r.request.gang.size} nodes` : ''})`, mono: true },
            { label: 'Binding', value: r.request.binding ?? 'hold', mono: true },
            { label: 'Topology', value: r.request.topology ?? 'any', mono: true },
            { label: 'Market', value: r.request.spot ? 'spot (preemptible)' : 'on-demand' },
            { label: 'Owner', value: owner ? `${owner.name}${owner.agent ? ' (agent)' : ''}` : r.ownerIdentityId },
            { label: 'Spend so far', value: fmtMoney(spend, { cents: true }), mono: true },
            ...(r.request.hostShare
              ? [{ label: 'Host share', value: `${fmtNum(r.request.hostShare.vcpu ?? 0)} vCPU · ${fmtNum(r.request.hostShare.memoryGiB ?? 0)} GiB`, mono: true }]
              : []),
            ...(r.request.gang?.topologyKey ? [{ label: 'Gang key', value: r.request.gang.topologyKey, mono: true }] : []),
          ]}
        />

        <section>
          <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Lifecycle</h3>
          <Lifecycle reservation={r} now={snapshot.now} />
        </section>

        {r.conditions.length > 0 && (
          <section>
            <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Conditions</h3>
            <ul className="flex flex-col gap-2">
              {r.conditions.map((condition) => (
                <li key={condition.type} className="border border-separator-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <SeverityIcon severity={condition.type === 'Failed' ? 'critical' : 'warning'} />
                    <span className="font-mono text-[12px] text-text-primary">{condition.type}</span>
                    {condition.reason && <Tag status="ok" led={false}>{condition.reason}</Tag>}
                    <span className="ml-auto font-mono text-[10px] text-text-tertiary">{fmtRelative(condition.since, snapshot.now)}</span>
                  </div>
                  {condition.message && <p className="mt-1 text-caption-1-regular text-text-secondary">{condition.message}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(r.nodeIds?.length ?? 0) > 0 && (
          <section>
            <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Placement</h3>
            <ul className="flex flex-col gap-1.5">
              {r.nodeIds!.map((nodeId) => (
                <li key={nodeId} className="flex flex-wrap items-center gap-2">
                  <EntityLink kind="node" id={nodeId} href={`/nodes/${nodeId}`} />
                  <span className="flex flex-wrap gap-1">
                    {(r.atoms ?? [])
                      .filter((atom) => atom.startsWith(`${nodeId}/`))
                      .map((atom) => (
                        <span key={atom} className="border border-separator-border px-1 font-mono text-[10px] text-text-secondary">
                          {atom.slice(nodeId.length + 1)}
                        </span>
                      ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {r.binding && (
          <section>
            <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Hold binding</h3>
            <pre className="overflow-x-auto border border-separator-border bg-surface-sunken p-3 font-mono text-[11px] leading-5 text-text-secondary">
              {[`node        ${r.binding.nodeId}`, `cdi         ${r.binding.cdiDevices.join(' ')}`, `env file    ${r.binding.envFile}`, ...(r.binding.cgroupParent ? [`cgroup      ${r.binding.cgroupParent}`] : [])].join('\n')}
            </pre>
          </section>
        )}

        {r.operation && (
          <section className="flex items-center gap-2 font-mono text-[11px] text-text-secondary">
            operation <Mono>{r.operation.id}</Mono>
            <Tag status={r.operation.state === 'failed' ? 'crit' : r.operation.state === 'succeeded' ? 'ok' : 'pending'}>{r.operation.state}</Tag>
            {r.operation.error && <span className="text-text-error-primary">{r.operation.error.code}: {r.operation.error.message}</span>}
          </section>
        )}

        <details className="border border-separator-border">
          <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-text-secondary">Request as sent (reservations.create)</summary>
          <pre className="overflow-x-auto border-t border-separator-border bg-surface-sunken p-3 font-mono text-[11px] leading-5 text-text-secondary">
            {JSON.stringify({ tenantId: r.tenantId, ...r.request, idempotencyKey: r.idempotencyKey }, null, 2)}
          </pre>
        </details>
      </div>
    </Drawer>
  );
}
