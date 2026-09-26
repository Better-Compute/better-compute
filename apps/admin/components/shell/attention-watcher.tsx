'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { collectAttention } from '@/lib/modules';
import { useFeedback } from '@/components/ui/feedback';
import { useAcks } from './pins';
import { useLive, useWorkspaceSettings } from './workspace';
import { useAttentionItems } from './use-attention';

/**
 * Raises a toast when a critical item opens while the operator is watching (live clock only): the queue is
 * snapshotted on mount, so reloading or time travel never replays old alerts, and each item toasts once.
 */
export function AttentionWatcher() {
  const router = useRouter();
  const { live, siteId } = useWorkspaceSettings();
  const { toast } = useFeedback();
  const acks = useAcks();
  const items = useAttentionItems();
  const seen = useRef<Set<string> | null>(null);
  const context = useRef('');

  useEffect(() => {
    // A new scope, or coming back from the past, shows a different queue: take it as the baseline silently.
    const key = `${siteId ?? '*'}:${live}`;
    if (!seen.current || context.current !== key) {
      context.current = key;
      seen.current = new Set(items.map((item) => item.id));
      return;
    }
    const fresh = items.filter((item) => !seen.current!.has(item.id));
    for (const item of fresh) seen.current.add(item.id);
    if (!live) return;
    fresh
      .filter((item) => item.severity === 'critical' && !acks.has(item.id))
      .slice(0, 3)
      .forEach((item) =>
        toast({
          title: item.title,
          detail: item.detail,
          status: 'crit',
          timeout: 12_000,
          action: { label: item.action?.label ?? 'open', onAction: () => router.push(item.action?.href ?? item.href) },
        }),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return null;
}
