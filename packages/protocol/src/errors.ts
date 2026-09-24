/** Error codes raised by the protocol helpers (never by generated code). */
export type ProtocolErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'INVALID_FRAME'
  | 'UNKNOWN_KIND'
  | 'PAYLOAD_MISMATCH'
  | 'UNKNOWN_SECTION'
  | 'INVALID_SIGNING_INPUT';

/**
 * A malformed, oversized or mistyped wire value. This package has no dependency on
 * `@better-compute/core`, so callers map it (e.g. to `ComputeError('INVALID_INPUT')` or a gRPC
 * status) at their boundary.
 */
export class ProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
