import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// The server side of RFC 6455, just enough for tunnels: the opening handshake, masked client
// frames (fragmented or not), binary and text messages, ping/pong and the closing handshake, with a
// message size bound. No extensions, no subprotocol negotiation beyond echoing none.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WebSocketConnection {
  /** Sends one binary message; false when the socket's buffer is full (wait for `drain`). */
  sendBinary(data: Uint8Array): boolean;
  sendText(text: string): boolean;
  /** Starts the closing handshake with `code` (1000 normal, 1008 policy, 1011 error). */
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: Uint8Array, binary: boolean) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onDrain(handler: () => void): void;
  pause(): void;
  resume(): void;
  readonly closed: boolean;
}

/** Whether a request asks for a WebSocket upgrade. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return (
    req.method === 'GET' &&
    (req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    /\bupgrade\b/i.test(req.headers.connection ?? '') &&
    typeof req.headers['sec-websocket-key'] === 'string'
  );
}

/** Answers the upgrade with a plain HTTP error and closes the socket. */
export function rejectUpgrade(socket: Duplex, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  const reason =
    {
      400: 'Bad Request',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      426: 'Upgrade Required',
      501: 'Not Implemented',
      502: 'Bad Gateway',
    }[status] ?? 'Error';
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`,
  );
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const buffer = Buffer.alloc(10);
            buffer[0] = 0x80 | opcode;
            buffer[1] = 127;
            buffer.writeBigUInt64BE(BigInt(length), 2);
            return buffer;
          })();
  return Buffer.concat([header, payload]);
}

/**
 * Completes the handshake on `socket` (from the HTTP server's `upgrade` event) and returns the
 * connection. Messages larger than `maxMessageBytes` (default 1 MiB) close it with 1009.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { maxMessageBytes?: number } = {},
): WebSocketConnection {
  const max = options.maxMessageBytes ?? 1024 * 1024;
  const key = req.headers['sec-websocket-key'] as string;
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
  );
  let buffered: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let fragmentBinary = true;
  let closed = false;
  let closeSent = false;
  const messageHandlers: ((data: Uint8Array, binary: boolean) => void)[] = [];
  const closeHandlers: ((code: number, reason: string) => void)[] = [];
  const drainHandlers: (() => void)[] = [];

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler(code, reason);
  };
  const sendClose = (code: number, reason: string) => {
    if (closeSent || socket.destroyed) return;
    closeSent = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    socket.write(frame(0x8, body));
  };
  const fail = (code: number, reason: string) => {
    sendClose(code, reason);
    socket.end();
    finish(code, reason);
  };

  const parse = () => {
    for (;;) {
      if (buffered.length < 2) return;
      const first = buffered[0]!;
      const second = buffered[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if (first & 0x70) return fail(1002, 'reserved bits set');
      if (!(second & 0x80)) return fail(1002, 'client frames must be masked');
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(max)) return fail(1009, 'message too large');
        length = Number(big);
        offset = 10;
      }
      if (length > max) return fail(1009, 'message too large');
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      buffered = buffered.subarray(offset + 4 + length);

      if (opcode >= 0x8) {
        if (!fin || payload.length > 125) return fail(1002, 'bad control frame');
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          sendClose(code === 1005 ? 1000 : code, '');
          socket.end();
          return finish(code, reason);
        }
        if (opcode === 0x9) socket.write(frame(0xa, payload));
        continue; // pong: ignore
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fragments.length) return fail(1002, 'expected a continuation frame');
        fragmentBinary = opcode === 0x2;
      } else if (opcode !== 0x0 || !fragments.length) return fail(1002, 'unexpected frame');
      fragments.push(payload);
      fragmentBytes += payload.length;
      if (fragmentBytes > max) return fail(1009, 'message too large');
      if (fin) {
        const message = Buffer.concat(fragments);
        fragments = [];
        fragmentBytes = 0;
        for (const handler of messageHandlers) handler(new Uint8Array(message), fragmentBinary);
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    parse();
  });
  socket.on('drain', () => {
    for (const handler of drainHandlers.splice(0)) handler();
  });
  socket.on('close', () => finish(1006, 'connection lost'));
  socket.on('error', () => finish(1006, 'connection error'));

  return {
    sendBinary: (data) => (closed || closeSent ? false : socket.write(frame(0x2, data))),
    sendText: (text) => (closed || closeSent ? false : socket.write(frame(0x1, Buffer.from(text)))),
    close(code = 1000, reason = '') {
      sendClose(code, reason.slice(0, 120));
      socket.end();
      finish(code, reason);
    },
    onMessage: (handler) => void messageHandlers.push(handler),
    onClose: (handler) => void closeHandlers.push(handler),
    onDrain: (handler) => void drainHandlers.push(handler),
    pause: () => void socket.pause(),
    resume: () => void socket.resume(),
    get closed() {
      return closed;
    },
  };
}
