import { ComputeError, type ErrorCode } from '@better-compute/core';
import { redactAws } from './redact.js';
import { parseXml } from './xml.js';

export interface AwsErrorInput {
  status: number;
  code?: string;
  message?: string;
  requestId?: string;
  service: string;
  retryAfter?: string | null;
}

/** The AWS error codes each ComputeError code covers (prefix and suffix rules apply on top). */
export const awsErrorCodes: Readonly<Partial<Record<ErrorCode, readonly string[]>>> = {
  RATE_LIMITED: [
    'Throttling',
    'ThrottlingException',
    'RequestLimitExceeded',
    'TooManyRequestsException',
    'SlowDown',
    'RequestThrottled',
    'PriorRequestNotComplete',
    'ProvisionedThroughputExceededException',
  ],
  CAPACITY_UNAVAILABLE: [
    'InsufficientInstanceCapacity',
    'InsufficientHostCapacity',
    'InsufficientReservedInstanceCapacity',
    'InsufficientCapacityOnOutpost',
    'ReservationCapacityExceeded',
    'InsufficientCapacity',
  ],
  QUOTA_EXCEEDED: [
    'InstanceLimitExceeded',
    'VcpuLimitExceeded',
    'MaxSpotInstanceCountExceeded',
    'VolumeLimitExceeded',
    'VpcLimitExceeded',
    'RulesPerSecurityGroupLimitExceeded',
    'SecurityGroupsPerInstanceLimitExceeded',
    'SecurityGroupsPerInterfaceLimitExceeded',
    'AddressLimitExceeded',
    'LimitExceededException',
    'ServiceQuotaExceededException',
    'ResourceLimitExceededException',
  ],
  NOT_FOUND: [
    'ResourceNotFoundException',
    'NotFoundException',
    'NoSuchKey',
    'NoSuchBucket',
    'NoSuchEntity',
  ],
  CONFLICT: [
    'IdempotentParameterMismatch',
    'ResourceExistsException',
    'AlreadyExistsException',
    'ConflictException',
    'BucketAlreadyOwnedByYou',
  ],
  INVALID_STATE: [
    'DependencyViolation',
    'IncorrectState',
    'IncorrectInstanceState',
    'InvalidStateException',
    'ResourceInUseException',
    'OperationNotPermitted',
    'InvalidInstanceState',
    'InvalidRequestException',
  ],
  ACCESS_DENIED: [
    'UnauthorizedOperation',
    'AccessDenied',
    'AccessDeniedException',
    'UnauthorizedException',
    'OptInRequired',
  ],
  UNAUTHENTICATED: [
    'AuthFailure',
    'InvalidClientTokenId',
    'SignatureDoesNotMatch',
    'IncompleteSignature',
    'MissingAuthenticationToken',
    'ExpiredToken',
    'ExpiredTokenException',
    'RequestExpired',
    'RequestTimeTooSkewed',
  ],
  UNSUPPORTED: ['UnsupportedOperation', 'Unsupported'],
  INVALID_INPUT: [
    'InvalidParameterValue',
    'InvalidParameterCombination',
    'InvalidParameter',
    'ValidationError',
    'ValidationException',
    'MissingParameter',
    'InvalidInput',
    'InvalidParameterException',
    'UnsupportedAvailabilityZoneException',
  ],
  UNAVAILABLE: [
    'InternalError',
    'InternalFailure',
    'ServiceUnavailable',
    'Unavailable',
    'ServerException',
    'ServiceUnavailableException',
    'ResourcePropagationDelayException',
  ],
};

const byCode = new Map<string, ErrorCode>();
for (const [code, names] of Object.entries(awsErrorCodes) as [ErrorCode, readonly string[]][])
  for (const name of names) byCode.set(name, code);

function classify(code: string | undefined, status: number): ErrorCode {
  if (code) {
    if (code.endsWith('.NotFound')) return 'NOT_FOUND';
    const exact = byCode.get(code);
    if (exact) return exact;
    if (code.endsWith('.Duplicate')) return 'CONFLICT';
    if (code.endsWith('.Malformed') || code.startsWith('InvalidAMIID.')) return 'INVALID_INPUT';
  }
  if (status >= 500) return 'UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

const defaultRetryAfterMs = 2000;

function retryAfterMs(value: string | null | undefined): number {
  if (!value) return defaultRetryAfterMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 600_000);
  // An HTTP-date needs a trustworthy clock to turn into a delay; the default stands in for it.
  return defaultRetryAfterMs;
}

