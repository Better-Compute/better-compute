import { describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { createExecTicketIssuer } from '@better-compute/pki';
import { TunnelFrameSchema, type TunnelFrame } from '@better-compute/protocol';
import {
  createDaemonHarness,
  createFramePair,
  type DaemonHarness,
  type FrameConn,
  type TunnelProgramFactory,
} from '@better-compute/testing';

// FakeDaemon's tunnel half (PLAN.md §7.6): OpenTunnel on the Session, the ticket re-verified
// against the spec's pinned JWKS and the daemon's own jti set, then a Tunnel stream that starts
// with `opened` and carries the program's I/O.

const NODE = 'node_01jz00000000000000000000na';
const START = Date.UTC(2026, 0, 1);
const tunnelCodec = {
  encode: (frame: TunnelFrame) => toBinary(TunnelFrameSchema, frame),
  decode: (bytes: Uint8Array) => fromBinary(TunnelFrameSchema, bytes),
};

function setup(options: { program?: TunnelProgramFactory; tunnels?: boolean } = {}) {
  const gatewayEnds: FrameConn<TunnelFrame, TunnelFrame>[] = [];
  let harness!: DaemonHarness;
  harness = createDaemonHarness({
    nodeId: NODE,
    start: START,
    ...(options.tunnels === false
      ? {}
      : {
          tunnels: {
            dial: (tunnelId) => {
              const pair = createFramePair<TunnelFrame, TunnelFrame>({
                scheduler: harness.scheduler,
                id: `tunnel-${tunnelId}`,
                codecs: { aToB: tunnelCodec, bToA: tunnelCodec },
              });
              gatewayEnds.push(pair.b);
              return pair.a;
            },
            ...(options.program ? { program: options.program } : {}),
          },
        }),
  });
  const issuer = createExecTicketIssuer({
    issuer: 'https://compute.test',
    clock: { now: () => harness.scheduler.now() },
  });
  const ticket = (sid: string, extra: Record<string, unknown> = {}) =>
    issuer.issue({ nodeId: NODE, sid, op: 'console', subject: 'usr_root', ...extra }).token;
  const received = (end: FrameConn<TunnelFrame, TunnelFrame>) => {
    const frames: TunnelFrame[] = [];
    end.onFrame((frame) => void frames.push(frame));
    return frames;
  };
  const text = (frames: TunnelFrame[]) =>
    frames
      .map((frame) =>
        frame.body.case === 'data' ? new TextDecoder().decode(frame.body.value) : '',
      )
      .join('');
  const send = (
    end: FrameConn<TunnelFrame, TunnelFrame>,
    tunnelId: string,
    body: TunnelFrame['body'],
  ) => end.send(create(TunnelFrameSchema, { tunnelId, body }));
  const pin = () => harness.sendSpec(1, { access: { execTicketJwksJson: issuer.jwksJson() } });
  const open = (tunnelId: string, token: string) =>
    harness.server.send({ case: 'openTunnel', value: { tunnelId, ticket: token } });
  return { harness, gatewayEnds, ticket, received, text, send, pin, open };
}

describe('FakeDaemon tunnels', () => {
  it('opens a verified tunnel and runs the echo shell until exit', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    t.pin();
    await t.harness.advance(100);
    t.open('tun_1', t.ticket('tun_1'));
    await t.harness.advance(100);
    expect(t.harness.daemon.tunnelOutcomes).toEqual([{ opened: true, tunnelId: 'tun_1' }]);
    const end = t.gatewayEnds[0]!;
    const frames = t.received(end);
    await t.harness.advance(100);
    expect(frames[0]!.body.case).toBe('opened');
    expect(frames.every((frame) => frame.tunnelId === 'tun_1')).toBe(true);
    expect(t.text(frames)).toContain(`fake console on ${NODE}\r\n$ `);

    t.send(end, 'tun_1', { case: 'data', value: new TextEncoder().encode('hi\r') });
    t.send(end, 'tun_1', { case: 'resize', value: { rows: 30, cols: 100 } });
    t.send(end, 'tun_1', { case: 'data', value: new TextEncoder().encode('size\rexit\r') });
    await t.harness.advance(100);
    const output = t.text(frames);
    expect(output).toContain('hi\r\necho: hi\r\n$ ');
    expect(output).toContain('30x100\r\n');
    const last = frames[frames.length - 1]!;
    expect(last.body).toEqual({
      case: 'closed',
      value: expect.objectContaining({ exitCode: 0, reason: 'exited' }),
    });
    expect(end.closed).toBe(true);
  });

  it('refuses replayed, mismatched and unpinned tickets without opening anything', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    t.open('tun_0', t.ticket('tun_0'));
    await t.harness.advance(100);
    t.pin();
    await t.harness.advance(100);
    const token = t.ticket('tun_2');
    t.open('tun_2', token);
    t.open('tun_2', token);
    t.open('tun_other', t.ticket('tun_3'));
    await t.harness.advance(100);
    expect(t.harness.daemon.tunnelOutcomes).toEqual([
      { opened: false, tunnelId: 'tun_0', reason: 'no-pinned-jwks' },
      { opened: true, tunnelId: 'tun_2' },
      { opened: false, tunnelId: 'tun_2', reason: 'ticket-rejected' },
      { opened: false, tunnelId: 'tun_other', reason: 'tunnel-id-mismatch' },
    ]);
    expect(t.gatewayEnds).toHaveLength(1);
  });

  it('refuses a ticket for another node or past its expiry', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    t.pin();
    await t.harness.advance(100);
    const foreign = createExecTicketIssuer({ issuer: 'https://evil.test' });
    t.open(
      'tun_4',
      foreign.issue({ nodeId: NODE, sid: 'tun_4', op: 'console', subject: 'x' }).token,
    );
    const late = t.ticket('tun_5');
    await t.harness.advance(120_000);
    t.open('tun_5', late);
    await t.harness.advance(100);
    expect(t.harness.daemon.tunnelOutcomes.map((outcome) => outcome.opened)).toEqual([
      false,
      false,
    ]);
  });

  it('hangs up the program when the caller closes', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    t.pin();
    await t.harness.advance(100);
    t.open('tun_6', t.ticket('tun_6'));
    await t.harness.advance(100);
    const end = t.gatewayEnds[0]!;
    const frames = t.received(end);
    t.send(end, 'tun_6', { case: 'closed', value: { exitCode: 0, reason: 'caller-closed' } });
    await t.harness.advance(100);
    expect(frames[frames.length - 1]!.body).toEqual({
      case: 'closed',
      value: expect.objectContaining({ exitCode: 129, reason: 'hangup' }),
    });
  });

  it('runs a custom program', async () => {
    const t = setup({
      program: (context) => ({
        data: (bytes) => context.write(bytes, 1),
      }),
    });
    await t.harness.advance(1_000);
    t.pin();
    await t.harness.advance(100);
    t.open('tun_7', t.ticket('tun_7'));
    await t.harness.advance(100);
    const end = t.gatewayEnds[0]!;
    const frames = t.received(end);
    t.send(end, 'tun_7', { case: 'data', value: new TextEncoder().encode('raw') });
    await t.harness.advance(100);
    const data = frames.filter((frame) => frame.body.case === 'data');
    expect(data.map((frame) => [frame.channel, t.text([frame])])).toEqual([[1, 'raw']]);
  });

  it('ignores OpenTunnel without the tunnels option', async () => {
    const t = setup({ tunnels: false });
    await t.harness.advance(1_000);
    t.pin();
    await t.harness.advance(100);
    t.open('tun_8', t.ticket('tun_8'));
    await t.harness.advance(100);
    expect(t.harness.daemon.tunnelOutcomes).toEqual([]);
  });
});
