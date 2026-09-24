import type { KeyObject } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import {
  decodeServerFrame,
  encodeAgentFrame,
  MAX_FRAME_BYTES,
  type AgentFrame,
  type ServerFrame,
} from '@better-compute/protocol';
import { frameMessage, MessageDecoder } from './grpc.js';
import { WsConnection, wsClientKey } from './websocket.js';
import { signAgentProof, verifyGatewayProof, wsNonce } from './ws-auth.js';
import { WS_PATH, WS_SUBPROTOCOL } from './ws.js';

// The daemon side of the WS fallback as a reference client (PLAN.md §7.1, v0.4): the real-time
// harness and tests use it; bcd mirrors it in Go. It proves itself with a proof JWT and accepts the
// connection only if the gateway signs its nonce with a key chaining to the pinned serving CA, so
// a TLS-inspecting proxy in between can relay frames but not impersonate either side.

export interface GatewayWsClientOptions {
  /** `wss://gw.<region>…` or `ws://…` (tests). Only host, port and scheme are used. */
  url: string;
  nodeId: string;
  /** The node key and its certificate chain (DER, leaf first). */
  key: KeyObject;
  chain: readonly Uint8Array[];
  /** The `aud` the gateway expects, e.g. `gw.<region>…`. */
  audience: string;
  /** The serving CA pinned at join (DER). */
  servingRoots: readonly Uint8Array[];
  /** For `wss://` through a proxy: its CA for transport only (the gateway proof carries trust). */
  tls?: ConnectionOptions;
  clock?: Clock;
  onFrame(frame: ServerFrame): void;
  onClose?(info: { code: number; reason: string }): void;
}

export interface GatewayWsClient {
  /** The gateway id the verified gateway proof names. */
  readonly gatewayId: string;
  send(frame: AgentFrame): boolean;
  close(code?: number, reason?: string): void;
}

/**
 * Dials the WS fallback. Rejects `UNAUTHENTICATED` when the gateway refuses the proof, and also
 * when the gateway's proof does not verify (the daemon never talks to an unproven gateway).
 */
export function connectGatewayWs(options: GatewayWsClientOptions): Promise<GatewayWsClient> {
  const clock = options.clock ?? systemClock;
  const url = new URL(options.url);
  const secure = url.protocol === 'wss:';
  const port = Number(url.port || (secure ? 443 : 80));
  const nonce = wsNonce();
  const proof = signAgentProof({
    key: options.key,
    chain: options.chain,
    nodeId: options.nodeId,
    audience: options.audience,
    nonce,
    now: clock.now(),
  });
  const socket: Socket = secure
    ? tlsConnect({ host: url.hostname, port, servername: url.hostname, ...options.tls })
    : netConnect(port, url.hostname);
  socket.on('error', () => {});
  const request =
    `GET ${WS_PATH} HTTP/1.1\r\nhost: ${url.host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
    `sec-websocket-key: ${wsClientKey()}\r\nsec-websocket-version: 13\r\nsec-websocket-protocol: ${WS_SUBPROTOCOL}\r\n` +
    `x-bc-nonce: ${nonce}\r\nx-bc-proof: ${proof}\r\n\r\n`;

  return new Promise<GatewayWsClient>((resolve, reject) => {
    const fail = (error: unknown) => {
      socket.destroy();
      reject(error);
    };
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(request));
    socket.once('error', fail);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 32_768) fail(new ComputeError('INVALID_INPUT', 'oversized upgrade response'));
        return;
      }
      socket.off('data', onData);
      socket.pause();
      const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
      }
      const status = Number(lines[0]!.split(' ')[1]);
      if (status !== 101) {
        const reason = decodeURIComponent(headers.get('x-bc-reason') ?? `HTTP ${status}`);
        return fail(new ComputeError(status === 401 ? 'UNAUTHENTICATED' : status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR', reason));
      }
      if (headers.get('sec-websocket-protocol') !== WS_SUBPROTOCOL)
        return fail(new ComputeError('INVALID_INPUT', `the gateway did not select ${WS_SUBPROTOCOL}`));
      let gatewayId: string;
      try {
        gatewayId = verifyGatewayProof(headers.get('x-bc-gateway-proof') ?? '', {
          servingRoots: options.servingRoots,
          nodeId: options.nodeId,
          nonce,
          now: clock.now(),
        });
      } catch (error) {
        return fail(error);
      }
      const rest = buffer.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      const decoder = new MessageDecoder(MAX_FRAME_BYTES);
      const connection = new WsConnection(socket, {
        role: 'client',
        onMessage: (message) => {
          try {
            for (const bytes of decoder.push(message)) options.onFrame(decodeServerFrame(bytes));
          } catch {
            connection.close(1008, 'undecodable frame');
          }
        },
        onClose: (info) => options.onClose?.(info),
      });
      socket.off('error', fail);
      socket.resume();
      resolve({
        gatewayId,
        send: (frame) => connection.send(frameMessage(encodeAgentFrame(frame))),
        close: (code = 1000, reason = '') => connection.close(code, reason),
      });
    };
    socket.on('data', onData);
  });
}
