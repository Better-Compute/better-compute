import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

// A minimal RFC 6455 codec for the WS fallback (PLAN.md §7.1, v0.4): binary messages, fragments,
// ping/pong and close. No extensions (no permessage-deflate: frame sizes are visible to the proxy
// anyway, and compression over attacker-influenced data is a side channel).

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WsOpcode = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export const wsAcceptKey = (key: string): string =>
  createHash('sha1').update(key + GUID).digest('base64');

/** A fresh `Sec-WebSocket-Key` (client side). */
export const wsClientKey = (): string => randomBytes(16).toString('base64');

/** One frame; `mask` is required from clients and forbidden from servers (RFC 6455 §5.1). */
export function encodeWsFrame(opcode: number, payload: Uint8Array, mask?: Uint8Array, fin = true): Buffer {
  const length = payload.byteLength;
  const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (mask ? 0x80 : 0) | (length < 126 ? length : length < 65_536 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(length, 2);
  else if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
  const body = Buffer.from(payload);
  if (mask) {
    header.set(mask, 2 + extended);
    for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!;
  }
  return Buffer.concat([header, body]);
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export class WsProtocolError extends Error {
  constructor(
    readonly closeCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Parses frames from a byte stream. `expectMasked`: true on a server (clients must mask). */
export class WsFrameDecoder {
  private buffer = Buffer.alloc(0);
  constructor(
    private readonly expectMasked: boolean,
    private readonly maxPayload: number,
  ) {}

  push(chunk: Uint8Array): WsFrame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames: WsFrame[] = [];
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) break;
      const fin = (b[0]! & 0x80) !== 0;
      if (b[0]! & 0x70) throw new WsProtocolError(1002, 'reserved bits set (no extensions negotiated)');
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      if (masked !== this.expectMasked)
        throw new WsProtocolError(1002, this.expectMasked ? 'client frames must be masked' : 'server frames must not be masked');
      let length = b[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) break;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new WsProtocolError(1009, 'frame too large');
        length = Number(big);
        offset = 10;
      }
      if (opcode >= 8 && (length > 125 || !fin)) throw new WsProtocolError(1002, 'invalid control frame');
      if (length > this.maxPayload) throw new WsProtocolError(1009, 'frame too large');
      const maskAt = offset;
      if (masked) offset += 4;
      if (b.length < offset + length) break;
      const payload = Buffer.from(b.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= b[maskAt + (i % 4)]!;
      frames.push({ fin, opcode, payload });
      this.buffer = b.subarray(offset + length);
    }
    return frames;
  }
}

export interface WsConnectionOptions {
  /** Server side: expect masked frames and send unmasked; client side the opposite. */
  role: 'server' | 'client';
  /** Largest reassembled message (default 5 MiB + headroom). */
  maxMessage?: number;
  onMessage(message: Buffer): void;
  onClose(info: { code: number; reason: string }): void;
}

/** A WebSocket connection over an upgraded socket: binary messages in and out. */
export class WsConnection {
  private readonly decoder: WsFrameDecoder;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;
  private readonly maxMessage: number;

  constructor(
    private readonly socket: Duplex,
    private readonly options: WsConnectionOptions,
  ) {
    this.maxMessage = options.maxMessage ?? 6 * 1024 * 1024;
    this.decoder = new WsFrameDecoder(options.role === 'server', this.maxMessage);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish(1006, 'connection lost'));
    socket.on('error', () => this.finish(1006, 'connection error'));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private mask(): Uint8Array | undefined {
    return this.options.role === 'client' ? randomBytes(4) : undefined;
  }

  /** False when the socket buffer is full ('drain' follows on the socket). */
  send(message: Uint8Array): boolean {
    if (this.closed) return false;
    return this.socket.write(encodeWsFrame(WsOpcode.binary, message, this.mask()));
  }

  ping(payload: Uint8Array = new Uint8Array(0)): void {
    if (!this.closed) this.socket.write(encodeWsFrame(WsOpcode.ping, payload, this.mask()));
  }

  private pongWaiters: ((alive: boolean) => void)[] = [];

  /** Sends a ping; true when a pong arrives within `timeoutMs` (a transport liveness probe). */
  probe(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (alive: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(alive);
      };
      const timer = setTimeout(() => {
        this.pongWaiters = this.pongWaiters.filter((entry) => entry !== waiter);
        waiter(false);
      }, timeoutMs);
      timer.unref?.();
      this.pongWaiters.push(waiter);
      this.ping();
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason.slice(0, 120), 2);
    this.socket.write(encodeWsFrame(WsOpcode.close, body, this.mask()));
    this.finish(code, reason);
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 1_000);
    timer.unref?.();
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pongWaiters.splice(0)) waiter(false);
    this.options.onClose({ code, reason });
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let frames: WsFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.close(error instanceof WsProtocolError ? error.closeCode : 1002, (error as Error).message);
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      switch (frame.opcode) {
        case WsOpcode.ping:
          this.socket.write(encodeWsFrame(WsOpcode.pong, frame.payload, this.mask()));
          break;
        case WsOpcode.pong:
          for (const waiter of this.pongWaiters.splice(0)) waiter(true);
          break;
        case WsOpcode.close: {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          const reason = frame.payload.subarray(2).toString('utf8');
          if (!this.closed) {
            this.socket.write(encodeWsFrame(WsOpcode.close, frame.payload.subarray(0, 2), this.mask()));
            this.finish(code, reason);
            this.socket.end();
          }
          return;
        }
        case WsOpcode.text:
          this.close(1003, 'binary messages only');
          return;
        case WsOpcode.binary:
        case WsOpcode.continuation: {
          if (frame.opcode === WsOpcode.binary && this.fragments.length) {
            this.close(1002, 'new message inside a fragmented one');
            return;
          }
          if (frame.opcode === WsOpcode.continuation && !this.fragments.length) {
            this.close(1002, 'continuation without a message');
            return;
          }
          this.fragmentBytes += frame.payload.length;
          if (this.fragmentBytes > this.maxMessage) {
            this.close(1009, 'message too large');
            return;
          }
          this.fragments.push(frame.payload);
          if (frame.fin) {
            const message = Buffer.concat(this.fragments);
            this.fragments = [];
            this.fragmentBytes = 0;
            this.options.onMessage(message);
          }
          break;
        }
        default:
          this.close(1002, `unknown opcode ${frame.opcode}`);
          return;
      }
    }
  }
}
