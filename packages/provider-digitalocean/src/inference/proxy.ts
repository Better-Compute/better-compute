import { ComputeError, type Logger } from '@better-compute/core';

// The operator's inference proxy (P8): an optional route through which a tenant calls DigitalOcean serverless
// inference (OpenAI-compatible chat completions, completions and embeddings) with its sealed model access key
// (`do.inference-key`), so the control plane counts the tokens each call used: `ai.inference.tokens`, by model. A
// tenant may also call DigitalOcean directly with its key; that usage then comes from DigitalOcean billing (P9).
//
// - Only the inference routes pass, and only JSON bodies that name a model.
// - The upstream origin is a code-level option (https only), never tenant input, and a redirect is never followed.
// - A streamed answer passes through byte for byte; the proxy asks for its final usage chunk
//   (`stream_options.include_usage`) and counts from it. A client that cancels its stream before that chunk is still
//   counted: the proxy reads the rest of the answer itself (bounded by `maxDrainBytes`). An abort of the request's
//   own `signal` stops the upstream call, and what it used then is not counted: a host that wants every call counted
//   does not tie that signal to the client's connection.
// - The key goes in the upstream Authorization header only: it is masked out of an upstream error body, never logged,
//   never part of an error. Counting never fails a call: a recorder that throws is logged and the answer still goes.

/** What one proxied call used. `meta` is the caller's own (a tenant id), passed through untouched. */
export interface InferenceUsage {
  route: 'chat.completions' | 'completions' | 'embeddings';
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  meta?: Readonly<Record<string, string>>;
}

export interface InferenceProxyOptions {
  /** The upstream origin (default `https://inference.do-ai.run`): https, a code-level option. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  /** Where the counts go: the host writes them as `ai.inference.tokens` usage. Errors are logged, never thrown. */
  record(usage: InferenceUsage): void | Promise<void>;
  log?: Logger;
}

