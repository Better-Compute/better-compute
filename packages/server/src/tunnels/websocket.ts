import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// The server side of RFC 6455, just enough for tunnels: the version 13 opening handshake, masked
// client frames (fragmented or not), binary and text messages, ping/pong, the closing handshake
// with validated close codes, a message size bound, and a ping keepalive that closes a peer that
// stopped answering. No extensions, no subprotocols.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WebSocketConnection {
  /** Sends one binary message; false when the socket's buffer is full (wait for `onDrain`). */
  sendBinary(data: Uint8Array): boolean;
  sendText(text: string): boolean;
  /** Starts the closing handshake with `code` (1000 normal, 1008 policy, 1011 error). */
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: Uint8Array, binary: boolean) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  /** Called once when the buffer has room again, or when the connection closes. */
  onDrain(handler: () => void): void;
  pause(): void;
  resume(): void;
  readonly closed: boolean;
}

/** Whether a request is a WebSocket version 13 upgrade with a well-formed key. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const key = req.headers['sec-websocket-key'];
  return (
    req.method === 'GET' &&
    (req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    /\bupgrade\b/i.test(req.headers.connection ?? '') &&
    req.headers['sec-websocket-version'] === '13' &&
    typeof key === 'string' &&
    /^[A-Za-z0-9+/]{22}==$/.test(key)
  );
}

const reasons: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  426: 'Upgrade Required',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
};

/** Answers the upgrade with a plain HTTP error and closes the socket. */
export function rejectUpgrade(socket: Duplex, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  const extra = status === 426 ? 'sec-websocket-version: 13\r\n' : '';
  socket.end(
    `HTTP/1.1 ${status} ${reasons[status] ?? 'Error'}\r\ncontent-type: application/json\r\n${extra}content-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`,
  );
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) header = Buffer.from([0x80 | opcode, length]);
  else if (length < 65536) header = Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Close codes a peer may send (RFC 6455 §7.4): 1000-1003, 1007-1014 and 3000-4999. */
function validCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

/** Received bytes as a list of chunks: frames are cut out without re-copying everything per chunk. */
class Chunks {
  private chunks: Buffer[] = [];
  length = 0;
  push(chunk: Buffer) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
  }
  /** The first `n` bytes (n ≤ length), copying only when they span chunks. */
  peek(n: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const joined = Buffer.concat(this.chunks);
    this.chunks = [joined];
    return joined.subarray(0, n);
  }
  /** Removes and returns the first `n` bytes. */
  take(n: number): Buffer {
    const out = Buffer.from(this.peek(n));
    let left = n;
    while (left > 0) {
      const head = this.chunks[0]!;
      if (head.length <= left) {
        this.chunks.shift();
        left -= head.length;
      } else {
        this.chunks[0] = head.subarray(left);
        left = 0;
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * Completes the handshake on `socket` (from the HTTP server's `upgrade` event) and returns the
 * connection. Messages larger than `maxMessageBytes` (default 1 MiB) close it with 1009.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { maxMessageBytes?: number; pingIntervalMs?: number } = {},
): WebSocketConnection {
  const max = options.maxMessageBytes ?? 1024 * 1024;
  const key = req.headers['sec-websocket-key'] as string;
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
  );
  const received = new Chunks();
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let fragmentBinary = true;
  let closed = false;
  let closeSent = false;
  let heardAt = Date.now();
  const messageHandlers: ((data: Uint8Array, binary: boolean) => void)[] = [];
  const closeHandlers: ((code: number, reason: string) => void)[] = [];
  const drainHandlers: (() => void)[] = [];
  let pinger: ReturnType<typeof setInterval> | undefined;

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    if (pinger) clearInterval(pinger);
    // Writers waiting for room must not wait forever on a closed connection.
    for (const handler of drainHandlers.splice(0)) handler();
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
    while (!closed) {
      if (received.length < 2) return;
      const [first, second] = received.peek(2);
      const fin = (first! & 0x80) !== 0;
      const opcode = first! & 0x0f;
      if (first! & 0x70) return fail(1002, 'reserved bits set');
      if (!(second! & 0x80)) return fail(1002, 'client frames must be masked');
      let length = second! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (received.length < 4) return;
        length = received.peek(4).readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (received.length < 10) return;
        const big = received.peek(10).readBigUInt64BE(2);
        if (big > BigInt(max)) return fail(1009, 'message too large');
        length = Number(big);
        offset = 10;
      }
      if (length > max) return fail(1009, 'message too large');
      if (received.length < offset + 4 + length) return;
      const raw = received.take(offset + 4 + length);
      const mask = raw.subarray(offset, offset + 4);
      const payload = raw.subarray(offset + 4);
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      heardAt = Date.now();

      if (opcode >= 0x8) {
        if (!fin || payload.length > 125) return fail(1002, 'bad control frame');
        if (opcode === 0x8) {
          if (payload.length === 1) return fail(1002, 'bad close frame');
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          if (payload.length >= 2 && !validCloseCode(code)) return fail(1002, 'bad close code');
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          sendClose(code, '');
          socket.end();
          return finish(code, reason);
        }
        if (opcode === 0x9) {
          if (!closeSent) socket.write(frame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) continue;
        return fail(1002, 'reserved control opcode');
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fragments.length) return fail(1002, 'expected a continuation frame');
        fragmentBinary = opcode === 0x2;
      } else if (opcode !== 0x0 || !fragments.length) return fail(1002, 'unexpected frame');
      fragments.push(Buffer.from(payload));
      fragmentBytes += payload.length;
      if (fragmentBytes > max) return fail(1009, 'message too large');
      if (fin) {
        const message = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments);
        fragments = [];
        fragmentBytes = 0;
        for (const handler of messageHandlers) handler(new Uint8Array(message), fragmentBinary);
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    received.push(chunk);
    parse();
  });
  socket.on('drain', () => {
    for (const handler of drainHandlers.splice(0)) handler();
  });
  // A peer that half-closes (FIN without a Close frame) is gone: end our side too.
  socket.on('end', () => {
    if (!socket.destroyed) socket.end();
    finish(1006, 'connection ended');
  });
  socket.on('close', () => finish(1006, 'connection lost'));
  socket.on('error', () => finish(1006, 'connection error'));

  // Keepalive: ping, and give up on a peer silent for two periods.
  const every = options.pingIntervalMs ?? 30_000;
  pinger = setInterval(() => {
    if (closed) return;
    if (Date.now() - heardAt > 2 * every) {
      socket.destroy();
      return finish(1006, 'peer stopped answering');
    }
    if (!closeSent) socket.write(frame(0x9, Buffer.alloc(0)));
  }, every);
  pinger.unref?.();

  // Bytes the client sent right after the handshake arrive in `head`.
  if (head.length) {
    received.push(Buffer.from(head));
    parse();
  }

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
    onDrain: (handler) => (closed ? handler() : void drainHandlers.push(handler)),
    pause: () => void socket.pause(),
    resume: () => void socket.resume(),
    get closed() {
      return closed;
    },
  };
}
