import type { KeyObject } from 'node:crypto';
import type { ConnectionOptions } from 'node:tls';
import type { Clock } from '@better-compute/core';
import { connectGatewayWs, type GatewayWsClient } from '@better-compute/gateway';
import type { AgentFrame, ServerFrame } from '@better-compute/protocol';
import type { AgentConn, CloseInfo, FrameHandler } from '../frame-conn.js';

// FakeDaemon over the WS fallback (PLAN.md §7.1, v0.4): a `dial` that speaks WebSocket with the
// in-band proofs (`connectGatewayWs`), so the real-time harness and gateway tests run the same
// daemon over mTLS-less networks. Additive to the daemon kit; the journal rules are untouched.

export interface WsDialOptions {
  /** `ws://127.0.0.1:<port>` or `wss://gw…`. */
  url: string;
  /** The `aud` the gateway expects. */
  audience: string;
  /** The serving CA pinned at join (DER). */
  servingRoots: readonly Uint8Array[];
  /** The node's key and certificate chain (DER, leaf first). */
  credentials(nodeId: string): { key: KeyObject; chain: readonly Uint8Array[] } | Promise<{ key: KeyObject; chain: readonly Uint8Array[] }>;
  clock?: Clock;
  /** Transport trust through a TLS-inspecting proxy (its CA). */
  tls?: ConnectionOptions;
}

let dials = 0;

/** `FakeDaemonOptions.dial` over WS: `dial: () => ws(nodeId)`. */
export function createWsDialer(options: WsDialOptions): (nodeId: string) => AgentConn {
  return (nodeId) => {
    const id = `ws-${++dials}`;
    const inbox: ServerFrame[] = [];
    const outbox: AgentFrame[] = [];
    const closeHandlers: ((info: CloseInfo) => void | Promise<void>)[] = [];
    let handler: FrameHandler<ServerFrame> | undefined;
    let delivering = false;
    let client: GatewayWsClient | undefined;
    let closeInfo: CloseInfo | undefined;
    let localReason: string | undefined;

    const deliver = async () => {
      if (delivering || !handler) return;
      delivering = true;
      try {
        while (inbox.length && handler) await handler(inbox.shift()!);
      } finally {
        delivering = false;
      }
    };
    const finish = (info: CloseInfo) => {
      if (closeInfo) return;
      closeInfo = info;
      for (const onClose of closeHandlers) void Promise.resolve(onClose(info)).catch(() => {});
    };

    void (async () => {
      try {
        const credentials = await options.credentials(nodeId);
        const connected = await connectGatewayWs({
          url: options.url,
          nodeId,
          key: credentials.key,
          chain: credentials.chain,
          audience: options.audience,
          servingRoots: options.servingRoots,
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.tls ? { tls: options.tls } : {}),
          onFrame: (frame) => {
            inbox.push(frame);
            void deliver();
          },
          onClose: (info) =>
            finish({
              reason: localReason ?? `ws-${info.code}${info.reason ? `: ${info.reason}` : ''}`,
              by: localReason !== undefined ? 'local' : 'remote',
            }),
        });
        if (localReason !== undefined) {
          connected.close(1000, localReason);
          return;
        }
        client = connected;
        for (const frame of outbox.splice(0)) client.send(frame);
      } catch (error) {
        // A refused proof, an unproven gateway or a dead endpoint: the daemon backs off and redials.
        finish({ reason: `ws-refused: ${error instanceof Error ? error.message : String(error)}`, by: 'remote' });
      }
    })();

    return {
      id,
      get closed() {
        return closeInfo !== undefined;
      },
      get closeInfo() {
        return closeInfo;
      },
      send(frame: AgentFrame) {
        if (closeInfo || localReason !== undefined) return false;
        if (client) return client.send(frame) || true;
        outbox.push(frame);
        return true;
      },
      onFrame(next) {
        handler = next;
        void deliver();
      },
      onClose(next) {
        closeHandlers.push(next);
        if (closeInfo) void Promise.resolve(next(closeInfo)).catch(() => {});
      },
      close(reason = 'closed') {
        if (closeInfo || localReason !== undefined) return;
        localReason = reason;
        if (client) client.close(1000, reason);
      },
      abort(reason = 'aborted') {
        if (closeInfo) return;
        localReason = reason;
        if (client) client.abort();
        else finish({ reason, by: 'local' });
      },
      ping(timeoutMs, onResult) {
        if (!client) return onResult(false);
        void client.ping(timeoutMs).then(onResult);
      },
    };
  };
}
