'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { createTerminalSession } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { TerminalView } from '@/components/terminal-view';
import { ErrorLine } from '@/components/ui';

// A terminal on an instance: tunnels.open (decided as compute:instances:exec), then the WebSocket tunnel. Click
// the terminal and type; keys, pastes and resizes go straight to the instance.

export default function TerminalPage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = use(params);
  const { api, tenantId, origin } = useConsole();
  const session = useMemo(
    () => createTerminalSession(api, { tenantId, instanceId, baseURL: origin }),
    [api, tenantId, instanceId, origin],
  );
  const state = useStore(session);
  const [title, setTitle] = useState<string>();

  useEffect(() => {
    void session.open();
    return () => session.close();
  }, [session]);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{title ?? `Terminal: ${instanceId}`}</h2>
        <div className="row">
          <span className="muted">
            {state.status === 'opening' && 'Connecting…'}
            {state.status === 'open' && `Connected (${state.tunnelId})`}
            {state.status === 'closed' &&
              `Session ended${state.exit ? ` (exit ${state.exit.exitCode}${state.exit.reason ? `, ${state.exit.reason}` : ''})` : ''}`}
          </span>
          {state.status === 'open' ? (
            <button type="button" onClick={() => session.close()}>
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void session.open()}
              disabled={state.status === 'opening'}
            >
              Reconnect
            </button>
          )}
        </div>
      </div>
      {state.status === 'error' && <ErrorLine error={state.error} />}
      <TerminalView session={session} onTitle={setTitle} />
    </>
  );
}
