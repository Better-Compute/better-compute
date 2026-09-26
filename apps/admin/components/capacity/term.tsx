'use client';

import type { ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Tooltip, TooltipTrigger } from '@/components/base/tooltip/tooltip';

// One glossary for the capacity module: the numbers that look alike but mean different things. <Term id> puts a
// dotted underline on a label and its definition in a tooltip (hover or keyboard focus).

export const GLOSSARY = {
  schedulable: 'GPUs on healthy, uncordoned nodes: the ones new reservations can land on (the API’s allocatable).',
  allocated: 'GPUs held by running reservations on schedulable nodes, right now.',
  freeNow: 'Schedulable GPUs no reservation holds right now. A booking can start on them now if one node has enough together.',
  bookedLater: 'GPUs with a booking that starts later (the API’s reserved). A GPU in use now and booked later counts in both.',
  unbooked: 'The API’s conservative available: schedulable − allocated − booked later. Exact free capacity for a window comes from the timeline.',
  outOfService: 'GPUs on nodes that are offline, degraded, provisioning, held (failed, rescue, retiring) or cordoned: they take no new work.',
  pending: 'Admitted reservations that aren’t placed: no window with enough free GPUs yet, or waiting for a person to confirm.',
  runway: 'When the least-squares trend of the last 14 days of daily booked share would reach 95%. Extrapolation, not a promise.',
  spot: 'Discounted GPUs regular work can take back with a preemption notice. Metered at 40% of list here.',
  spend: 'Usage windows priced at list. IAM billing holds the real prices and invoices.',
} as const;

export type TermId = keyof typeof GLOSSARY;

export function Term({ id, children }: { id: TermId; children: ReactNode }) {
  return (
    <TooltipTrigger delay={300}>
      <AriaButton className="cursor-help text-left uppercase underline decoration-text-tertiary decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring [text-transform:inherit]">
        {children}
      </AriaButton>
      <Tooltip placement="top">{GLOSSARY[id]}</Tooltip>
    </TooltipTrigger>
  );
}
