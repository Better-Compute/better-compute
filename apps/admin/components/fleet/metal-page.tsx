'use client';

import { useMemo, useState } from 'react';
import { RiArrowRightLine, RiCheckLine, RiCloseLine, RiHammerLine, RiRadarLine } from 'react-icons/ri';
import { EntityLink } from '@/components/shell/peek';
import { useNow } from '@/components/shell/workspace';
import { StackedBar } from '@/components/ui/charts';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { Led, Mono, Tag } from '@/components/ui/signal';
import type { FleetNode, ProvisionState, WorkflowView } from '@/lib/data/fleet';
import { fmtDuration, fmtRelative } from '@/lib/data/format';
import { poolById, siteById } from '@/lib/data/topology';
import { cx } from '@/utils/cx';
import { useFleetCommands } from './commands';
import { WorkflowSteps } from './node-detail';
import { ActionButton, provisionStatus } from './ui';
import { useFleet } from './use-fleet';

// Bare metal (metal module): machines move enrolling → inspecting → commissioning → ready → deploying → deployed
// under workflows that run on the site agent, the ramdisk and the node; failed machines park with maintenance on
// until an operator recovers them. Unknown machines that PXE boot on a site network wait here for confirmation.

const MAIN: ProvisionState[] = ['enrolling', 'inspecting', 'commissioning', 'ready', 'deploying', 'deployed'];
const SIDE: ProvisionState[] = ['failed', 'rescue', 'releasing', 'retiring', 'retired'];
const blurb: Partial<Record<ProvisionState, string>> = {
  enrolling: 'BMC verified, MACs read',
  inspecting: 'ramdisk inventory',
  commissioning: 'wipe, firmware, burn-in',
  ready: 'clean, powered off',
  deploying: 'image written, joining',
  deployed: 'running bcd',
  failed: 'workflow failed; maintenance on',
  rescue: 'booted to the rescue image',
  releasing: 'wiping after release',
  retiring: 'drain, wipe, power off',
  retired: 'out of service',
};

