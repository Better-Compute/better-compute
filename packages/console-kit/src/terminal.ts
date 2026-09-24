import { connectTunnel, tunnelUrl, type TunnelConnection } from '@better-compute/client';
import { createStore, type Store } from './store.js';
import type { ComputeRequester } from './resources.js';

// A browser terminal on an instance (PLAN.md §7.6, v0.3): `tunnels.open` (decided as
// `compute:instances:exec`), then the WebSocket tunnel with the single-use ticket. The store keeps
// the session state and a bounded output buffer an xterm-style view renders; input and resizes go
// straight to the node.

export interface TerminalState {
  status: 'idle' | 'opening' | 'open' | 'closed' | 'error';
  tunnelId?: string;
  /** Output chunks in order (bounded by `maxBufferedBytes`, oldest dropped). */
  output: readonly { data: Uint8Array; channel: number }[];
  bufferedBytes: number;
  exit?: { exitCode: number; reason: string };
  error?: unknown;
}

export interface TerminalSession extends Store<TerminalState> {
  /** Opens the tunnel (a no-op while opening or open). */
  open(): Promise<void>;
  write(data: string | Uint8Array): void;
  resize(rows: number, cols: number): void;
  close(): void;
  /** Called with every output chunk, for views that stream instead of reading the buffer. */
  onOutput(handler: (data: Uint8Array, channel: number) => void): () => void;
}

export function createTerminalSession(
  api: ComputeRequester,
  options: {
    tenantId: string;
    instanceId: string;
    op?: 'exec' | 'ssh';
    /** Where the API lives, for the WebSocket URL. */
    baseURL: string;
    basePath?: string;
    /** Default 256 KiB. */
    maxBufferedBytes?: number;
    /** Test seam (default `connectTunnel`). */
    connect?: (url: string) => TunnelConnection;
  },
): TerminalSession {
  const max = options.maxBufferedBytes ?? 256 * 1024;
  const store = createStore<TerminalState>({ status: 'idle', output: [], bufferedBytes: 0 });
  const listeners = new Set<(data: Uint8Array, channel: number) => void>();
  const connect = options.connect ?? ((url: string) => connectTunnel({ url }));
  let tunnel: TunnelConnection | undefined;

  const append = (data: Uint8Array, channel: number) => {
    for (const listener of listeners) listener(data, channel);
    store.set((state) => {
      const output = [...state.output, { data, channel }];
      let bytes = state.bufferedBytes + data.length;
      while (bytes > max && output.length > 1) bytes -= output.shift()!.data.length;
      return { ...state, output, bufferedBytes: bytes };
    });
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    async open() {
      const status = store.get().status;
      if (status === 'opening' || status === 'open') return;
      store.set({ status: 'opening', output: [], bufferedBytes: 0 });
      try {
        const opened = await api.$request<{ tunnelId: string; path: string }>('tunnels/open', {
          tenantId: options.tenantId,
          instanceId: options.instanceId,
          op: options.op ?? 'exec',
        });
        tunnel = connect(
          tunnelUrl(options.baseURL, options.basePath ?? '/api/compute', opened.path),
        );
        tunnel.onData(append);
        void tunnel.exited.then((exit) =>
          store.set((state) => ({ ...state, status: 'closed', exit })),
        );
        await tunnel.ready;
        store.set((state) =>
          state.status === 'opening'
            ? { ...state, status: 'open', tunnelId: opened.tunnelId }
            : state,
        );
      } catch (error) {
        store.set((state) => ({ ...state, status: 'error', error }));
      }
    },
    write(data) {
      if (store.get().status === 'open') tunnel?.write(data);
    },
    resize(rows, cols) {
      if (store.get().status === 'open' && rows > 0 && cols > 0) tunnel?.resize(rows, cols);
    },
    close() {
      tunnel?.close();
    },
    onOutput(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}
