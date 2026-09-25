'use client';

import { useEffect, useMemo, useState } from 'react';
import { createTerminalSession } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from './console-provider';
import { TerminalView } from './terminal-view';
import { ErrorLine } from './ui';

// A terminal page body: tunnels.open for an instance (compute:instances:exec) or a node's console
// (compute:nodes:console), then the WebSocket tunnel. Click the terminal and type; keys, pastes and resizes go
// straight to the target.

export function TerminalPanel({
  target,
  label,
}: {
  target: { instanceId: string } | { nodeId: string };
  label: string;
}) {
  const { api, tenantId, origin } = useConsole();
  const key = 'nodeId' in target ? `node:${target.nodeId}` : `inst:${target.instanceId}`;
  const session = useMemo(
    () => createTerminalSession(api, { tenantId, ...target, baseURL: origin }),
    // `target` is a fresh object each render; its identity is `key`.
    [api, tenantId, origin, key],
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
        <h2>{title ?? label}</h2>
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
