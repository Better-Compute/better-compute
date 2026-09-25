'use client';

import { use } from 'react';
import { TerminalPanel } from '@/components/terminal-panel';

/** A terminal on an instance (compute:instances:exec). */
export default function TerminalPage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = use(params);
  return <TerminalPanel target={{ instanceId }} label={`Terminal: ${instanceId}`} />;
}