export function MetalPage() {
  const snapshot = useFleet();
  const now = useNow(5_000);
  const commands = useFleetCommands();
  const [selected, setSelected] = useState<ProvisionState | undefined>(undefined);
  const metal = useMemo(() => snapshot.nodes.filter((node) => node.bmc), [snapshot.nodes]);
  const byState = useMemo(() => {
    const out = new Map<ProvisionState, FleetNode[]>();
    for (const node of metal) out.set(node.provisionState, [...(out.get(node.provisionState) ?? []), node]);
    return out;
  }, [metal]);
  const workflows = snapshot.workflows.filter((workflow) => !selected || snapshot.nodes.find((node) => node.id === workflow.nodeId)?.provisionState === selected);
  const pending = snapshot.discovered.filter((machine) => !machine.nodeId);
  const drivers = { redfish: metal.filter((node) => node.bmc?.driver === 'redfish').length, ipmi: metal.filter((node) => node.bmc?.driver === 'ipmi').length };

  const lane = (state: ProvisionState, main: boolean) => {
    const nodes = byState.get(state) ?? [];
    const active = selected === state;
    return (
      <button
        key={state}
        type="button"
        onClick={() => setSelected(active ? undefined : state)}
        aria-pressed={active}
        className={cx(
          'flex min-w-0 flex-col gap-2 border p-2.5 text-left transition-colors',
          active ? 'border-signal-fill/60 bg-signal-soft' : 'border-separator-border bg-surface-raised hover:border-separator-border-strong',
          state === 'failed' && nodes.length > 0 && !active && 'border-red-500/50',
        )}
      >
        <span className="flex items-center gap-2">
          <Led status={provisionStatus[state]} />
          <span className="font-mono text-[12px] text-text-primary">{state}</span>
          <span className="ml-auto font-mono text-[15px] font-medium tabular-nums text-text-primary">{nodes.length}</span>
        </span>
        <span className="truncate text-caption-1-regular text-text-tertiary">{blurb[state]}</span>
        {main && state !== 'deployed' && (
          <span className="flex flex-wrap gap-[3px]">
            {nodes.slice(0, 24).map((node) => (
              <span key={node.id} title={node.hostname} className={cx('size-2', provisionStatus[state] === 'pending' ? 'border border-dashed border-signal-fill' : state === 'failed' ? 'bg-red-500' : 'bg-text-tertiary')} />
            ))}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Bare metal"
        icon={RiHammerLine}
        description="Machines with a BMC move through enrollment, inspection, commissioning and deployment under workflows run by site agents, the ramdisk and bcd. Click a stage to filter."
        meta={
          <>
            <Tag status="ok" led={false}>
              {metal.length} machines
            </Tag>
            <Tag status="ok" led={false}>
              redfish {drivers.redfish} · ipmi {drivers.ipmi}
            </Tag>
          </>
        }
      />

      <Panel title="Lifecycle" meta="provisionState">
        <div className="flex flex-col gap-3">
          <div className="grid items-stretch gap-1.5 [grid-template-columns:repeat(6,minmax(0,1fr))] max-lg:grid-cols-3">
            {MAIN.map((state) => lane(state, true))}
          </div>
          <div className="hidden items-center gap-1.5 px-2 lg:flex" aria-hidden>
            {MAIN.slice(0, -1).map((state) => (
              <span key={state} className="flex flex-1 items-center justify-end text-text-tertiary">
                <RiArrowRightLine className="size-3.5" />
              </span>
            ))}
            <span className="flex-1" />
          </div>
          <div className="grid gap-1.5 [grid-template-columns:repeat(5,minmax(0,1fr))] max-lg:grid-cols-2">{SIDE.map((state) => lane(state, false))}</div>
          <StackedBar
            height={6}
            parts={[...MAIN, ...SIDE].map((state) => ({
              label: state,
              value: byState.get(state)?.length ?? 0,
              tone: state === 'deployed' ? 'neutral' : state === 'failed' ? 'crit' : provisionStatus[state] === 'pending' ? 'signal' : 'hatch',
            }))}
          />
        </div>
      </Panel>

      <div className="grid grid-cols-12 gap-3">
        <Panel title="Workflows" meta={`${workflows.length}${selected ? ` · ${selected}` : ''}`} flush className="col-span-12 xl:col-span-8">
          {workflows.length === 0 ? (
            <EmptyState title="No workflows">Nothing is being provisioned{selected ? ` in ${selected}` : ''} right now.</EmptyState>
          ) : (
            <ul className="divide-y divide-separator-border">
              {workflows.map((workflow) => (
                <WorkflowRow key={workflow.id} workflow={workflow} node={snapshot.nodes.find((node) => node.id === workflow.nodeId)} now={now} />
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Discovered on PXE" icon={RiRadarLine} meta={`${pending.length} waiting`} className="col-span-12 xl:col-span-4">
          {pending.length === 0 ? (
            <EmptyState title="Nothing unknown">Machines that PXE boot but match no enrolled MAC appear here.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((machine) => {
                const candidate = machine.candidateFor ? snapshot.nodes.find((node) => node.id === machine.candidateFor) : undefined;
                return (
                  <li key={machine.mac} className="flex flex-col gap-1.5 border border-separator-border p-2.5">
                    <div className="flex items-center gap-2">
                      <Mono className="text-[13px]">{machine.mac}</Mono>
                      <span className="text-caption-1-regular text-text-tertiary">{siteById(machine.siteId)?.name}</span>
                      <span className="ml-auto font-mono text-[10px] text-text-tertiary">{machine.count}× seen</span>
                    </div>
                    <div className="font-mono text-[10px] text-text-tertiary">
                      uuid {machine.productUuid} · relay {machine.relays[0]} · last {machine.lastSeen ? fmtRelative(Date.parse(machine.lastSeen), now) : '—'}
                    </div>
                    {candidate ? (
                      <div className="flex items-center gap-2 border-t border-separator-border pt-1.5">
                        <span className="text-caption-1-regular text-text-secondary">
                          likely <EntityLink kind="node" id={candidate.id}>{candidate.hostname}</EntityLink> (enrolling, no MAC confirmed)
                        </span>
                        <span className="ml-auto flex gap-1">
                          <ActionButton icon={RiCheckLine} primary onPress={() => void commands.confirmMac(machine.mac, candidate, candidate.id)}>
                            Confirm
                          </ActionButton>
                          <ActionButton icon={RiCloseLine} onPress={() => commands.ignoreMac(machine.mac)}>
                            Ignore
                          </ActionButton>
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 border-t border-separator-border pt-1.5">
                        <span className="text-caption-1-regular text-text-tertiary">no enrolled candidate: enroll it with metal.enroll, or ignore</span>
                        <span className="ml-auto">
                          <ActionButton icon={RiCloseLine} onPress={() => commands.ignoreMac(machine.mac)}>
                            Ignore
                          </ActionButton>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function WorkflowRow({ workflow, node, now }: { workflow: WorkflowView; node?: FleetNode; now: number }) {
  const [open, setOpen] = useState(workflow.state === 'failed');
  const done = workflow.steps.filter((step) => step.state === 'succeeded').length;
  const current = workflow.steps.find((step) => step.id === workflow.stepId);
  return (
    <li>
      <button type="button" onClick={() => setOpen(!open)} className="grid w-full grid-cols-[minmax(140px,1fr)_120px_minmax(160px,1.4fr)_90px] items-center gap-3 px-3 py-2 text-left hover:bg-background-secondary-default/60">
        <span className="flex min-w-0 flex-col">
          {node ? (
            <EntityLink kind="node" id={node.id} className="truncate no-underline">
              {node.hostname}
            </EntityLink>
          ) : (
            <Mono>{workflow.nodeId}</Mono>
          )}
          <span className="truncate font-mono text-[10px] text-text-tertiary">{node ? poolById(node.poolId ?? '')?.name : ''}</span>
        </span>
        <span className="flex flex-col">
          <span className="font-mono text-[11px] text-text-secondary">{workflow.profileId}</span>
          <Tag status={workflow.state === 'failed' ? 'crit' : 'live'} className="self-start">
            {workflow.state}
          </Tag>
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex gap-[2px]">
            {workflow.steps.map((step) => (
              <span
                key={step.id}
                title={`${step.action} · ${step.state}`}
                className={cx('h-1.5 flex-1', step.state === 'succeeded' ? 'bg-text-secondary' : step.state === 'failed' ? 'bg-red-500' : step.state === 'running' || step.state === 'waiting' ? 'bg-signal-fill' : 'bg-background-secondary-default')}
              />
            ))}
          </span>
          <span className="truncate font-mono text-[11px] text-text-secondary">
            {done}/{workflow.steps.length} · {current?.action ?? '—'}
            {current && current.attempt > 1 && <span className="text-signal"> · attempt {current.attempt}</span>}
          </span>
        </span>
        <span className="text-right font-mono text-[11px] text-text-tertiary">{fmtDuration((workflow.finishedAt ?? now) - workflow.createdAt)}</span>
      </button>
      {open && (
        <div className="border-t border-separator-border/60 bg-surface-sunken px-4 py-3">
          <WorkflowSteps workflow={workflow} now={now} />
        </div>
      )}
    </li>
  );
}
