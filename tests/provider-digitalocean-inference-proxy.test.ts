import { describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import { inferenceProxy, type InferenceUsage } from '@better-compute/provider-digitalocean';

// The operator's inference proxy (P8 task 3): a tenant's call to DigitalOcean serverless inference goes through the
// control plane with the tenant's sealed model key, and the tokens it used are counted (`ai.inference.tokens`, by
// model). Only the inference routes pass; the upstream origin is a code-level option and redirects are never
// followed; the key never reaches a log, an error or the answer.

const key = 'sk-do-0123456789abcdef0123456789abcdef';

interface Seen {
  url: string;
  init: RequestInit;
  body: any;
}

function upstream(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const entry: Seen = {
      url: String(input),
      init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(entry);
    return answer(entry);
  };
  return { seen, fetch: fetch as typeof globalThis.fetch };
}

const completion = (model: string) =>
  new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('inferenceProxy', () => {
  it('forwards a chat completion with the tenant key and counts its tokens by model', async () => {
    const up = upstream(() => completion('llama3.3-70b-instruct'));
    const usage: InferenceUsage[] = [];
    const proxy = inferenceProxy({ fetch: up.fetch, record: (entry) => void usage.push(entry) });
    const response = await proxy({
      path: '/v1/chat/completions',
      body: { model: 'llama3.3-70b-instruct', messages: [{ role: 'user', content: 'hello' }] },
      key,
      meta: { tenantId: 'acme' },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('hi');
    expect(up.seen[0]!.url).toBe('https://inference.do-ai.run/v1/chat/completions');
    expect(new Headers(up.seen[0]!.init.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(up.seen[0]!.init.redirect).toBe('manual');
    expect(usage).toEqual([
      {
        route: 'chat.completions',
        model: 'llama3.3-70b-instruct',
        inputTokens: 12,
        outputTokens: 30,
        totalTokens: 42,
        meta: { tenantId: 'acme' },
      },
    ]);
  });

  it('a streamed answer passes through unchanged and is counted from its final usage chunk', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"h"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"i"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ];
    const up = upstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              // Split one line across two chunks: the counter must not depend on chunk boundaries.
              const all = chunks.join('');
              controller.enqueue(encoder.encode(all.slice(0, 70)));
              controller.enqueue(encoder.encode(all.slice(70)));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const usage: InferenceUsage[] = [];
    const proxy = inferenceProxy({ fetch: up.fetch, record: (entry) => void usage.push(entry) });
    const response = await proxy({
      path: '/v1/chat/completions',
      body: { model: 'm1', stream: true, messages: [] },
      key,
    });
    // The proxy asks for the usage chunk it counts from.
    expect(up.seen[0]!.body.stream_options).toEqual({ include_usage: true });
    expect(await response.text()).toBe(chunks.join(''));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(usage).toEqual([
      { route: 'chat.completions', model: 'm1', inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    ]);
  });

  it('a client that cancels the stream before the usage chunk is still counted, once', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"h"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"i"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];
    let served = 0;
    let upstreamCancelled = false;
    const up = upstream(
      () =>
        new Response(
          // One event per pull, as a model streams them: nothing is buffered ahead of the reader.
          new ReadableStream({
            pull(controller) {
              if (served < chunks.length) controller.enqueue(encoder.encode(chunks[served++]!));
              else controller.close();
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const usage: InferenceUsage[] = [];
    let counted!: () => void;
    const done = new Promise<void>((resolve) => (counted = resolve));
    const proxy = inferenceProxy({
      fetch: up.fetch,
      record: (entry) => {
        usage.push(entry);
        counted();
      },
    });
    const response = await proxy({
      path: '/v1/chat/completions',
      body: { model: 'm1', stream: true, messages: [] },
      key,
      meta: { tenantId: 'acme' },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(chunks[0]);
    // The client has its first token and walks away before the usage chunk.
    await reader.cancel();
    await done;
    expect(usage).toEqual([
      {
        route: 'chat.completions',
        model: 'm1',
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        meta: { tenantId: 'acme' },
      },
    ]);
    // Read to its end, not cancelled.
    expect(served).toBe(chunks.length);
    expect(upstreamCancelled).toBe(false);
  });

  it('embeddings count their input tokens', async () => {
    const up = upstream(
      () =>
        new Response(
          JSON.stringify({ data: [], model: 'e', usage: { prompt_tokens: 9, total_tokens: 9 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const usage: InferenceUsage[] = [];
    const proxy = inferenceProxy({ fetch: up.fetch, record: (entry) => void usage.push(entry) });
    await (await proxy({ path: '/v1/embeddings', body: { model: 'e', input: 'x' }, key })).text();
    expect(usage).toEqual([
      { route: 'embeddings', model: 'e', inputTokens: 9, outputTokens: 0, totalTokens: 9 },
    ]);
  });

  it('refuses other routes, bodies without a model, and an endpoint that is not https', async () => {
    const up = upstream(() => completion('m'));
    const proxy = inferenceProxy({ fetch: up.fetch, record: () => {} });
    for (const path of ['/v2/account', '/v1/chat/completions/../../v2/account', '/v1/files'])
      expect((await failure(proxy({ path, body: { model: 'm' }, key }))).code).toBe(
        'INVALID_INPUT',
      );
    for (const body of [undefined, [], { messages: [] }, { model: 7 }, { model: 'a b' }])
      expect((await failure(proxy({ path: '/v1/chat/completions', body, key }))).code).toBe(
        'INVALID_INPUT',
      );
    expect(up.seen).toEqual([]);
    expect(() =>
      inferenceProxy({ endpoint: 'http://inference.do-ai.run', record: () => {} }),
    ).toThrow(/https/);
  });

  it('an upstream redirect is never followed; an upstream error is returned without the key and not counted', async () => {
    const redirect = upstream(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    const usage: InferenceUsage[] = [];
    const proxied = inferenceProxy({ fetch: redirect.fetch, record: (u) => void usage.push(u) });
    const error = await failure(
      proxied({ path: '/v1/chat/completions', body: { model: 'm' }, key }),
    );
    expect(error.code).toBe('UNAVAILABLE');
    expect(redirect.seen).toHaveLength(1);

    const echo = upstream(
      () =>
        new Response(JSON.stringify({ error: { message: `invalid api key ${key}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const logs: string[] = [];
    const log = (message: string, fields?: unknown) =>
      void logs.push(JSON.stringify({ message, fields }));
    const proxy = inferenceProxy({
      fetch: echo.fetch,
      record: (u) => void usage.push(u),
      log: { debug: log, info: log, warn: log, error: log },
    });
    const response = await proxy({ path: '/v1/chat/completions', body: { model: 'm' }, key });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toContain('invalid api key');
    expect(text).not.toContain(key);
    expect(usage).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(key);
  });

  it('refuses a stream that is not a boolean, and stream_options that are not an object, before any call', async () => {
    const up = upstream(() => completion('m'));
    const proxy = inferenceProxy({ fetch: up.fetch, record: () => {} });
    for (const extra of [
      { stream: 'true' },
      { stream: 1 },
      { stream: null },
      { stream: true, stream_options: 'include_usage' },
      { stream: true, stream_options: [] },
    ]) {
      const refused = await failure(
        proxy({ path: '/v1/chat/completions', body: { model: 'm', ...extra }, key }),
      );
      expect(refused.code).toBe('INVALID_INPUT');
      expect(refused.details?.reason).toBe('stream');
    }
    expect(up.seen).toEqual([]);
  });

  it('an event stream answered to a request that did not ask for one is still counted from its events', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n' +
      'data: [DONE]\n\n';
    const up = upstream(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
    );
    const usage: InferenceUsage[] = [];
    const proxy = inferenceProxy({ fetch: up.fetch, record: (entry) => void usage.push(entry) });
    const response = await proxy({ path: '/v1/chat/completions', body: { model: 'm' }, key });
    expect(await response.text()).toBe(body);
    expect(usage).toEqual([
      { route: 'chat.completions', model: 'm', inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    ]);
  });

  it('counting fails closed: a whole answer without usage is withheld, a stream without it reported uncounted', async () => {
    const logs: string[] = [];
    const log = (message: string, fields?: unknown) =>
      void logs.push(JSON.stringify({ message, fields }));
    const usage: InferenceUsage[] = [];
    const whole = upstream(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'free tokens' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const proxy = inferenceProxy({
      fetch: whole.fetch,
      record: (entry) => void usage.push(entry),
      log: { debug: log, info: log, warn: log, error: log },
    });
    const withheld = await proxy({ path: '/v1/chat/completions', body: { model: 'm' }, key });
    expect(withheld.status).toBe(502);
    expect(await withheld.text()).not.toContain('free tokens');
    const stream = upstream(
      () =>
        new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const streamed = inferenceProxy({ fetch: stream.fetch, record: (e) => void usage.push(e) });
    await (
      await streamed({ path: '/v1/chat/completions', body: { model: 'm', stream: true }, key })
    ).text();
    const uncounted = {
      route: 'chat.completions',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      uncounted: true,
    };
    expect(usage).toEqual([uncounted, uncounted]);
    expect(JSON.stringify(logs)).not.toContain(key);
  });

  it('reaches a Dedicated Inference endpoint by its outputs.endpoint, counted with the endpoint', async () => {
    const up = upstream(() => completion('llama3.3-70b-instruct'));
    const usage: InferenceUsage[] = [];
    const proxy = inferenceProxy({ fetch: up.fetch, record: (entry) => void usage.push(entry) });
    const endpoint = 'https://5a4981aa-9653-4bd1-bef5-d6bff52042e4.inference.do-ai.run';
    const response = await proxy({
      path: '/v1/chat/completions',
      body: { model: 'llama3.3-70b-instruct', messages: [] },
      key,
      endpoint,
      meta: { tenantId: 'acme' },
    });
    expect(response.status).toBe(200);
    expect(up.seen[0]!.url).toBe(`${endpoint}/v1/chat/completions`);
    expect(new Headers(up.seen[0]!.init.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(usage).toEqual([
      {
        route: 'chat.completions',
        model: 'llama3.3-70b-instruct',
        inputTokens: 12,
        outputTokens: 30,
        totalTokens: 42,
        meta: { tenantId: 'acme' },
        endpoint: '5a4981aa-9653-4bd1-bef5-d6bff52042e4.inference.do-ai.run',
      },
    ]);
  });

  it('refuses a dedicated endpoint outside the dedicated domain, so the key goes nowhere else', async () => {
    const up = upstream(() => completion('m'));
    const proxy = inferenceProxy({ fetch: up.fetch, record: () => {} });
    for (const endpoint of [
      'http://abc.inference.do-ai.run',
      'https://evil.example',
      'https://abc.inference.do-ai.run.evil.example',
      'https://a.b.inference.do-ai.run',
      'https://inference.do-ai.run',
      'https://abc.inference.do-ai.run:8443',
      'https://user:pw@abc.inference.do-ai.run',
      'https://abc.inference.do-ai.run/v2/account',
      'https://abc.inference.do-ai.run/?x=1',
      'not a url',
      7,
    ]) {
      const refused = await failure(
        proxy({
          path: '/v1/chat/completions',
          body: { model: 'm' },
          key,
          endpoint: endpoint as string,
        }),
      );
      expect(refused.code).toBe('INVALID_INPUT');
      expect(refused.details?.reason).toBe('endpoint');
      expect(refused.message).not.toContain(key);
    }
    expect(up.seen).toEqual([]);
    expect(() =>
      inferenceProxy({ dedicatedDomain: 'https://x', record: () => {} }),
    ).toThrow(/domain/);
  });

  it('a failing usage recorder never fails the call, and is logged without the key', async () => {
    const up = upstream(() => completion('m'));
    const logs: string[] = [];
    const log = (message: string, fields?: unknown) =>
      void logs.push(JSON.stringify({ message, fields }));
    const proxy = inferenceProxy({
      fetch: up.fetch,
      record: () => {
        throw new Error(`sink down for ${key}`);
      },
      log: { debug: log, info: log, warn: log, error: log },
    });
    const response = await proxy({ path: '/v1/chat/completions', body: { model: 'm' }, key });
    expect(response.status).toBe(200);
    await response.text();
    expect(logs.some((line) => line.includes('usage'))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(key);
  });
});