/** A safe-to-show code: AWS codes are `[A-Za-z0-9.]`; anything else is dropped. */
const safeCode = (code: string | undefined) =>
  code && /^[A-Za-z0-9._:-]{1,128}$/.test(code) ? code : undefined;

/** Maps an AWS error to a ComputeError; the message passes through `redactAws`. */
export function mapAwsError(input: AwsErrorInput): ComputeError {
  const awsCode = safeCode(input.code);
  const code = classify(awsCode, input.status);
  const details: Record<string, unknown> = {
    provider: 'aws',
    service: input.service,
    status: input.status,
  };
  if (awsCode) details.code = awsCode;
  if (input.requestId && /^[A-Za-z0-9-]{1,128}$/.test(input.requestId))
    details.requestId = input.requestId;
  if (code === 'RATE_LIMITED') details.retryAfterMs = retryAfterMs(input.retryAfter);
  if (awsCode === 'OptInRequired') details.reason = 'region-opt-in';
  const text = (input.message ?? '').slice(0, 1024);
  const message = redactAws(
    `AWS ${input.service}: ${awsCode ?? `HTTP ${input.status}`}${text ? `: ${text}` : ''}`,
  );
  return new ComputeError(code, message, undefined, details);
}

/** `com.amazon.coral.service#ThrottlingException:http://…` → `ThrottlingException`. */
function jsonType(value: string): string {
  const afterHash = value.includes('#') ? value.slice(value.lastIndexOf('#') + 1) : value;
  return afterHash.split(':')[0]!.trim();
}

/** Reads the code, message and request id from an EC2, awsQuery, JSON, rest-json or rest-xml error body. */
export function parseAwsError(
  protocol: 'ec2' | 'query' | 'json' | 'rest-json' | 'rest-xml',
  status: number,
  headers: Headers,
  body: string,
): Omit<AwsErrorInput, 'service'> {
  const out: Omit<AwsErrorInput, 'service'> = {
    status,
    retryAfter: headers.get('retry-after'),
  };
  const headerRequestId =
    headers.get('x-amzn-requestid') ?? headers.get('x-amz-request-id') ?? undefined;
  if (headerRequestId) out.requestId = headerRequestId;
  if (protocol === 'json' || protocol === 'rest-json') {
    const headerType = headers.get('x-amzn-errortype');
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(body) as unknown;
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      // Not JSON (a proxy page): the status decides.
    }
    const type =
      (headerType ? jsonType(headerType) : undefined) ??
      (typeof parsed.__type === 'string' ? jsonType(parsed.__type) : undefined) ??
      (typeof parsed.code === 'string' ? parsed.code : undefined);
    if (type) out.code = type;
    const message = parsed.message ?? parsed.Message;
    if (typeof message === 'string') out.message = message;
    return out;
  }
  if (body.trim() === '') return out;
  try {
    const doc = parseXml(body, { maxBytes: 1024 * 1024 });
    // EC2: <Response><Errors><Error><Code/><Message/></Error></Errors><RequestID/></Response>
    // awsQuery: <ErrorResponse><Error><Type/><Code/><Message/></Error><RequestId/></ErrorResponse>
    // rest-xml (S3): <Error><Code/><Message/><RequestId/></Error>
    const error =
      doc.name === 'Error'
        ? doc
        : (doc.child('Errors')?.child('Error') ?? doc.child('Error') ?? undefined);
    if (error) {
      const code = error.textOf('Code');
      if (code) out.code = code;
      const message = error.textOf('Message');
      if (message) out.message = message;
    }
    const requestId =
      doc.textOf('RequestID') ?? doc.textOf('RequestId') ?? error?.textOf('RequestId');
    if (requestId) out.requestId = requestId;
  } catch {
    // Not XML: the status decides.
  }
  return out;
}
