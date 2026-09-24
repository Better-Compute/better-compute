import { MAX_FRAME_BYTES } from '@better-compute/protocol';

// The gRPC-over-HTTP/2 framing both ends of bcx need, without a framework. Copied (not imported)
// from @better-compute/gateway, which a plugin must not pull in: length-prefixed messages,
// `grpc-status` / percent-encoded `grpc-message` trailers, trailers-only errors, no compression.

/** The fully qualified bcx service (`proto/bettercompute/driver/v1/driver.proto`). */
export const DRIVER_PLUGIN_SERVICE = 'bettercompute.driver.v1.DriverPlugin';

/** gRPC status codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html). */
export const GrpcCode = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;
export type GrpcCode = (typeof GrpcCode)[keyof typeof GrpcCode];

/** A gRPC status: what a call or stream ends with. */
export class GrpcError extends Error {
  constructor(
    readonly code: GrpcCode,
    message: string,
  ) {
    super(message);
    this.name = 'GrpcError';
  }
}

/** `grpc-message` encoding: UTF-8, then every byte outside 0x20-0x7E and `%` itself as `%XX`. */
export function encodeGrpcMessage(message: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(message)) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x25) out += String.fromCharCode(byte);
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The inverse of `encodeGrpcMessage`; malformed escapes are kept verbatim. */
export function decodeGrpcMessage(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    if (char === 0x25 && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(char & 0xff);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** One length-prefixed message: flag byte 0 (uncompressed), 4-byte big-endian length, bytes. */
export function frameMessage(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.byteLength);
  new DataView(out.buffer).setUint32(1, message.byteLength);
  out.set(message, 5);
  return out;
}

/**
 * Splits a byte stream into length-prefixed messages. A compressed flag (never negotiated) or a
 * length over `maxBytes` throws a `GrpcError` before the body is buffered.
 */
export class MessageDecoder {
  private buffer = new Uint8Array(0);

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.byteLength);
    const messages: Uint8Array[] = [];
    let offset = 0;
    while (joined.byteLength - offset >= 5) {
      const flag = joined[offset]!;
      const length = new DataView(joined.buffer, joined.byteOffset + offset + 1, 4).getUint32(0);
      if (flag !== 0)
        throw new GrpcError(GrpcCode.INTERNAL, 'compressed messages are not supported');
      if (length > this.maxBytes)
        throw new GrpcError(
          GrpcCode.RESOURCE_EXHAUSTED,
          `message of ${length} bytes exceeds the limit of ${this.maxBytes}`,
        );
      if (joined.byteLength - offset - 5 < length) break;
      messages.push(joined.slice(offset + 5, offset + 5 + length));
      offset += 5 + length;
    }
    this.buffer = joined.slice(offset);
    return messages;
  }

  /** Whether a partial message is buffered (a stream that ends here was truncated). */
  get pending(): boolean {
    return this.buffer.byteLength > 0;
  }
}

/** Whether a `content-type` is gRPC with the protobuf codec. */
export function isGrpcContentType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const type = value.split(';')[0]!.trim().toLowerCase();
  return type === 'application/grpc' || type === 'application/grpc+proto';
}

/** The response headers of a gRPC call. */
export const grpcResponseHeaders = {
  ':status': 200,
  'content-type': 'application/grpc+proto',
} as const;

/** The trailers (or trailers-only headers) carrying a status. */
export function statusTrailers(code: GrpcCode, message?: string): Record<string, string> {
  const trailers: Record<string, string> = { 'grpc-status': String(code) };
  if (message) trailers['grpc-message'] = encodeGrpcMessage(message);
  return trailers;
}
