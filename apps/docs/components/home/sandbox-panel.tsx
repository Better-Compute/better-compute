'use client';

import { useEffect, useRef, useState } from 'react';
import { cx } from '@/utils/cx';

/**
 * The Sandboxes channel: templates, and one sandbox from admission to expiry. Checked against the code
 * (packages/vps/src/sandboxes.ts): templates name a hosted pool, a flavor and an image, with TTL bounds (default 1 h,
 * max 24 h) and a warm pool {min, max}; sandbox states are starting, ready, failed, deleting and deleted; create
 * decides on the draft, then claims the template's oldest warm instance or schedules a new one; the TTL starts at
 * admission; extend moves expiresAt within maxTtlSeconds; the vps.sandboxes reconciler publishes sandbox.ready and,
 * at expiry, sandbox.expired before an ordinary instance delete. The guest gets no join token, no bcd and no IAM
 * key, and user data is sealed to its tenant (guides/vps/instances.mdx). The strip steps on a timer and holds while
 * pointed at.
 */

const templates = [
  { name: 'ci-runner', flavor: 'sbx.small · 2 vCPU · 4 GiB', ttl: '30 min / 24 h', warm: 4 },
  { name: 'notebook', flavor: 'sbx.large · 8 vCPU · 32 GiB', ttl: '1 h / 24 h', warm: 1 },
  { name: 'gpu-eval', flavor: 'g1.h100x1 · 16 vCPU · 1 GPU', ttl: '1 h / 8 h', warm: 0 },
];

const states = [
  { state: 'admitted', note: 'one IAM decision on the draft, budget checked' },
  { state: 'starting', note: 'a warm instance claimed, or a new one scheduled' },
  { state: 'ready', note: 'sandbox.ready: its instance is running' },
  { state: 'extended', note: 'expiresAt moved, within the template’s max TTL' },
  { state: 'expired', note: 'sandbox.expired at expiresAt' },
  { state: 'deleting', note: 'an ordinary instance delete, allocation released' },
  { state: 'deleted', note: 'sandbox.deleted; the warm pool refills' },
];

const guarantees = [
  ['No platform secrets inside', 'the guest gets no join token, no bcd and no IAM key'],
  ['Tenant-bound user data', 'sealed through the broker, released only to its own tenant'],
  ['Audited access', 'exec, SSH and TCP via tunnels.open, decided as compute:instances:exec'],
  ['Isolation as a trait', 'each runtime declares vm, microvm or container'],
];

export function SandboxPanel() {
  const [index, setIndex] = useState(2);
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
          Templates
        </p>
        <ul className="flex flex-col">
          {templates.map((template) => (
            <li
              key={template.name}
              className="flex flex-col gap-1 border-b border-separator-border px-4 py-3 last:border-b-0"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-text-primary">{template.name}</span>
                <span className="flex items-center gap-1" title={`${template.warm} warm`}>
                  {Array.from({ length: 4 }, (_, i) => (
                    <span key={i} className="led" data-on={i < template.warm} />
                  ))}
                </span>
              </span>
              <span className="text-text-secondary">{template.flavor}</span>
              <span className="text-text-tertiary">
                TTL {template.ttl} · warm <span className="text-signal">{template.warm}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col border-b border-separator-border lg:col-span-4 lg:border-e lg:border-b-0">
        <p className="flex items-center justify-between border-b border-separator-border px-4 py-2 text-[0.6875rem] tracking-[0.06em] text-text-tertiary uppercase">
          <span>sbx_7Q2M · lifecycle</span>
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
