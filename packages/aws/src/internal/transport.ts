// A private, minimal AWS transport: endpoints, signed fetch with one skew/expired-token retry, AWS
// error mapping and redaction, and the JSON and awsQuery protocol clients. It mirrors the shapes
// A0 Task 3-4 give aws-core (`jsonClient`, `queryClient`, `mapAwsError`, `redactAws`,
// `CredentialSource`), so the imports can move to aws-core once it ships them. Not exported.
import { ComputeError, systemClock, type Clock, type Logger } from '@better-compute/core';
import { parseXml, serializeAwsQuery, type QueryParams, type XmlElement } from '@better-compute/aws-core';
import { presignUrl, signRequest, type AwsCredentials } from './sigv4.js';

export type { AwsCredentials } from './sigv4.js';

export interface CredentialContext {
  signal: AbortSignal;
  clock: Clock;
}
/** Where request credentials come from (aws-core's ambient chain, a static secret, a test stub). */
export interface CredentialSource {
  readonly kind: string;
  credentials(context: CredentialContext): Promise<AwsCredentials>;
  invalidate?(): void;
}

export interface TransportOptions {
  region: string;
  credentials: CredentialSource;
  fetch?: typeof fetch;
  /** Base URL override (tests, VPC endpoints): `http(s)://host[:port]`. Host option only. */
  endpoint?: string;
  clock?: Clock;
  log?: Logger;
  /** Default 20_000. */
  timeoutMs?: number;
}

const regionPattern =
  /^(us|eu|ap|sa|ca|me|af|il|mx|cn)(-gov)?-(north|south|east|west|central|northeast|northwest|southeast|southwest)-\d{1,2}$/;

/** Returns the region or throws INVALID_CONFIG; the only path from config text to a host name. */
export function assertRegion(region: string): string {
  if (typeof region !== 'string' || !regionPattern.test(region))
    throw new ComputeError('INVALID_CONFIG', 'not an AWS region name', undefined, { region: String(region).slice(0, 40) });
  return region;
}

function dnsSuffix(region: string): string {
  return region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
}

