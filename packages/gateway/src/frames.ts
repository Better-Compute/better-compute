import type { AgentFrame, ServerFrame } from '@better-compute/protocol';
import type { Gateway, PeerIdentity } from './gateway.js';
import { GrpcCode, toGrpcError, type GrpcError } from './grpc.js';

/**
 * The gateway end of an in-memory frame stream, structurally the testing kit's
 * `FrameConn<ServerFrame, AgentFrame>` (declared here so the gateway never imports `testing`).
 */
export interface FrameEndpoint {
  readonly closed: boolean;
  send(frame: ServerFrame): boolean;
  /** A returned promise is awaited before the next frame is delivered. */
  onFrame(handler: (frame: AgentFrame) => void | Promise<void>): void;
  onClose(handler: (info: { reason: string }) => void | Promise<void>): void;
  close(reason?: string): void;
}

const codeNames = new Map<number, string>(Object.entries(GrpcCode).map(([name, code]) => [code, name]));

/** A gRPC status as a close reason: `OK`, or `UNAVAILABLE: missed heartbeats`. */
export function closeReason(error?: GrpcError): string {
  if (!error || error.code === GrpcCode.OK) return 'OK';
  const name = codeNames.get(error.code) ?? String(error.code);
  return error.message ? `${name}: ${error.message}` : name;
}

/**
 * Serves one session over a frame stream instead of HTTP/2: the simulator and fleet tests run real
 * FakeDaemons against a real gateway this way (§15). Returns false when the gateway refused the
 * stream (the endpoint is then closed with the refusal as its reason).
 */
export function attachFrameConn(gateway: Gateway, peer: PeerIdentity, conn: FrameEndpoint): boolean {
  let handle;
  try {
    handle = gateway.open(peer, {
      send: (frame) => void conn.send(frame),
      close: (error) => {
        if (!conn.closed) conn.close(closeReason(error));
      },
    });
  } catch (error) {
    conn.close(closeReason(toGrpcError(error)));
    return false;
  }
  const session = handle;
  conn.onFrame((frame) => session.receive(frame));
  conn.onClose((info) => session.end(info.reason));
  return true;
}
