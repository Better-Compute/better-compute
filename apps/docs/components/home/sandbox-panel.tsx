'use client';

import { useEffect, useRef, useState } from 'react';
import { cx } from '@/utils/cx';

/**
 * The Sandboxes chapter's panel: an isolated VPS instance from flavor to deletion. Checked against the code:
 * - flavors are vCPU, memory, disk and 0-16 GPUs (packages/vps/src/flavors.ts);
 * - the lifecycle is core's instance state table (packages/core/src/states.ts) walked by the vps.instances
 *   reconciler;
 * - the guest gets no join token, no bcd and no IAM key, user data is sealed and released only to the instance's
 *   own tenant, and exec goes through tunnels.open decided as compute:instances:exec (guides/vps/instances.mdx);
 * - runtime isolation is a runtime trait: vm, microvm or container.
 * The lifecycle strip steps through the states on a timer and holds while pointed at.
 */

const flavors = [
  { name: 'sbx.small', vcpu: 2, memory: 4, disk: 20, gpus: 0 },
  { name: 'sbx.large', vcpu: 8, memory: 32, disk: 80, gpus: 0 },
  { name: 'g1.h100x1', vcpu: 16, memory: 120, disk: 200, gpus: 1 },
];

const states = [
  { state: 'pending', note: 'admitted: one IAM decision on the draft' },
  { state: 'scheduling', note: 'the placer picks a host with free vCPUs' },
  { state: 'provisioning', note: 'image cached, user data sealed as secret://' },
  { state: 'starting', note: 'the host runtime boots the guest' },
  { state: 'running', note: 'exec through a single-use tunnel ticket' },
  { state: 'deleting', note: 'allocation, IP lease and sealed user data released' },
  { state: 'deleted', note: 'instance.deleted; nothing left on the host' },
];

const guarantees = [
  ['No platform secrets inside', 'the guest gets no join token, no bcd and no IAM key'],
  ['Tenant-bound user data', 'sealed through the broker, released only to its own tenant'],
  ['Audited access', 'exec, SSH and TCP via tunnels.open, decided as compute:instances:exec'],
  ['Isolation as a trait', 'each runtime declares vm, microvm or container'],
];

export function SandboxPanel() {
  const [index, setIndex] = useState(4);
  const [held, setHeld] = useState(false);
  const heldRef = useRef(held);
  heldRef.current = held;

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      if (!heldRef.current && !document.hidden) setIndex((i) => (i + 1) % states.length);
    }, 1600);
    return () => window.clearInterval(timer);
  }, []);

  const current = states[index]!;

  return (
    <div
      className="grid border border-border-button-default bg-surface-raised font-mono text-[0.75rem] leading-5 lg:grid-cols-12"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
    >
      <div className="border-b border-separator-border lg:col-span-4 lg:border-e lg:border-b-0">
        <p className="border-b border-separator-border px-4 py-2 text-[0.6875rem] tracking-[0.06em] text-text-tertiary uppercase">
          Flavors
        </p>
        <ul className="flex flex-col">
          {flavors.map((flavor) => (
            <li
              key={flavor.name}
              className="flex flex-col gap-1 border-b border-separator-border px-4 py-3 last:border-b-0"
            >
              <span className="text-text-primary">{flavor.name}</span>
              <span className="flex flex-wrap gap-x-3 text-text-secondary">
                <span>
                  <span className="text-signal">{flavor.vcpu}</span> vCPU
                </span>
                <span>{flavor.memory} GiB</span>
                <span>{flavor.disk} GiB disk</span>
                <span className={flavor.gpus ? 'text-text-primary' : undefined}>
                  {flavor.gpus ? `${flavor.gpus} GPU (VFIO)` : 'no GPU'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col border-b border-separator-border lg:col-span-4 lg:border-e lg:border-b-0">
        <p className="flex items-center justify-between border-b border-separator-border px-4 py-2 text-[0.6875rem] tracking-[0.06em] text-text-tertiary uppercase">
          <span>inst_7Q2M · lifecycle</span>
          <span className={held ? 'text-text-secondary' : 'text-signal'}>
            {held ? 'held' : 'live'}
          </span>
        </p>
        <ol className="flex flex-1 flex-col gap-1 px-4 py-3">
          {states.map((item, i) => (
            <li key={item.state}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                className={cx(
                  'flex w-full items-center gap-2.5 px-1.5 py-0.5 text-start transition-colors',
                  i === index
                    ? 'bg-signal-soft text-text-primary'
                    : i < index
                      ? 'text-text-secondary'
                      : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                <span className="led" data-on={i === index} />
                {item.state}
              </button>
            </li>
          ))}
        </ol>
        <p className="border-t border-separator-border px-4 py-2 text-text-secondary">
          <span className="text-signal">{current.state}</span> · {current.note}
        </p>
      </div>

      <ul className="flex flex-col lg:col-span-4">
        {guarantees.map(([lead, body]) => (
          <li
            key={lead}
            className="flex gap-3 border-b border-separator-border px-4 py-3 last:border-b-0"
          >
            <span className="led mt-[0.45rem]" data-on="true" />
            <span className="flex flex-col gap-0.5">
              <span className="text-text-primary">{lead}</span>
              <span className="font-sans text-body-2-regular leading-5 text-text-secondary">
                {body}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
