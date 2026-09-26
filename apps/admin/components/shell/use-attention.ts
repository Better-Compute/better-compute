'use client';

import type { AttentionItem } from '@/lib/data';
import { collectAttention } from '@/lib/modules';
import { useModuleVersion } from './use-modules';
import { useLive, useWorkspaceSettings } from './workspace';

/**
 * Everything that needs an operator now, in the workspace scope, from the source the workspace reads (modules
 * compute live items from their live stores). Recomputed every 10 s of the clock.
 */
export function useAttentionItems(): AttentionItem[] {
  const { source } = useWorkspaceSettings();
  const modules = useModuleVersion();
  return useLive((now, scope) => collectAttention(now, scope, { source }), { bucketMs: 10_000, deps: [source, modules] });
}
