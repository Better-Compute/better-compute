import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputeError, manualClock, type ErrorCode } from '@better-compute/core';
import {
  ec2Client,
  jsonClient,
  mapAwsError,
  paginate,
  parseAwsError,
  queryClient,
  redactAws,
  restClient,
  type CredentialSource,
} from '@better-compute/aws-core';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { ec2Error, ec2Response, jsonError, queryResponse } from './support/aws-emulator/xml.js';

const stub: CredentialSource = {
  kind: 'test',
  credentials: async () => ({ accessKeyId: 'AKIATESTKEY0000000001', secretAccessKey: 'testsecret' }),
};
const signal = new AbortController().signal;

function world() {
  const emu = new AwsEmulator();
  const answers: Response[] = [];
  emu.register(/^ec2\./, {
    service: 'ec2',
    protocol: 'ec2',
    handle: (request) =>
      answers.shift() ??
      ec2Response(
        request.operation,
        `<echo>${request.params.get('Filter.1.Name') ?? ''}</echo>`,
      ),
  });
  const ec2 = ec2Client({ region: 'us-east-1', credentials: stub, fetch: emu.fetch, clock: emu.clock });
  return { emu, ec2, answers };
}

async function failure(run: () => Promise<unknown>): Promise<ComputeError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputeError);
    return error as ComputeError;
  }
  throw new Error('expected a failure');
}

const table: [string, ErrorCode][] = [
  ['Throttling', 'RATE_LIMITED'],
  ['RequestLimitExceeded', 'RATE_LIMITED'],
  ['SlowDown', 'RATE_LIMITED'],
  ['InsufficientInstanceCapacity', 'CAPACITY_UNAVAILABLE'],
  ['InsufficientCapacityOnOutpost', 'CAPACITY_UNAVAILABLE'],
  ['InstanceLimitExceeded', 'QUOTA_EXCEEDED'],
  ['VcpuLimitExceeded', 'QUOTA_EXCEEDED'],
  ['ServiceQuotaExceededException', 'QUOTA_EXCEEDED'],
  ['InvalidInstanceID.NotFound', 'NOT_FOUND'],
  ['InvalidAMIID.NotFound', 'NOT_FOUND'],
  ['NoSuchEntity', 'NOT_FOUND'],
  ['IdempotentParameterMismatch', 'CONFLICT'],
  ['InvalidGroup.Duplicate', 'CONFLICT'],
  ['DependencyViolation', 'INVALID_STATE'],
  ['IncorrectInstanceState', 'INVALID_STATE'],
  ['OperationNotPermitted', 'INVALID_STATE'],
  ['UnauthorizedOperation', 'ACCESS_DENIED'],
  ['OptInRequired', 'ACCESS_DENIED'],
  ['AuthFailure', 'UNAUTHENTICATED'],
  ['SignatureDoesNotMatch', 'UNAUTHENTICATED'],
  ['UnsupportedOperation', 'UNSUPPORTED'],
  ['InvalidInstanceID.Malformed', 'INVALID_INPUT'],
  ['InvalidParameterValue', 'INVALID_INPUT'],
  ['InvalidAMIID.Unavailable', 'INVALID_INPUT'],
  ['MissingParameter', 'INVALID_INPUT'],
  ['InternalError', 'UNAVAILABLE'],
  ['Unavailable', 'UNAVAILABLE'],
  ['SomethingNew', 'PROVIDER_ERROR'],
];

afterEach(() => {
  vi.useRealTimers();
});