/** `https://<hostPrefix>.<region>.<suffix>`, or the override (validated as an http(s) origin). */
export function serviceEndpoint(hostPrefix: string, region: string, override?: string): URL {
  if (override !== undefined) {
    let url: URL;
    try {
      url = new URL(override);
    } catch {
      throw new ComputeError('INVALID_CONFIG', 'the AWS endpoint override is not a URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new ComputeError('INVALID_CONFIG', 'the AWS endpoint override must be http(s)');
    return new URL(url.origin);
  }
  return new URL(`https://${hostPrefix}.${assertRegion(region)}.${dnsSuffix(region)}`);
}

// --- Errors ---------------------------------------------------------------------------------------

/** Removes access key ids, secrets, session tokens and signatures from text. */
export function redactAws(text: string): string {
  return text
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g, '$1[redacted]')
    .replace(/(X-Amz-(?:Signature|Security-Token|Credential)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(Signature=)[0-9a-f]{16,}/gi, '$1[redacted]')
    .replace(/("(?:SecretAccessKey|SessionToken|Token|SecretString|Plaintext)"\s*:\s*")[^"]*"/g, '$1[redacted]"');
}

const codeGroups: [RegExp, ComputeError['code']][] = [
  [
    /^(Throttling|ThrottlingException|RequestLimitExceeded|TooManyRequestsException|SlowDown|RequestThrottled|PriorRequestNotComplete|ProvisionedThroughputExceededException|ThrottledException|KMSThrottlingException)$/,
    'RATE_LIMITED',
  ],
  [/\.NotFound$|^(ResourceNotFoundException|NotFoundException|NoSuchKey|NoSuchBucket|NoSuchEntity|NoSuchUpload|ParameterNotFound|NotFound|QueueDoesNotExist|AWS\.SimpleQueueService\.NonExistentQueue)$/, 'NOT_FOUND'],
  [/^(LimitExceededException|ServiceQuotaExceededException|ParameterLimitExceeded|TooManyEntriesInBatchRequest)$/, 'QUOTA_EXCEEDED'],
  [/\.Duplicate$|^(IdempotentParameterMismatch|ResourceExistsException|AlreadyExistsException|ConflictException|BucketAlreadyOwnedByYou|ParameterAlreadyExists|IdempotentParameterMismatchException)$/, 'CONFLICT'],
  [/^(DependencyViolation|IncorrectState|InvalidStateException|ResourceInUseException|OperationNotPermitted|KMSInvalidStateException|DisabledException|RequestInProgressException|RequestFailedException|InvalidRequestException)$/, 'INVALID_STATE'],
  [/^(UnauthorizedOperation|AccessDenied|AccessDeniedException|UnauthorizedException|AuthorizationError|KMSAccessDeniedException|InvalidCiphertextException|IncorrectKeyException)$/, 'ACCESS_DENIED'],
  [/^(AuthFailure|InvalidClientTokenId|SignatureDoesNotMatch|IncompleteSignature|MissingAuthenticationToken|ExpiredToken|ExpiredTokenException|RequestExpired|RequestTimeTooSkewed|InvalidSignatureException|UnrecognizedClientException)$/, 'UNAUTHENTICATED'],
  [/^(UnsupportedOperation|Unsupported|NotImplemented)$/, 'UNSUPPORTED'],
  [/\.Malformed$|^(InvalidParameterValue|InvalidParameterCombination|InvalidParameter|InvalidParameterException|ValidationError|ValidationException|MissingParameter|InvalidInput|InvalidArgument|InvalidRequest|MalformedXML|EntityTooLarge|InvalidPart|InvalidPartOrder|InvalidKeyUsageException|MalformedPolicyDocumentException|MalformedCSRException|InvalidArnException|InvalidArgsException)$/, 'INVALID_INPUT'],
  [/^(InternalError|InternalFailure|InternalServiceError|ServiceUnavailable|Unavailable|InternalServerError|KMSInternalException|DependencyTimeoutException|InternalFailureException)$/, 'UNAVAILABLE'],
];

export interface AwsErrorInput {
  status: number;
  code?: string;
  message?: string;
  requestId?: string;
  service: string;
  operation?: string;
  retryAfter?: string | null;
}

export function mapAwsError(input: AwsErrorInput): ComputeError {
  const code = input.code ?? '';
  let mapped: ComputeError['code'] | undefined;
  for (const [pattern, target] of codeGroups)
    if (pattern.test(code)) {
      mapped = target;
      break;
    }
  if (!mapped)
    mapped = input.status >= 500 ? 'UNAVAILABLE' : input.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR';
  const details: Record<string, unknown> = {
    provider: 'aws',
    service: input.service,
    status: input.status,
    code: code || undefined,
    requestId: input.requestId,
  };
  if (mapped === 'RATE_LIMITED') {
    const seconds = Number(input.retryAfter);
    details.retryAfterMs = Number.isFinite(seconds) && seconds >= 0 && input.retryAfter ? seconds * 1000 : 2000;
  }
  const what = input.operation ? `${input.service} ${input.operation}` : input.service;
  const message = redactAws(input.message ?? code ?? `HTTP ${input.status}`).slice(0, 500);
  return new ComputeError(mapped, `AWS ${what} failed: ${message || `HTTP ${input.status}`}`, undefined, details);
}

export type Protocol = 'json' | 'query' | 'rest-xml';

/** Reads the code, message and request id from a JSON, awsQuery or rest-xml (S3) error body. */
export function parseAwsError(
  protocol: Protocol,
  status: number,
  headers: Headers,
  body: string,
): Omit<AwsErrorInput, 'service'> {
  const requestId =
    headers.get('x-amzn-requestid') ?? headers.get('x-amz-request-id') ?? undefined;
  const retryAfter = headers.get('retry-after');
  if (protocol === 'json') {
    let code = headers.get('x-amzn-errortype') ?? undefined;
    let message: string | undefined;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed.__type === 'string') code = parsed.__type;
      const text = parsed.message ?? parsed.Message;
      if (typeof text === 'string') message = text;
    } catch {
      /* not JSON */
    }
    if (code) code = code.split(':')[0]!.split('#').at(-1);
    return { status, code, message, requestId, retryAfter };
  }
  try {
    const root = parseXml(body, { maxBytes: 1024 * 1024 });
    const error = root.name === 'Error' ? root : (root.child('Error') ?? root.child('Errors')?.child('Error'));
    return {
      status,
      code: error?.textOf('Code'),
      message: error?.textOf('Message'),
      requestId: requestId ?? root.textOf('RequestId') ?? error?.textOf('RequestId'),
      retryAfter,
    };
  } catch {
    return { status, requestId, retryAfter };
  }
}

// --- Signed requests ------------------------------------------------------------------------------

export interface SendInput {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  url: URL;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array | string;
  /** Signing name. */
  service: string;
  /** For logs and errors. */
  operation: string;
  protocol: Protocol;
  /** S3 rules: single path encoding and x-amz-content-sha256. */
  s3?: boolean;
  unsignedPayload?: boolean;
  /** Statuses that are not errors (S3: 404 on GET/DELETE). */
  accept?: readonly number[];
  signal?: AbortSignal;
}

export interface Transport {
  readonly region: string;
  readonly clock: Clock;
  readonly log?: Logger;
  readonly endpointOverride?: string;
  credentials(signal?: AbortSignal): Promise<AwsCredentials>;
  /** Signs, sends and maps errors. A non-error response is returned unread. */
  send(input: SendInput): Promise<Response>;
  /** A presigned URL for `url` (time = clock.now()). */
  presign(input: {
    method: string;
    url: URL;
    service: string;
    expiresInSeconds: number;
    headers?: Readonly<Record<string, string>>;
    s3?: boolean;
    signal?: AbortSignal;
    /** Signing time (epoch ms) instead of the clock: a stable URL within a window. */
    at?: number;
  }): Promise<string>;
}

const skewCodes = new Set(['RequestTimeTooSkewed', 'RequestExpired']);
const expiredTokenCodes = new Set(['ExpiredToken', 'ExpiredTokenException']);

export function createTransport(options: TransportOptions): Transport {
  const region = assertRegion(options.region);
  const clock = options.clock ?? systemClock;
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (options.endpoint !== undefined) serviceEndpoint('x', region, options.endpoint);
  let skewMs = 0;

  async function credentials(signal?: AbortSignal): Promise<AwsCredentials> {
    return options.credentials.credentials({ signal: signal ?? new AbortController().signal, clock });
  }

  async function attempt(input: SendInput, creds: AwsCredentials): Promise<Response> {
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    const signed = signRequest({
      method: input.method,
      url: input.url,
      headers,
      body: input.body,
      service: input.service,
      region,
      credentials: creds,
      now: clock.now() + skewMs,
      contentSha256Header: input.s3,
      unsignedPayload: input.unsignedPayload,
      normalizePath: !input.s3,
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      return await fetcher(input.url, {
        method: input.method,
        headers: { ...headers, ...signed },
        body:
          input.body === undefined || input.method === 'GET' || input.method === 'HEAD'
            ? undefined
            : (input.body as BodyInit),
        signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const timedOut = timeout.aborted;
      throw new ComputeError(
        'UNAVAILABLE',
        `AWS ${input.service} ${input.operation} failed: ${timedOut ? 'timed out' : 'network error'}`,
        undefined,
        { provider: 'aws', service: input.service, reason: timedOut ? 'timeout' : 'network' },
      );
    }
  }

  async function send(input: SendInput): Promise<Response> {
    const started = clock.now();
    let creds = await credentials(input.signal);
    let retriedSkew = false;
    let retriedToken = false;
    for (;;) {
      const response = await attempt(input, creds);
      const accepted = response.ok || (input.accept?.includes(response.status) ?? false);
      if (accepted) {
        options.log?.debug('aws request', {
          service: input.service,
          operation: input.operation,
          status: response.status,
          requestId: response.headers.get('x-amzn-requestid') ?? response.headers.get('x-amz-request-id') ?? undefined,
          ms: clock.now() - started,
        });
        return response;
      }
      const text = input.method === 'HEAD' ? '' : await response.text().catch(() => '');
      const parsed = parseAwsError(input.protocol, response.status, response.headers, text);
      const code = parsed.code ?? '';
      const skewed =
        skewCodes.has(code) ||
        (code === 'InvalidSignatureException' && /expired/i.test(parsed.message ?? ''));
      if (skewed && !retriedSkew) {
        const serverDate = Date.parse(response.headers.get('date') ?? '');
        if (Number.isFinite(serverDate)) {
          skewMs = serverDate - clock.now();
          retriedSkew = true;
          continue;
        }
      }
      if (expiredTokenCodes.has(code) && !retriedToken && options.credentials.invalidate) {
        options.credentials.invalidate();
        creds = await credentials(input.signal);
        retriedToken = true;
        continue;
      }
      options.log?.debug('aws request failed', {
        service: input.service,
        operation: input.operation,
        status: response.status,
        code: code || undefined,
        requestId: parsed.requestId,
        ms: clock.now() - started,
      });
      throw mapAwsError({ ...parsed, service: input.service, operation: input.operation });
    }
  }

  async function presign(input: Parameters<Transport['presign']>[0]): Promise<string> {
    const creds = await credentials(input.signal);
    return presignUrl({
      method: input.method,
      url: input.url,
      headers: input.headers ?? {},
      service: input.service,
      region,
      credentials: creds,
      now: (input.at ?? clock.now()) + skewMs,
      unsignedPayload: input.s3,
      normalizePath: !input.s3,
      expiresInSeconds: input.expiresInSeconds,
    });
  }

  return { region, clock, log: options.log, endpointOverride: options.endpoint, credentials, send, presign };
}

// --- Protocol clients -----------------------------------------------------------------------------

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface JsonClient {
  call<T = Record<string, unknown>>(
    operation: string,
    body: Readonly<Record<string, unknown>>,
    options?: RequestOptions,
  ): Promise<T>;
}

/** awsJson 1.0/1.1: POST / with X-Amz-Target `<targetPrefix>.<operation>`. */
export function jsonClient(
  transport: Transport,
  options: { hostPrefix: string; signingName?: string; jsonVersion: '1.0' | '1.1'; targetPrefix: string },
): JsonClient {
  const url = serviceEndpoint(options.hostPrefix, transport.region, transport.endpointOverride);
  return {
    async call<T>(operation: string, body: Readonly<Record<string, unknown>>, request: RequestOptions = {}) {
      const response = await transport.send({
        method: 'POST',
        url,
        headers: {
          'content-type': `application/x-amz-json-${options.jsonVersion}`,
          'x-amz-target': `${options.targetPrefix}.${operation}`,
        },
        body: JSON.stringify(body),
        service: options.signingName ?? options.hostPrefix,
        operation,
        protocol: 'json',
        signal: request.signal,
      });
      const text = await response.text();
      if (text.trim() === '') return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ComputeError('PROVIDER_ERROR', `AWS ${options.hostPrefix} ${operation} returned malformed JSON`);
      }
    },
  };
}

export interface QueryClient {
  call(action: string, params: QueryParams, options?: RequestOptions): Promise<XmlElement>;
}

/** awsQuery: a signed form POST; the response is parsed XML. */
export function queryClient(
  transport: Transport,
  options: { hostPrefix: string; signingName?: string; version: string },
): QueryClient {
  const url = serviceEndpoint(options.hostPrefix, transport.region, transport.endpointOverride);
  return {
    async call(action, params, request = {}) {
      const response = await transport.send({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: serializeAwsQuery(action, options.version, params),
        service: options.signingName ?? options.hostPrefix,
        operation: action,
        protocol: 'query',
        signal: request.signal,
      });
      return parseXml(await response.text());
    },
  };
}
