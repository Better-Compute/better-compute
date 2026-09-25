'use client';

import { use } from 'react';
import { TerminalPanel } from '@/components/terminal-panel';

/** An instance's serial console (compute:instances:exec; the node's agent attaches to the domain's serial port). */
export default function InstanceConsolePage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = use(params);
  return <TerminalPanel target={{ instanceId }} op="console" label={`Serial console: ${instanceId}`} />;
}