describe('aws-core clients', () => {
  it('ec2 client posts a signed form and returns the parsed body', async () => {
    const { emu, ec2 } = world();
    const doc = await ec2.call(
      'DescribeInstances',
      { Filter: [{ Name: 'tag:a', Value: ['x'] }] },
      { signal },
    );
    expect(doc.name).toBe('DescribeInstancesResponse');
    expect(doc.textOf('echo')).toBe('tag:a');
    const [request] = emu.requests;
    expect(request!.method).toBe('POST');
    expect(request!.params.get('Version')).toBe('2016-11-15');
    expect(request!.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    expect(request!.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY0000000001\/\d{8}\/us-east-1\/ec2\/aws4_request/,
    );
  });

  it.each(table)('maps every code in the error table: %s', async (awsCode, code) => {
    const { ec2, answers } = world();
    answers.push(ec2Error(awsCode, 'nope', awsCode === 'InternalError' ? 500 : 400));
    const error = await failure(() => ec2.call('DescribeInstances', {}, { signal }));
    expect(error.code).toBe(code);
    expect(error.details?.code).toBe(awsCode);
    expect(error.details?.provider).toBe('aws');
    if (awsCode === 'OptInRequired') expect(error.details?.reason).toBe('region-opt-in');
  });

  it('maps a bare 5xx to UNAVAILABLE', () => {
    expect(mapAwsError({ status: 503, service: 'ec2' }).code).toBe('UNAVAILABLE');
    expect(mapAwsError({ status: 418, service: 'ec2' }).code).toBe('PROVIDER_ERROR');
  });

  it('parses JSON errors from __type and x-amzn-ErrorType', () => {
    const fromBody = parseAwsError(
      'json',
      400,
      new Headers(),
      '{"__type":"com.amazon.coral.service#ThrottlingException","message":"slow down"}',
    );
    expect(fromBody.code).toBe('ThrottlingException');
    expect(mapAwsError({ ...fromBody, service: 'ssm' }).code).toBe('RATE_LIMITED');
    const fromHeader = parseAwsError(
      'rest-json',
      404,
      new Headers({ 'x-amzn-ErrorType': 'ResourceNotFoundException:http://internal.amazon.com/' }),
      '{}',
    );
    expect(fromHeader.code).toBe('ResourceNotFoundException');
  });

  it('parses rest-xml errors', () => {
    const parsed = parseAwsError(
      'rest-xml',
      404,
      new Headers(),
      '<Error><Code>NoSuchKey</Code><Message>gone</Message><RequestId>REQ1</RequestId></Error>',
    );
    expect(parsed).toMatchObject({ code: 'NoSuchKey', message: 'gone', requestId: 'REQ1' });
    expect(mapAwsError({ ...parsed, service: 's3' }).code).toBe('NOT_FOUND');
  });

  it('RATE_LIMITED carries retryAfterMs from Retry-After', async () => {
    const { ec2, answers } = world();
    const throttled = ec2Error('Throttling', 'slow');
    throttled.headers.set('retry-after', '7');
    answers.push(throttled);
    const error = await failure(() => ec2.call('DescribeInstances', {}, { signal }));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(7000);
    expect(mapAwsError({ status: 400, code: 'Throttling', service: 'ec2' }).retryAfterMs).toBe(2000);
  });

  it('retries once on clock skew with the server offset', async () => {
    const { emu, ec2 } = world();
    emu.skewMs = 20 * 60_000;
    await ec2.call('DescribeInstances', {}, { signal });
    expect(emu.requests).toHaveLength(2);
    const second = emu.requests[1]!.headers.get('x-amz-date')!;
    const first = emu.requests[0]!.headers.get('x-amz-date')!;
    expect(second).not.toBe(first);
  });

  it('does not retry twice on skew', async () => {
    const { emu, ec2 } = world();
    emu.skewMs = 20 * 60_000;
    // The server's Date header lies by the same amount again after the first correction.
    const original = emu.fetch;
    let count = 0;
    const lying: typeof fetch = async (input, init) => {
      const response = await original(input, init);
      count += 1;
      emu.skewMs += 20 * 60_000;
      return response;
    };
    const client = ec2Client({ region: 'us-east-1', credentials: stub, fetch: lying, clock: emu.clock });
    const error = await failure(() => client.call('DescribeInstances', {}, { signal }));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(count).toBe(2);
  });

  it('refreshes once on ExpiredToken', async () => {
    const { emu } = world();
    const invalidate = vi.fn();
    const source: CredentialSource = { ...stub, invalidate };
    const client = ec2Client({ region: 'us-east-1', credentials: source, fetch: emu.fetch, clock: emu.clock });
    emu.failNext('DescribeInstances', 'ExpiredToken', 400);
    await client.call('DescribeInstances', {}, { signal });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(emu.requests).toHaveLength(2);
    emu.failNext('DescribeInstances', 'ExpiredToken', 400, 2);
    const error = await failure(() => client.call('DescribeInstances', {}, { signal }));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('times out as UNAVAILABLE with reason timeout', async () => {
    vi.useFakeTimers();
    const never: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const client = ec2Client({
      region: 'us-east-1',
      credentials: stub,
      fetch: never,
      clock: manualClock(Date.UTC(2026, 9, 1)),
      timeoutMs: 50,
    });
    const pending = failure(() => client.call('DescribeInstances', {}, { signal }));
    await vi.advanceTimersByTimeAsync(60);
    const error = await pending;
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.details?.reason).toBe('timeout');
  });

  it('reports a network failure as UNAVAILABLE', async () => {
    const broken: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const client = ec2Client({ region: 'us-east-1', credentials: stub, fetch: broken });
    const error = await failure(() => client.call('DescribeInstances', {}, { signal }));
    expect(error.details?.reason).toBe('network');
  });

  it('rate limiter spaces requests', async () => {
    const { emu } = world();
    const sleeps: number[] = [];
    const client = ec2Client({
      region: 'us-east-1',
      credentials: stub,
      fetch: emu.fetch,
      clock: emu.clock,
      rateLimit: { perSecond: 2, burst: 1 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client.call('DescribeInstances', {}, { signal });
    expect(sleeps).toEqual([]);
    await client.call('DescribeInstances', {}, { signal });
    await client.call('DescribeInstances', {}, { signal });
    expect(sleeps).toEqual([500, 1000]);
    emu.clock.advance(10_000);
    await client.call('DescribeInstances', {}, { signal });
    expect(sleeps).toHaveLength(2);
  });

  it('query client returns the Result element; json client sends the target', async () => {
    const emu = new AwsEmulator();
    emu.register(/^sts\./, {
      service: 'sts',
      protocol: 'query',
      handle: (request) =>
        queryResponse(request.operation, 'https://sts.amazonaws.com/doc/2011-06-15/', '<Account>111111111111</Account>'),
    });
    emu.register(/^ssm\./, {
      service: 'ssm',
      protocol: 'json',
      handle: (request) =>
        request.operation === 'GetParameter'
          ? new Response(JSON.stringify({ Parameter: { Value: request.headers.get('x-amz-target') } }))
          : jsonError('ValidationException', 'bad'),
    });
    const sts = queryClient({
      service: 'sts',
      version: '2011-06-15',
      region: 'eu-west-1',
      credentials: stub,
      fetch: emu.fetch,
      clock: emu.clock,
    });
    const result = await sts.call('GetCallerIdentity', {}, { signal });
    expect(result.name).toBe('GetCallerIdentityResult');
    expect(result.textOf('Account')).toBe('111111111111');
    const ssm = jsonClient({
      service: 'ssm',
      region: 'eu-west-1',
      credentials: stub,
      fetch: emu.fetch,
      clock: emu.clock,
      jsonVersion: '1.1',
      targetPrefix: 'AmazonSSM',
    });
    const value = await ssm.call<{ Parameter: { Value: string } }>('GetParameter', { Name: 'x' }, { signal });
    expect(value.Parameter.Value).toBe('AmazonSSM.GetParameter');
    expect(emu.requests[1]!.headers.get('content-type')).toBe('application/x-amz-json-1.1');
    const error = await failure(() => ssm.call('PutParameter', {}, { signal }));
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('rest client signs S3 requests without normalizing the path', async () => {
    const emu = new AwsEmulator();
    emu.register(/^s3\./, {
      service: 's3',
      protocol: 'rest',
      handle: (request) => new Response(request.url.pathname, { status: 200 }),
    });
    const s3 = restClient({
      service: 's3',
      region: 'us-east-1',
      credentials: stub,
      fetch: emu.fetch,
      clock: emu.clock,
      s3: true,
    });
    const response = await s3.request('PUT', '/bucket/a//b', {
      signal,
      body: 'data',
      protocol: 'rest-xml',
    });
    expect(new TextDecoder().decode(response.body)).toBe('/bucket/a//b');
    expect(emu.requests[0]!.headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('paginate follows tokens and stops on a repeated token', async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      start: { items: [1, 2], next: 'a' },
      a: { items: [3], next: 'b' },
      b: { items: [4] },
    };
    const all: number[] = [];
    for await (const item of paginate(async (token) => pages[token ?? 'start']!)) all.push(item);
    expect(all).toEqual([1, 2, 3, 4]);
    const looping = paginate(async (token) => ({ items: [token], next: 'same' }));
    const error = await failure(async () => {
      for await (const _ of looping) void _;
    });
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details?.reason).toBe('pagination-loop');
  });

  it('redactAws removes keys, secrets, tokens and signatures', () => {
    const text = [
      'key AKIAIOSFODNN7EXAMPLE and ASIAXXXXXXXXXXXXXXXX',
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
      'https://x/?X-Amz-Signature=abcdef0123&X-Amz-Security-Token=FQoGZXIvYXdzE%2Fsecret&X-Amz-Credential=AKID%2F2015',
      '{"SecretAccessKey":"wJalrXUtnFEMI","Token":"IQoJb3JpZ2luX2Vj","AccessKeyId":"AKIA"}',
      '<SessionToken>FwoGZXIvYXdzEBYaDtoken</SessionToken><SecretAccessKey>sekrit</SecretAccessKey>',
    ].join('\n');
    const redacted = redactAws(text);
    for (const secret of [
      'AKIAIOSFODNN7EXAMPLE',
      'ASIAXXXXXXXXXXXXXXXX',
      '5fa00fa3',
      'abcdef0123',
      'FQoGZXIvYXdzE',
      'wJalrXUtnFEMI',
      'IQoJb3JpZ2luX2Vj',
      'FwoGZXIvYXdzEBYaDtoken',
      'sekrit',
      'AKIDEXAMPLE',
    ])
      expect(redacted).not.toContain(secret);
  });
});
