// The caller side of a tunnel (PLAN.md §7.6): after `tunnels.open` returns a ticket, open
// `wss://…/{basePath}/tunnels/{ticket}` and exchange `bettercompute.agent.v1.TunnelFrame`s, one per
// binary WebSocket message. The frames are encoded here by hand (the few fields a caller uses, wire
// compatible with the protobuf schema), so the client stays free of a protobuf runtime and works in
// browsers and Node.js alike.

/** The subset of `TunnelFrame` a caller sends and receives. */
export type TunnelFrameBody =
  | { case: 'opened' }
  | { case: 'data'; data: Uint8Array; channel: number }
  | { case: 'resize'; rows: number; cols: number }
  | { case: 'closed'; exitCode: number; reason: string };

// --- Protobuf wire format (the fields of TunnelFrame, TerminalSize and TunnelClosed) --------------

function varint(value: bigint): number[] {
  const out: number[] = [];
  let v = BigInt.asUintN(64, value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

const tag = (field: number, wire: 0 | 2) => varint(BigInt((field << 3) | wire));
const bytesField = (field: number, bytes: Uint8Array | number[]) => [
  ...tag(field, 2),
  ...varint(BigInt(bytes.length)),
  ...bytes,
];

/** Encodes a frame (`tunnel_id` is left empty: the server stamps the ticket's). */
export function encodeTunnelFrame(body: TunnelFrameBody): Uint8Array {
  const out: number[] = [];
  switch (body.case) {
    case 'opened':
      out.push(...bytesField(10, []));
      break;
    case 'data':
      if (body.channel) out.push(...tag(2, 0), ...varint(BigInt(body.channel)));
      out.push(...bytesField(11, body.data));
      break;
    case 'resize':
      out.push(
        ...bytesField(12, [
          ...tag(1, 0),
          ...varint(BigInt(body.rows)),
          ...tag(2, 0),
          ...varint(BigInt(body.cols)),
        ]),
      );
      break;
    case 'closed':
      out.push(
        ...bytesField(13, [
          ...(body.exitCode ? [...tag(1, 0), ...varint(BigInt(body.exitCode))] : []),
          ...(body.reason ? bytesField(2, new TextEncoder().encode(body.reason)) : []),
        ]),
      );
      break;
  }
  return new Uint8Array(out);
}

class Reader {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  done() {
    return this.position >= this.bytes.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.position >= this.bytes.length || shift > 63n) throw new Error('bad varint');
      const byte = this.bytes[this.position++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  }
  bytes_(): Uint8Array {
    const length = Number(this.varint());
    if (this.position + length > this.bytes.length) throw new Error('truncated');
    const out = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 2) this.bytes_();
    else if (wire === 1) this.position += 8;
    else if (wire === 5) this.position += 4;
    else throw new Error('unsupported wire type');
  }
}

function fields(
  bytes: Uint8Array,
  visit: (field: number, wire: number, reader: Reader) => boolean,
) {
  const reader = new Reader(bytes);
  while (!reader.done()) {
    const key = Number(reader.varint());
    const field = key >> 3;
    const wire = key & 7;
    if (!visit(field, wire, reader)) reader.skip(wire);
  }
}

/** Decodes a frame; unknown fields are skipped. Throws on malformed bytes. */
export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrameBody | undefined {
  let channel = 0;
  let body: TunnelFrameBody | undefined;
  fields(bytes, (field, wire, reader) => {
    if (field === 2 && wire === 0) channel = Number(reader.varint());
    else if (field === 10 && wire === 2) {
      reader.bytes_();
      body = { case: 'opened' };
    } else if (field === 11 && wire === 2)
      body = { case: 'data', data: reader.bytes_().slice(), channel: 0 };
    else if (field === 12 && wire === 2) {
      let rows = 0;
      let cols = 0;
      fields(reader.bytes_(), (f, w, r) => {
        if (w !== 0) return false;
        if (f === 1) rows = Number(r.varint());
        else if (f === 2) cols = Number(r.varint());
        else return false;
        return true;
      });
      body = { case: 'resize', rows, cols };
    } else if (field === 13 && wire === 2) {
      let exitCode = 0;
      let reason = '';
      fields(reader.bytes_(), (f, w, r) => {
        if (f === 1 && w === 0) exitCode = Number(BigInt.asIntN(32, r.varint()));
        else if (f === 2 && w === 2) reason = new TextDecoder().decode(r.bytes_());
        else return false;
        return true;
      });
      body = { case: 'closed', exitCode, reason };
    } else return false;
    return true;
  });
  if (body?.case === 'data') body.channel = channel;
  return body;
}

// --- The connection ------------------------------------------------------------------------------

export interface TunnelConnection {
  /** Resolves when the node opened its end (the daemon verified the ticket). */
  readonly ready: Promise<void>;
  /** Resolves with the node's exit status (or the transport's reason) when the tunnel ends. */
  readonly exited: Promise<{ exitCode: number; reason: string }>;
  /** Sends bytes (or UTF-8 text) to stdin / the byte stream. */
  write(data: Uint8Array | string): void;
  /** Terminal size for exec/console sessions. */
  resize(rows: number, cols: number): void;
  /** Receives output: channel 0 is stdout or the byte stream, 1 is stderr. */
  onData(handler: (data: Uint8Array, channel: number) => void): void;
  /** Ends the session (the node reports its exit status, then the socket closes). */
  close(): void;
  /**
   * Closes the socket now, without waiting for the node: for when `close()` got no answer (a stuck program or a
   * node that went away). `exited` resolves with exit code -1.
   */
  terminate(): void;
  /** Bytes written but not yet sent (the WebSocket's `bufferedAmount`): pause the source while it grows. */
  readonly bufferedAmount: number;
}

/** The tunnel's WebSocket URL from the API base and `tunnels.open`'s `path`. */
export function tunnelUrl(baseURL: string, basePath: string, path: string): string {
  const url = new URL(`${basePath.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, baseURL);
  url.protocol =
    url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  return url.toString();
}

type WebSocketLike = {
  binaryType: string;
  bufferedAmount?: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
};

/**
 * Opens a tunnel: `connectTunnel({ url: tunnelUrl(baseURL, basePath, opened.path) })`. The ticket
 * in the URL is single-use and valid for 60 s; open it right after `tunnels.open`.
 */
export function connectTunnel(options: {
  url: string;
  /** Default: the global `WebSocket` (browsers, Node.js 22+). */
  WebSocket?: new (url: string) => WebSocketLike;
}): TunnelConnection {
  const Socket =
    options.WebSocket ??
    (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Socket) throw new Error('No WebSocket implementation: pass connectTunnel({ WebSocket })');
  const ws = new Socket(options.url);
  ws.binaryType = 'arraybuffer';
  const handlers: ((data: Uint8Array, channel: number) => void)[] = [];
  let markReady!: () => void;
  let failReady!: (error: Error) => void;
  let markExited!: (status: { exitCode: number; reason: string }) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // Callers that only await `exited` must not see an unhandled rejection from `ready`.
  ready.catch(() => undefined);
  const exited = new Promise<{ exitCode: number; reason: string }>(
    (resolve) => (markExited = resolve),
  );
  let exit: { exitCode: number; reason: string } | undefined;
  const pending: Uint8Array[] = [];
  let open = false;
  const send = (bytes: Uint8Array) => (open ? ws.send(bytes) : pending.push(bytes));

  ws.addEventListener('open', () => {
    open = true;
    for (const bytes of pending.splice(0)) ws.send(bytes);
  });
  ws.addEventListener('message', (event: { data: ArrayBuffer }) => {
    let body: TunnelFrameBody | undefined;
    try {
      body = decodeTunnelFrame(new Uint8Array(event.data));
    } catch {
      return;
    }
    if (!body) return;
    if (body.case === 'opened') markReady();
    else if (body.case === 'data') for (const handler of handlers) handler(body.data, body.channel);
    else if (body.case === 'closed') exit = { exitCode: body.exitCode, reason: body.reason };
  });
  ws.addEventListener('close', (event: { code: number; reason: string }) => {
    failReady(new Error(`Tunnel closed before it opened (${event.code} ${event.reason})`));
    markExited(exit ?? { exitCode: -1, reason: event.reason || `closed ${event.code}` });
  });
  ws.addEventListener('error', () => failReady(new Error('Tunnel connection failed')));

  return {
    ready,
    exited,
    write: (data) =>
      send(
        encodeTunnelFrame({
          case: 'data',
          data: typeof data === 'string' ? new TextEncoder().encode(data) : data,
          channel: 0,
        }),
      ),
    resize: (rows, cols) => send(encodeTunnelFrame({ case: 'resize', rows, cols })),
    onData: (handler) => void handlers.push(handler),
    close: () => send(encodeTunnelFrame({ case: 'closed', exitCode: 0, reason: '' })),
    get bufferedAmount() {
      // Frames queued before the socket opened count too.
      return (ws.bufferedAmount ?? 0) + pending.reduce((sum, bytes) => sum + bytes.length, 0);
    },
    terminate() {
      failReady(new Error('Tunnel terminated'));
      markExited(exit ?? { exitCode: -1, reason: 'terminated' });
      try {
        ws.close(1000, 'terminated');
      } catch {
        // Already closing or closed.
      }
    },
  };
}
