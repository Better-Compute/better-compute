'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { createTerminalSession } from '@better-compute/console-kit';
import { useStore } from '@better-compute/console-kit/react';
import { useConsole } from '@/components/console-provider';
import { ErrorLine } from '@/components/ui';

// A line-mode terminal on an instance (tunnels.open → the WebSocket tunnel). Output is decoded as UTF-8 with
// terminal escape sequences stripped; a full xterm view can replace the <pre> without changing the session.

// CSI / OSC sequences and the remaining single-character escapes.
// eslint-disable-next-line no-control-regex
const escapes = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r(?!\n)/g;

export default function TerminalPage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = use(params);
  const { api, tenantId, origin } = useConsole();
  const session = useMemo(
    () => createTerminalSession(api, { tenantId, instanceId, baseURL: origin }),
    [api, tenantId, instanceId, origin],
  );
  const state = useStore(session);
  const [line, setLine] = useState('');
  const screen = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void session.open();
    return () => session.close();
  }, [session]);

  const text = useMemo(() => {
    const decoder = new TextDecoder();
    return state.output
      .map((chunk) => decoder.decode(chunk.data, { stream: true }))
      .join('')
      .replace(escapes, '');
  }, [state.output]);

  useEffect(() => {
    const element = screen.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);

  useEffect(() => {
    // One character is roughly 8 × 17 px in the monospace face below.
    const element = screen.current;
    if (!element || state.status !== 'open') return;
    const fit = () =>
      session.resize(Math.floor(element.clientHeight / 17), Math.floor(element.clientWidth / 8));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [session, state.status]);

  return (
    <>
      <h2>Terminal: {instanceId}</h2>
      <p className="muted">
        {state.status === 'opening' && 'Connecting…'}
        {state.status === 'open' && `Connected (${state.tunnelId}).`}
        {state.status === 'closed' &&
          `Session ended${state.exit ? ` (exit ${state.exit.exitCode}${state.exit.reason ? `, ${state.exit.reason}` : ''})` : ''}.`}
      </p>
      {state.status === 'error' && <ErrorLine error={state.error} />}
      <pre ref={screen} className="terminal">
        {text}
      </pre>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          session.write(`${line}\r`);
          setLine('');
        }}
      >
        <input
          className="terminal-input"
          autoFocus
          disabled={state.status !== 'open'}
          value={line}
          onChange={(event) => setLine(event.target.value)}
          onKeyDown={(event) => {
            if (event.ctrlKey && event.key.length === 1) {
              // Ctrl-C, Ctrl-D, …: the control character itself.
              const code = event.key.toUpperCase().charCodeAt(0) - 64;
              if (code > 0 && code < 32) {
                event.preventDefault();
                session.write(String.fromCharCode(code));
              }
            }
          }}
        />
        <button type="submit" disabled={state.status !== 'open'}>
          Send
        </button>
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
      </form>
    </>
  );
}
