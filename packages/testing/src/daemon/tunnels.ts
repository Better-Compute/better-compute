import { create, type MessageInitShape } from '@bufbuild/protobuf';
import {
  createReplayCache,
  verifyExecTicket,
  type ExecTicketClaims,
  type ReplayCache,
} from '@better-compute/pki';
import { TunnelFrameSchema, type TunnelFrame } from '@better-compute/protocol';
import type { FrameConn } from '../frame-conn.js';

// The daemon half of tunnels (PLAN.md §7.6), as bcd does it: on the Session's `OpenTunnel`, verify
// the exec ticket again against the JWKS the NodeSpec pins (`access.exec_ticket_jwks_json`), for
// this node and this tunnel id, with the daemon's own jti set; then open a `Tunnel` stream whose
// first frame is `opened`, and run the requested program over data / resize / closed frames. A
// refused ticket opens nothing (the gateway's open times out), exactly like a node that never
// answers.

/** The daemon's end of a `Tunnel` stream (frames both ways are TunnelFrames). */
export type TunnelConn = FrameConn<TunnelFrame, TunnelFrame>;

export interface TunnelProgramContext {
  readonly tunnelId: string;
  readonly nodeId: string;
  readonly claims: ExecTicketClaims;
  /** Sends output (channel 0 stdout, 1 stderr). */
  write(data: string | Uint8Array, channel?: number): void;
  /** Ends the tunnel with an exit status. */
  exit(exitCode: number, reason?: string): void;
}

/** What runs on the node for one tunnel (a shell, a console, a TCP forward). */
export interface TunnelProgram {
  data?(bytes: Uint8Array, channel: number): void;
  resize?(rows: number, cols: number): void;
  /** The caller hung up; the program should `exit` (the gateway waits 5 s for the status). */
  hangup?(): void;
}

export type TunnelProgramFactory = (context: TunnelProgramContext) => TunnelProgram;

export interface FakeTunnelOptions {
  /** Opens the node's `Tunnel` stream to the gateway it holds its session with; undefined = cannot. */
  dial(tunnelId: string): TunnelConn | undefined;
  /** The program per tunnel (default `echoShell`). */
  program?: TunnelProgramFactory;
  /** The daemon's jti set (default: one per FakeDaemon). A ticket opens one tunnel, ever. */
  jtiCache?: ReplayCache;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A tiny line-mode shell: a banner and a prompt, local echo, `exit` (or Ctrl-D) ends with 0,
 * `false` with 1, `size` prints the terminal size, anything else is echoed back as `echo: <line>`.
 */
export const echoShell: TunnelProgramFactory = (context) => {
  let line = '';
  let size = { rows: 24, cols: 80 };
  context.write(`fake ${context.claims.op} on ${context.nodeId}\r\n$ `);
  return {
    data(bytes) {
      for (const ch of decoder.decode(bytes)) {
        if (ch === '\x04') return context.exit(0, 'exited');
        if (ch === '\x03') {
          line = '';
          context.write('^C\r\n$ ');
        } else if (ch === '\r' || ch === '\n') {
          const command = line.trim();
          line = '';
          context.write('\r\n');
          if (command === 'exit') return context.exit(0, 'exited');
          if (command === 'false') return context.exit(1, 'exited');
          if (command === 'size') context.write(`${size.rows}x${size.cols}\r\n`);
          else if (command) context.write(`echo: ${command}\r\n`);
          context.write('$ ');
        } else if (ch === '\x7f' || ch === '\b') {
          if (line) {
            line = line.slice(0, -1);
            context.write('\b \b');
          }
        } else {
          line += ch;
          context.write(ch);
        }
      }
    },
    resize(rows, cols) {
      size = { rows, cols };
    },
    hangup() {
      context.exit(129, 'hangup');
    },
  };
};

export type TunnelOutcome =
  | { opened: true; tunnelId: string }
  | { opened: false; tunnelId: string; reason: string };

/**
 * Handles one `OpenTunnel`: verifies the ticket for `nodeId` and `tunnelId`, dials the Tunnel
 * stream, announces it with `opened` and wires the program. Never throws.
 */
export function startTunnel(input: {
  nodeId: string;
  tunnelId: string;
  ticket: string;
  /** The pinned JWKS (`AccessSection.exec_ticket_jwks_json`); empty = the node accepts no tickets. */
  jwksJson: string;
  now: number;
  jtiCache: ReplayCache;
  options: FakeTunnelOptions;
}): TunnelOutcome {
  const { nodeId, tunnelId } = input;
  const refuse = (reason: string): TunnelOutcome => ({ opened: false, tunnelId, reason });
  if (!input.jwksJson) return refuse('no-pinned-jwks');
  let claims: ExecTicketClaims;
  try {
    claims = verifyExecTicket(input.ticket, {
      jwks: input.jwksJson,
      nodeId,
      now: input.now,
      jtiCache: input.jtiCache,
    });
  } catch {
    return refuse('ticket-rejected');
  }
  // The ticket names the stream it opens; a gateway asking for another id is refused.
  if (claims.sid !== tunnelId) return refuse('tunnel-id-mismatch');
  const conn = input.options.dial(tunnelId);
  if (!conn || conn.closed) return refuse('dial-failed');

  let ended = false;
  const frame = (body: MessageInitShape<typeof TunnelFrameSchema>['body'], channel = 0) =>
    create(TunnelFrameSchema, { tunnelId, channel, body });
  const context: TunnelProgramContext = {
    tunnelId,
    nodeId,
    claims,
    write(data, channel = 0) {
      if (ended) return;
      conn.send(
        frame({ case: 'data', value: typeof data === 'string' ? encoder.encode(data) : data }, channel),
      );
    },
    exit(exitCode, reason = 'exited') {
      if (ended) return;
      ended = true;
      conn.send(frame({ case: 'closed', value: { exitCode, reason } }));
      conn.close(reason);
    },
  };
  conn.send(frame({ case: 'opened', value: {} }));
  const program = (input.options.program ?? echoShell)(context);
  conn.onFrame((received) => {
    if (ended) return;
    switch (received.body.case) {
      case 'data':
        program.data?.(received.body.value, received.channel);
        return;
      case 'resize':
        program.resize?.(received.body.value.rows, received.body.value.cols);
        return;
      case 'closed':
        if (program.hangup) program.hangup();
        else context.exit(129, 'hangup');
        return;
      default:
      // `opened` from the gateway side means nothing here.
    }
  });
  conn.onClose(() => {
    ended = true;
  });
  return { opened: true, tunnelId };
}

/** A daemon's own jti set. */
export const newTunnelJtiCache = (): ReplayCache => createReplayCache({ whenFull: 'refuse' });
