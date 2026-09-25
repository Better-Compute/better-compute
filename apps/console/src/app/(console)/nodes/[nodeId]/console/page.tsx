'use client';

import { use } from 'react';
import { TerminalPanel } from '@/components/terminal-panel';

/** A node's console (compute:nodes:console; recorded like every tunnel). */
export default function NodeConsolePage({ params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = use(params);
  return <TerminalPanel target={{ nodeId }} label={`Console: ${nodeId}`} />;
}
