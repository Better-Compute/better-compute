import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputeError, manualClock, type ErrorCode } from '@better-compute/core';
import {
  cachedCredentials,
  ec2Client,
  jsonClient,
  mapAwsError,
  paginate,
  parseAwsError,
  queryClient,
  redactAws,
  restClient,
  staticCredentials,
  type CredentialSource,
} from '@better-compute/aws-core';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { ec2Error, ec2Response, jsonError, queryResponse } from './support/aws-emulator/xml.js';

const stub: CredentialSource = {
  kind: 'test',
  credentials: async () => ({
    accessKeyId: 'AKIATESTKEY0000000001',
    secretAccessKey: 'testsecret',
  }),
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
      ec2Response(request.operation, `<echo>${request.params.get('Filter.1.Name') ?? ''}</echo>`),
  });
  const ec2 = ec2Client({
    region: 'us-east-1',
    credentials: stub,
    fetch: emu.fetch,
    clock: emu.clock,
  });
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
  // EC2 resource quotas: never PROVIDER_ERROR, which a reconciler retries forever.
  ['SecurityGroupLimitExceeded', 'QUOTA_EXCEEDED'],
  ['RulesPerSecurityGroupLimitExceeded', 'QUOTA_EXCEEDED'],
  ['CidrLimitExceeded', 'QUOTA_EXCEEDED'],
  ['NetworkAclEntryLimitExceeded', 'QUOTA_EXCEEDED'],
  ['TagLimitExceeded', 'QUOTA_EXCEEDED'],
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
    expect(mapAwsError({ status: 400, code: 'Throttling', service: 'ec2' }).retryAfterMs).toBe(
      2000,
    );
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
    const client = ec2Client({
      region: 'us-east-1',
      credentials: stub,
      fetch: lying,
      clock: emu.clock,
    });
    const error = await failure(() => client.call('DescribeInstances', {}, { signal }));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(count).toBe(2);
  });

  it('refreshes once on ExpiredToken', async () => {
    const { emu } = world();
    const invalidate = vi.fn();
    const source: CredentialSource = { ...stub, invalidate };
    const client = ec2Client({
      region: 'us-east-1',
      credentials: source,
      fetch: emu.fetch,
      clock: emu.clock,
    });
    emu.failNext('DescribeInstances', 'ExpiredToken', 400);
    await client.call('DescribeInstances', {}, { signal });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(emu.requests).toHaveLength(2);
    emu.failNext('DescribeInstances', 'ExpiredToken', 400, 2);
    const error = await failure(() => client.call('DescribeInstances', {}, { signal }));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  /** An EC2 endpoint that accepts one access key id and answers `code` to any other. */
  function keyed(code: string) {
    const state = { active: '', requests: 0 };
    const fetchImpl = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      state.requests += 1;
      const accepted = (init.headers.authorization ?? '').includes(state.active);
      return new Response(
        accepted
          ? '<DescribeRegionsResponse><requestId>r</requestId></DescribeRegionsResponse>'
          : `<?xml version="1.0"?><Response><Errors><Error><Code>${code}</Code><Message>no</Message></Error></Errors><RequestID>r</RequestID></Response>`,
        { status: accepted ? 200 : 401, headers: { date: new Date().toUTCString() } },
      );
    }) as unknown as typeof fetch;
    return { state, fetchImpl };
  }

  it.each(['AuthFailure', 'InvalidClientTokenId', 'UnrecognizedClientException'])(
    'reads a static key rotated in place again on %s, once',
    async (code) => {
      let secret = { accessKeyId: 'AKIAOLDOLDOLDOLDOLD1', secretAccessKey: 'old' };
      let loads = 0;
      const source = cachedCredentials(
        staticCredentials(async () => {
          loads += 1;
          return JSON.stringify(secret);
        }),
      );
      const { state, fetchImpl } = keyed(code);
      state.active = secret.accessKeyId;
      const ec2 = ec2Client({ region: 'us-east-1', credentials: source, fetch: fetchImpl });
      await ec2.call('DescribeRegions', {}, { signal });
      expect([loads, state.requests]).toEqual([1, 1]);
      // The operator rotates the secret in place and deactivates the old key.
      secret = { accessKeyId: 'AKIANEWNEWNEWNEWNEW1', secretAccessKey: 'new' };
      state.active = secret.accessKeyId;
      await ec2.call('DescribeRegions', {}, { signal });
      await ec2.call('DescribeRegions', {}, { signal });
      // One refused request, one re-read, then the new key for good.
      expect([loads, state.requests]).toEqual([2, 4]);
      // A key that is simply wrong is re-read once per call and not sent again.
      state.active = 'AKIAOTHEROTHEROTHER1';
      const error = await failure(() => ec2.call('DescribeRegions', {}, { signal }));
      expect(error.code).toBe('UNAUTHENTICATED');
      expect([loads, state.requests]).toEqual([3, 5]);
    },
  );

  it('a refused key is retried once even when every read gives another key', async () => {
    let minted = 0;
    const source = cachedCredentials({
      kind: 'test',
      credentials: async () => ({
        accessKeyId: `AKIAMINTED${String((minted += 1)).padStart(10, '0')}`,
        secretAccessKey: 'secret',
      }),
    });
    const { state, fetchImpl } = keyed('AuthFailure');
    state.active = 'AKIANEVERNEVERNEVER1';
    const ec2 = ec2Client({ region: 'us-east-1', credentials: source, fetch: fetchImpl });
    const error = await failure(() => ec2.call('DescribeRegions', {}, { signal }));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect([minted, state.requests]).toEqual([2, 2]);
    // Nothing of the key reaches the error.
    expect(JSON.stringify([error.message, error.details])).not.toMatch(/AKIA|secret/);
  });

  /** A source of temporary credentials that mints the next generation after each invalidate. */
  function sessions() {
    const state = { minted: 0, invalidated: 0 };
    const source = cachedCredentials({
      kind: 'test',
      credentials: async () => ({
        accessKeyId: `ASIAGEN${(state.minted += 1)}XXXXXXXXXXXX`,
        secretAccessKey: 's',
        sessionToken: 't',
      }),
      invalidate: () => void (state.invalidated += 1),
    });
    return { state, source };
  }
  /** EC2 answering RequestExpired to the first session, with a Date header `aheadMs` from now. */
  function expiring(aheadMs: number, accepts = 'ASIAGEN2') {
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      const auth = init.headers.authorization ?? '';
      seen.push(`${/ASIAGEN\d/.exec(auth)?.[0]}@${init.headers['x-amz-date']}`);
      const ok = auth.includes(accepts);
      return new Response(
        ok
          ? '<DescribeRegionsResponse><requestId>r</requestId></DescribeRegionsResponse>'
          : '<?xml version="1.0"?><Response><Errors><Error><Code>RequestExpired</Code><Message>Request has expired.</Message></Error></Errors><RequestID>r</RequestID></Response>',
        {
          status: ok ? 200 : 400,
          headers: { date: new Date(Date.now() + aheadMs).toUTCString() },
        },
      );
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it('RequestExpired with a right clock is an expired session: the credentials are read again', async () => {
    const { state, source } = sessions();
    const { seen, fetchImpl } = expiring(0);
    const ec2 = ec2Client({ region: 'us-east-1', credentials: source, fetch: fetchImpl });
    await ec2.call('DescribeRegions', {}, { signal });
    expect(seen.map((entry) => entry.split('@')[0])).toEqual(['ASIAGEN1', 'ASIAGEN2']);
    expect(state.invalidated).toBe(1);
    // The next call signs with the new session at once.
    await ec2.call('DescribeRegions', {}, { signal });
    expect(seen).toHaveLength(3);
  });

  it('RequestExpired again after the clock correction reads the credentials again, then stops', async () => {
    const { state, source } = sessions();
    const { seen, fetchImpl } = expiring(20 * 60_000);
    const ec2 = ec2Client({ region: 'us-east-1', credentials: source, fetch: fetchImpl });
    await ec2.call('DescribeRegions', {}, { signal });
    // The first session with the local time, then with the server's, then the second session.
    expect(seen.map((entry) => entry.split('@')[0])).toEqual(['ASIAGEN1', 'ASIAGEN1', 'ASIAGEN2']);
    expect(seen[1]!.split('@')[1]).not.toBe(seen[0]!.split('@')[1]);
    expect(state.invalidated).toBe(1);

    // Refused whatever is tried: one clock correction and one re-read, never a loop.
    const never = sessions();
    const refused = expiring(20 * 60_000, 'ASIANEVER');
    const client = ec2Client({
      region: 'us-east-1',
      credentials: never.source,
      fetch: refused.fetchImpl,
    });
    const error = await failure(() => client.call('DescribeRegions', {}, { signal }));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(refused.seen).toHaveLength(3);
    expect(never.state.invalidated).toBe(1);
  });

  it('times out as UNAVAILABLE with reason timeout', async () => {
    vi.useFakeTimers();
    const never: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
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
        queryResponse(
          request.operation,
          'https://sts.amazonaws.com/doc/2011-06-15/',
          '<Account>111111111111</Account>',
        ),
    });
    emu.register(/^ssm\./, {
      service: 'ssm',
      protocol: 'json',
      handle: (request) =>
        request.operation === 'GetParameter'
          ? new Response(
              JSON.stringify({ Parameter: { Value: request.headers.get('x-amz-target') } }),
            )
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
    const value = await ssm.call<{ Parameter: { Value: string } }>(
      'GetParameter',
      { Name: 'x' },
      { signal },
    );
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
