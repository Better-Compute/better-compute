import { describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import {
  googleClient,
  paginate,
  rpcCodeToHttp,
  settledOperation,
} from '@better-compute/gcp-common';
import { FakeGoogle } from './support/gcp/fake-google.js';

// paginate and settledOperation: page-token paging and long-running operation results.

const EI = (reason: string) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'googleapis.com',
});

function setup() {
  const fake = new FakeGoogle();
  const client = googleClient({ fetch: fake.fetch, tokens: fake.tokens() });
  return { fake, client };
}

const url = 'https://things.googleapis.com/v1/things';

describe('paginate', () => {
  it('follows nextPageToken across three pages and sends pageSize', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/v1/things', (request) => {
      const token = request.url.searchParams.get('pageToken');
      if (token === null) return { body: { things: [1, 2, 3], nextPageToken: 'p2' } };
      if (token === 'p2') return { body: { things: [4, 5, 6], nextPageToken: 'p3' } };
      return { body: { things: [7] } };
    });
    const seen: number[] = [];
    for await (const item of paginate<number>(client, {
      url,
      field: 'things',
      pageSize: 3,
      signal: new AbortController().signal,
    }))
      seen.push(item);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET']);
    expect(fake.requests.map((r) => r.url.searchParams.get('pageSize'))).toEqual(['3', '3', '3']);
    expect(fake.requests.map((r) => r.url.searchParams.get('pageToken'))).toEqual([
      null,
      'p2',
      'p3',
    ]);
  });

  it('keeps the caller query and sends no pageSize when none is given', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/v1/things', () => ({ body: { things: ['a'] } }));
    const seen: string[] = [];
    for await (const item of paginate<string>(client, {
      url,
      query: { filter: 'x' },
      field: 'things',
      signal: new AbortController().signal,
    }))
      seen.push(item);
    expect(seen).toEqual(['a']);
    expect(fake.requests[0]!.url.searchParams.get('filter')).toBe('x');
    expect(fake.requests[0]!.url.searchParams.has('pageSize')).toBe(false);
  });

  it('an empty page with a token continues; a page without the field yields nothing', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/v1/things', (request) =>
      request.url.searchParams.get('pageToken') === null
        ? { body: { things: [], nextPageToken: 'p2' } }
        : { body: { things: [9] } },
    );
    const seen: number[] = [];
    for await (const item of paginate<number>(client, {
      url,
      field: 'things',
      signal: new AbortController().signal,
    }))
      seen.push(item);
    expect(seen).toEqual([9]);
    expect(fake.requests).toHaveLength(2);

    const bare = setup();
    bare.fake.route('GET', '/v1/things', () => ({ body: {} }));
    const none: unknown[] = [];
    for await (const item of paginate(bare.client, {
      url,
      field: 'things',
      signal: new AbortController().signal,
    }))
      none.push(item);
    expect(none).toEqual([]);
    expect(bare.fake.requests).toHaveLength(1);
  });

  it('an aborted signal stops paging after the current page', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/v1/things', () => ({ body: { things: [1, 2], nextPageToken: 'more' } }));
    const controller = new AbortController();
    const reason = new Error('stop');
    const seen: number[] = [];
    const run = async () => {
      for await (const item of paginate<number>(client, {
        url,
        field: 'things',
        signal: controller.signal,
      })) {
        seen.push(item);
        controller.abort(reason);
      }
    };
    await expect(run()).rejects.toBe(reason);
    expect(seen).toEqual([1, 2]);
    expect(fake.requests).toHaveLength(1);
  });
});

describe('settledOperation', () => {
  const failed = (code: number, details?: unknown[]) =>
    settledOperationError({
      name: 'operations/1',
      done: true,
      error: { code, message: 'bad', details },
    });

  function settledOperationError(operation: Parameters<typeof settledOperation>[0]) {
    try {
      settledOperation(operation, 'op');
    } catch (error) {
      if (isComputeError(error)) return error;
      throw error;
    }
    throw new Error('expected settledOperation to throw');
  }

  it('is undefined while running and the response when done', () => {
    expect(settledOperation({ name: 'operations/1', done: false }, 'op')).toBeUndefined();
    expect(settledOperation({ name: 'operations/1' }, 'op')).toBeUndefined();
    expect(
      settledOperation({ name: 'operations/1', done: true, response: { x: 1 } }, 'op'),
    ).toEqual({ x: 1 });
  });

  it.each([
    [8, 'RATE_LIMITED'],
    [9, 'INVALID_STATE'],
    [6, 'CONFLICT'],
    [5, 'NOT_FOUND'],
    [3, 'INVALID_INPUT'],
    [14, 'UNAVAILABLE'],
    [99, 'PROVIDER_ERROR'],
  ])('an operation error with rpc code %i is %s', (code, expected) => {
    const error = failed(code);
    expect(error.code).toBe(expected);
    expect(error.message).toBe('op: bad');
    expect(error.details).toMatchObject({ provider: 'gcp' });
  });

  it("an operation error's ErrorInfo reason is kept", () => {
    const error = failed(8, [EI('RESOURCE_QUOTA_EXCEEDED')]);
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.details).toMatchObject({ reason: 'RESOURCE_QUOTA_EXCEEDED' });
  });
});

describe('rpcCodeToHttp', () => {
  it('maps google.rpc.Code to an HTTP status and canonical name', () => {
    expect(rpcCodeToHttp(1)).toEqual([499, 'CANCELLED']);
    expect(rpcCodeToHttp(8)).toEqual([429, 'RESOURCE_EXHAUSTED']);
    expect(rpcCodeToHttp(16)).toEqual([401, 'UNAUTHENTICATED']);
    expect(rpcCodeToHttp(0)).toEqual([500, 'UNKNOWN']);
    expect(rpcCodeToHttp(99)).toEqual([500, 'UNKNOWN']);
  });
});
