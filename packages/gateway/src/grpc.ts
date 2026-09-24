import { isComputeError, type ErrorCode } from '@better-compute/core';
import { MAX_FRAME_BYTES, ProtocolError } from '@better-compute/protocol';

// gRPC over HTTP/2 without a framework (PLAN.md §7.1). What grpc-go and connect-go check:
// `content-type: application/grpc[+proto]`, `te: trailers` on requests, length-prefixed messages,
// `grpc-status` / percent-encoded `grpc-message` trailers (status 0 on a clean end), trailers-only
// responses for immediate errors, and `grpc-timeout` tolerated. Compression is never negotiated.

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

const computeToGrpc: Partial<Record<ErrorCode, GrpcCode>> = {
  UNAUTHENTICATED: GrpcCode.UNAUTHENTICATED,
  ACCESS_DENIED: GrpcCode.PERMISSION_DENIED,
  CONFIRMATION_REQUIRED: GrpcCode.PERMISSION_DENIED,
  NOT_FOUND: GrpcCode.NOT_FOUND,
  INVALID_INPUT: GrpcCode.INVALID_ARGUMENT,
  INVALID_STATE: GrpcCode.FAILED_PRECONDITION,
  CONFLICT: GrpcCode.ABORTED,
  UNSUPPORTED: GrpcCode.UNIMPLEMENTED,
  UPGRADE_REQUIRED: GrpcCode.FAILED_PRECONDITION,
  RATE_LIMITED: GrpcCode.RESOURCE_EXHAUSTED,
  PAYLOAD_TOO_LARGE: GrpcCode.RESOURCE_EXHAUSTED,
  NOT_IMPLEMENTED: GrpcCode.UNIMPLEMENTED,
};

/**
 * The status an error ends a call with. `ComputeError` codes map by meaning, `ProtocolError`s are
 * the peer's fault (`INVALID_ARGUMENT`, or `RESOURCE_EXHAUSTED` for oversized frames), and anything
 * else is `INTERNAL` with a generic message, so internals never reach the wire.
 */
export function toGrpcError(error: unknown): GrpcError {
  if (error instanceof GrpcError) return error;
  if (isComputeError(error))
    return new GrpcError(computeToGrpc[error.code] ?? GrpcCode.INTERNAL, error.message);
  if (error instanceof ProtocolError)
    return new GrpcError(
      error.code === 'FRAME_TOO_LARGE' ? GrpcCode.RESOURCE_EXHAUSTED : GrpcCode.INVALID_ARGUMENT,
      error.message,
    );
  return new GrpcError(GrpcCode.INTERNAL, 'internal error');
}

/**
 * `grpc-message` encoding: UTF-8, then every byte outside printable ASCII (0x20-0x7E) and `%`
 * itself as `%XX`.
 */
export function encodeGrpcMessage(message: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(message)) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x25) out += String.fromCharCode(byte);
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The inverse of `encodeGrpcMessage`; malformed escapes are kept verbatim, as the spec asks. */
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
 * Splits a byte stream into length-prefixed messages. `push` returns every message completed by the
 * chunk; a compressed flag (never negotiated) or a length over `maxBytes` throws a `GrpcError`
 * before the body is buffered.
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

/** Whether a request `content-type` is gRPC with the protobuf codec. */
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