/** One call through the proxy: the route, the request body, the tenant's resolved key and the caller's meta. */
export interface InferenceProxyRequest {
  path: string;
  body: unknown;
  key: string;
  meta?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export const defaultInferenceOrigin = 'https://inference.do-ai.run';
/** How much of a streamed answer the proxy still reads, for its usage chunk, after the client cancelled: 16 MiB. */
export const maxDrainBytes = 16 * 1024 * 1024;

const routes: Readonly<Record<string, InferenceUsage['route']>> = {
  '/v1/chat/completions': 'chat.completions',
  '/v1/completions': 'completions',
  '/v1/embeddings': 'embeddings',
};
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The usage an answer reports (`usage.prompt_tokens`, `completion_tokens`, `total_tokens`), if any. */
function usageOf(answer: unknown): Omit<InferenceUsage, 'route' | 'model' | 'meta'> | undefined {
  if (!isObject(answer) || !isObject(answer.usage)) return undefined;
  const inputTokens = count(answer.usage.prompt_tokens);
  const outputTokens = count(answer.usage.completion_tokens);
  const total = count(answer.usage.total_tokens);
  return { inputTokens, outputTokens, totalTokens: total > 0 ? total : inputTokens + outputTokens };
}

/** Builds the proxy. It throws `INVALID_CONFIG` for an endpoint that is not an https origin. */
export function inferenceProxy(
  options: InferenceProxyOptions,
): (request: InferenceProxyRequest) => Promise<Response> {
  let origin: string;
  try {
    const url = new URL(options.endpoint ?? defaultInferenceOrigin);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('not https');
    origin = url.origin;
  } catch {
    throw new ComputeError(
      'INVALID_CONFIG',
      'inferenceProxy({ endpoint }) must be an https origin',
    );
  }
  const fetch = options.fetch ?? globalThis.fetch;
  const log = options.log ?? quiet;

  return async function proxy(request: InferenceProxyRequest): Promise<Response> {
    const route = Object.hasOwn(routes, request.path) ? routes[request.path] : undefined;
    if (route === undefined)
      throw new ComputeError(
        'INVALID_INPUT',
        `The inference proxy serves ${Object.keys(routes).join(', ')} only`,
        undefined,
        { reason: 'route' },
      );
    const body = request.body;
    if (!isObject(body) || typeof body.model !== 'string' || !modelPattern.test(body.model))
      throw new ComputeError(
        'INVALID_INPUT',
        'An inference request is a JSON object naming a model',
        undefined,
        {
          reason: 'model',
        },
      );
    if (typeof request.key !== 'string' || request.key.length === 0)
      throw new ComputeError('INVALID_INPUT', 'An inference request needs a model access key');
    const model = body.model;
    const streamed = body.stream === true;
    const forwarded = streamed
      ? {
          ...body,
          stream_options: {
            ...(isObject(body.stream_options) ? body.stream_options : {}),
            include_usage: true,
          },
        }
      : body;
    const mask = (text: string) => text.split(request.key).join('********');

    const record = (usage: Omit<InferenceUsage, 'route' | 'model' | 'meta'> | undefined) => {
      if (!usage) return;
      const entry: InferenceUsage = {
        route,
        model,
        ...usage,
        ...(request.meta !== undefined ? { meta: request.meta } : {}),
      };
      const failed = (error: unknown) =>
        log.warn('inference proxy: could not record usage', {
          model,
          route,
          error: mask(String((error as Error)?.message ?? error)).slice(0, 300),
        });
      try {
        const pending = options.record(entry);
        if (pending && typeof (pending as Promise<void>).catch === 'function')
          (pending as Promise<void>).catch(failed);
      } catch (error) {
        failed(error);
      }
    };

    let upstream: Response;
    try {
      upstream = await fetch(`${origin}${request.path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.key}`,
          'content-type': 'application/json',
          accept: streamed ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(forwarded),
        redirect: 'manual',
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      throw new ComputeError(
        'UNAVAILABLE',
        `Inference upstream unreachable: ${mask(String((error as Error)?.message ?? error)).slice(0, 200)}`,
      );
    }
    // A redirect hands back a URL of another origin: never followed (the key would go with it).
    if (upstream.status >= 300 && upstream.status < 400)
      throw new ComputeError(
        'UNAVAILABLE',
        `Inference upstream answered a redirect (${upstream.status})`,
        undefined,
        {
          reason: 'redirect',
        },
      );
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
      const text = mask(await upstream.text());
      log.info('inference proxy: upstream refused a call', {
        model,
        route,
        status: upstream.status,
      });
      return new Response(text, {
        status: upstream.status,
        headers: { 'content-type': contentType },
      });
    }
    if (!streamed || upstream.body === null) {
      const text = await upstream.text();
      try {
        record(usageOf(JSON.parse(text)));
      } catch {
        log.warn('inference proxy: an answer without readable usage was not counted', {
          model,
          route,
        });
      }
      return new Response(text, {
        status: upstream.status,
        headers: { 'content-type': contentType },
      });
    }
    // Server-sent events: pass every byte on; read `data:` lines (across chunk boundaries) for the usage chunk.
    const decoder = new TextDecoder();
    let pending = '';
    let usage: Omit<InferenceUsage, 'route' | 'model' | 'meta'> | undefined;
    const scan = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '' || data === '[DONE]') return;
      try {
        usage = usageOf(JSON.parse(data)) ?? usage;
      } catch {
        // Not JSON: passed through, not counted.
      }
    };
    const take = (chunk: Uint8Array) => {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) scan(line);
    };
    let counted = false;
    const finish = () => {
      if (counted) return;
      counted = true;
      pending += decoder.decode();
      if (pending) scan(pending);
      pending = '';
      if (usage === undefined)
        log.warn('inference proxy: a streamed answer without a usage chunk was not counted', {
          model,
          route,
        });
      record(usage);
    };
    // The client's stream is fed from the upstream reader. A client that stops reading (cancels) does not stop the
    // count: the rest of the answer is still read, up to `maxDrainBytes`, for its final usage chunk, since upstream
    // bills the tokens whether or not the client reads them.
    const reader = upstream.body.getReader();
    let cancelled = false;
    const drain = async () => {
      let left = maxDrainBytes;
      try {
        while (left > 0) {
          const { done, value } = await reader.read();
          if (done) break;
          take(value);
          left -= value.byteLength;
        }
      } catch {
        // The upstream ended badly: what was read is what is counted.
      }
      finish();
      if (left <= 0) reader.cancel().catch(() => {});
    };
    const passed = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          finish();
          if (!cancelled) controller.error(error);
          return;
        }
        if (next.done) {
          finish();
          if (!cancelled) controller.close();
          return;
        }
        take(next.value);
        if (!cancelled) controller.enqueue(next.value);
      },
      cancel() {
        cancelled = true;
        void drain();
      },
    });
    return new Response(passed, {
      status: upstream.status,
      headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
    });
  };
}
