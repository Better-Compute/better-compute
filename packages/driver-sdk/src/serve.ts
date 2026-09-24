import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  constants,
  createSecureServer,
  type Http2Session,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import {
  ComputeError,
  isComputeError,
  isSecretRef,
  systemClock,
  type DriverContext,
  type DriverDefinition,
  type DuplexStream,
  type Logger,
  type Progress,
  type SecretRef,
  type SecretResolver,
} from '@better-compute/core';
import { driver, DriverManifestSchema, MAX_FRAME_BYTES } from '@better-compute/protocol';
import {
  DRIVER_PLUGIN_SERVICE,
  frameMessage,
  GrpcCode,
  GrpcError,
  grpcResponseHeaders,
  isGrpcContentType,
  MessageDecoder,
  statusTrailers,
} from './grpc.js';
import {
  BCX_CLIENT_CERT,
  BCX_MAGIC_COOKIE_KEY,
  BCX_MAGIC_COOKIE_VALUE,
  BCX_PROTOCOL_VERSION,
  BCX_SOCKET_DIR,
  certificateFromPem,
  createEphemeralIdentity,
  formatHandshake,
  matchesCertificate,
  type BcxNetwork,
} from './handshake.js';
import {
  decodeArgs,
  driverError,
  encodeResult,
  errorToWire,
  isRecord,
  progressToWire,
  runsOnToWire,
  STREAM_CAPABILITY_PREFIX,
} from './wire.js';

export interface ServeDriverOptions {
  /** Where the cookie, socket dir and client certificate are read (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where the handshake line goes (default `process.stdout`). */
  stdout?: { write(text: string): unknown };
  /** Default: `tcp` on 127.0.0.1 on Windows (as go-plugin does there), `unix` elsewhere. */
  network?: BcxNetwork;
  /** `DescribeResponse.plugin_version`. */
  pluginVersion?: string;
  /**
   * Operations, as `<kind>.<operation>`, that return a byte stream (`DuplexStream`, a Node.js
   * `Duplex`, or an `AsyncIterable<Uint8Array>`). Each driver implementing the kind advertises
   * `bcx.stream:<kind>.<operation>`, so hosts open it with `Stream` instead of `Invoke`.
   */
  streams?: readonly string[];
  /** Default: JSON lines on stderr, which `externalDriver` forwards to its own log. */
  log?: Logger;
  /**
   * Shut down gracefully on SIGTERM and when stdin closes (the host's lifeline), then exit; SIGINT
   * is ignored, as in go-plugin, so the host handles Ctrl-C. Default true.
   */
  handleSignals?: boolean;
  /** How long in-flight calls may run after shutdown starts before they are aborted (5 000 ms). */
  shutdownGraceMs?: number;
}

export interface ServedDriver {
  readonly network: BcxNetwork;
  /** The socket path, or `127.0.0.1:<port>`. */
  readonly address: string;
  /** The line printed on stdout. */
  readonly handshake: string;
  /** Stops accepting (`Health` turns NOT_SERVING), lets calls finish, then aborts what remains. */
  close(): Promise<void>;
}

const operationPattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const notServed = new Set(Object.getOwnPropertyNames(Object.prototype));

const missingCookieMessage =
  'This binary is a better-compute driver plugin (bcx). It is not meant to be run directly:\n' +
  'the control plane or bcd starts it and connects to it. Configure it with externalDriver()\n' +
  'or list it in /etc/bcd/plugins.d/.\n';

function stderrLogger(): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      let line: string;
      try {
        line = JSON.stringify({ level, message, ...fields });
      } catch {
        line = JSON.stringify({ level, message });
      }
      process.stderr.write(`${line}\n`);
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** An RFC 6901 pointer from Standard Schema path segments. */
function jsonPointer(path: readonly unknown[] | undefined): string {
  if (!path?.length) return '';
  return path
    .map((segment) =>
      String(isRecord(segment) && 'key' in segment ? segment.key : segment)
        .replaceAll('~', '~0')
        .replaceAll('/', '~1'),
    )
    .map((segment) => `/${segment}`)
    .join('');
}

function issuesOf(error: unknown): { path: string; message: string }[] {
  const issues = isComputeError(error) ? error.details?.issues : undefined;
  if (Array.isArray(issues) && issues.length)
    return issues.map((issue) => ({
      path: jsonPointer(isRecord(issue) && Array.isArray(issue.path) ? issue.path : undefined),
      message: isRecord(issue) ? String(issue.message) : String(issue),
    }));
  return [{ path: '', message: error instanceof Error ? error.message : String(error) }];
}

function parseJson(text: string, what: string): unknown {
  try {
    return text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ComputeError('INVALID_INPUT', `${what} is not JSON`);
  }
}

/** `ctx.secrets` of one call: only refs of the config fields whose values the request delivered. */
function deliveredSecrets(config: unknown, secrets: readonly driver.SecretValue[]): SecretResolver {
  const values = new Map<SecretRef, string>();
  for (const secret of secrets) {
    const ref = isRecord(config) ? config[secret.field] : undefined;
    if (isSecretRef(ref)) values.set(ref, new TextDecoder().decode(secret.value));
  }
  return {
    async resolve(ref) {
      const value = values.get(ref);
      if (value === undefined)
        throw new ComputeError(
          'ACCESS_DENIED',
          `Secret ${ref} was not delivered to this plugin (only declared secret config fields are)`,
        );
      return value;
    },
  };
}

function isDuplexStream(value: unknown): value is DuplexStream {
  return (
    isRecord(value) &&
    value.readable instanceof ReadableStream &&
    value.writable instanceof WritableStream
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function'
  );
}

function isByteStream(value: unknown): boolean {
  return isDuplexStream(value) || value instanceof Duplex || value instanceof ReadableStream;
}

/** A byte stream `Stream` serves; `writable` is absent for read-only sources. */
interface ByteStream {
  readable: ReadableStream<Uint8Array>;
  writable?: WritableStream<Uint8Array>;
  close?(): Promise<void>;
}

/** Resolves with `promise`, or rejects with the signal's reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function respondStatus(stream: ServerHttp2Stream, error: GrpcError): void {
  if (stream.destroyed || stream.closed) return;
  if (stream.headersSent) {
    stream.close();
    return;
  }
  stream.respond(
    { ...grpcResponseHeaders, ...statusTrailers(error.code, error.message) },
    { endStream: true },
  );
}

/** A response stream whose status goes out in trailers once `finish` is called. */
function openResponse(stream: ServerHttp2Stream) {
  let status: GrpcError | undefined;
  let finished = false;
  stream.respond({ ...grpcResponseHeaders }, { waitForTrailers: true });
  stream.on('wantTrailers', () => {
    stream.sendTrailers(statusTrailers(status?.code ?? GrpcCode.OK, status?.message));
    setImmediate(() => {
      if (!stream.closed && !stream.destroyed) stream.close(constants.NGHTTP2_NO_ERROR);
    });
  });
  return {
    /** False when the write buffer is full ('drain' follows). */
    write(bytes: Uint8Array): boolean {
      if (finished || stream.destroyed) return true;
      return stream.write(frameMessage(bytes));
    },
    finish(error?: GrpcError) {
      if (finished || stream.destroyed) return;
      finished = true;
      status = error;
      stream.end();
    },
    get finished() {
      return finished || stream.destroyed;
    },
  };
}

async function readUnary<Desc extends DescMessage>(
  stream: ServerHttp2Stream,
  schema: Desc,
): Promise<MessageShape<Desc>> {
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  const messages: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>)
    messages.push(...decoder.push(chunk));
  if (decoder.pending) throw new GrpcError(GrpcCode.INVALID_ARGUMENT, 'truncated request message');
  if (messages.length !== 1)
    throw new GrpcError(
      GrpcCode.INVALID_ARGUMENT,
      `expected one request message, got ${messages.length}`,
    );
  try {
    return fromBinary(schema, messages[0]!);
  } catch (error) {
    throw new GrpcError(
      GrpcCode.INVALID_ARGUMENT,
      `cannot decode ${schema.typeName}: ${String(error)}`,
    );
  }
}

function toGrpcError(error: unknown): GrpcError {
  if (error instanceof GrpcError) return error;
  if (isComputeError(error, 'NOT_FOUND')) return new GrpcError(GrpcCode.NOT_FOUND, error.message);
  if (isComputeError(error, 'INVALID_INPUT'))
    return new GrpcError(GrpcCode.INVALID_ARGUMENT, error.message);
  return new GrpcError(
    GrpcCode.INTERNAL,
    error instanceof Error ? error.message : 'internal error',
  );
}

/** One resolved call: the driver, kind and operation exist and the arguments parsed. */
interface PreparedCall {
  site: string;
  /** The operation is retry-safe for its kind. */
  retrySafe: boolean;
  run(): Promise<unknown>;
}

/**
 * Serves one or more `defineDriver` objects as a bcx plugin (PLAN.md §5.5): checks the magic
 * cookie (without it, prints a human message and exits 1), listens with auto-mTLS on a unix socket
 * in `BCX_SOCKET_DIR` (tcp on 127.0.0.1 on Windows), prints the handshake line and serves
 * `bettercompute.driver.v1.DriverPlugin`. Only the host's certificate from `BCX_CLIENT_CERT` is
 * accepted.
 *
 * ```ts
 * import { serveDriver } from '@better-compute/driver-sdk';
 * import { acmeBmc } from './driver.js'; // defineDriver({ id: 'acme-bmc', implements: { power } … })
 * await serveDriver(acmeBmc);
 * ```
 */
export async function serveDriver(
  definitions: DriverDefinition | readonly DriverDefinition[],
  options: ServeDriverOptions = {},
): Promise<ServedDriver> {
  const env = options.env ?? process.env;
  if (env[BCX_MAGIC_COOKIE_KEY] !== BCX_MAGIC_COOKIE_VALUE) {
    process.stderr.write(missingCookieMessage);
    process.exit(1);
  }
  const clientPem = env[BCX_CLIENT_CERT];
  let clientCertificate: Uint8Array;
  try {
    clientCertificate = certificateFromPem(clientPem ?? '');
  } catch {
    process.stderr.write(`bcx: ${BCX_CLIENT_CERT} must hold the host's PEM client certificate.\n`);
    process.exit(1);
  }

  const drivers = new Map<string, DriverDefinition>();
  for (const definition of Array.isArray(definitions) ? definitions : [definitions]) {
    const candidate = definition as DriverDefinition;
    if (candidate?.extension !== 'driver' || typeof candidate.id !== 'string')
      throw new ComputeError('INVALID_CONFIG', 'serveDriver takes defineDriver() objects');
    if (drivers.has(candidate.id))
      throw new ComputeError('INVALID_CONFIG', `Driver ${candidate.id} is served twice`);
    drivers.set(candidate.id, candidate);
  }
  const streams = new Set(options.streams ?? []);
  for (const entry of streams)
    if (!/^[^.]+\.[^.]+$/.test(entry))
      throw new ComputeError(
        'INVALID_CONFIG',
        `Stream operation ${entry} is not <kind>.<operation>`,
      );
  const log = options.log ?? stderrLogger();
  const graceMs = options.shutdownGraceMs ?? 5_000;
  const network: BcxNetwork = options.network ?? (process.platform === 'win32' ? 'tcp' : 'unix');
  const identity = createEphemeralIdentity('bcx-plugin');

  const inFlight = new Set<AbortController>();
  const sessions = new Set<Http2Session>();
  let serving = true;

  const implementations = (definition: DriverDefinition) =>
    definition.implements as unknown as Record<string, unknown>;

  const describe = (): driver.DescribeResponse =>
    create(driver.DescribeResponseSchema, {
      drivers: [...drivers.values()].map((definition) => {
        const kinds = Object.keys(implementations(definition));
        const schema = (definition.config as { jsonSchema?: () => unknown }).jsonSchema;
        const retrySafe = (definition.retrySafe ?? {}) as Record<string, readonly string[]>;
        return create(DriverManifestSchema, {
          id: definition.id,
          version: definition.version,
          kinds,
          runsOn: runsOnToWire(definition.runsOn),
          configSchemaJson: JSON.stringify(
            typeof schema === 'function' ? schema.call(definition.config) : {},
          ),
          capabilities: [
            ...(definition.capabilities ?? []),
            ...[...streams]
              .filter((entry) => kinds.includes(entry.slice(0, entry.indexOf('.'))))
              .map((entry) => `${STREAM_CAPABILITY_PREFIX}${entry}`),
          ],
          retrySafeOperations: Object.entries(retrySafe).flatMap(([kind, operations]) =>
            (operations ?? []).map((operation) => `${kind}.${operation}`),
          ),
        });
      }),
      pluginVersion: options.pluginVersion ?? '',
      protocolVersion: BCX_PROTOCOL_VERSION,
    });

  const context = (
    request: { idempotencyKey?: string; traceparent?: string; secrets: driver.SecretValue[] },
    rawConfig: unknown,
    signal: AbortSignal,
    emit: (progress: Progress) => void,
    deadline?: number,
  ): DriverContext & { traceparent?: string; deadline?: number } => ({
    idempotencyKey: request.idempotencyKey ?? '',
    signal,
    clock: systemClock,
    secrets: deliveredSecrets(rawConfig, request.secrets),
    log,
    emit,
    ...(request.traceparent ? { traceparent: request.traceparent } : {}),
    ...(deadline !== undefined ? { deadline } : {}),
  });

  /** Throws a `ComputeError` (sent as a DriverError) when the call cannot start. */
  const prepare = (
    request: driver.InvokeRequest,
    signal: AbortSignal,
    emit: (progress: Progress) => void,
    deadline?: number,
  ): PreparedCall => {
    const definition = drivers.get(request.driverId);
    if (!definition)
      throw new ComputeError('NOT_FOUND', `This plugin serves no driver ${request.driverId}`);
    const { kind, operation } = request;
    const factories = implementations(definition);
    const factory = Object.hasOwn(factories, kind) ? factories[kind] : undefined;
    if (typeof factory !== 'function')
      throw new ComputeError('UNSUPPORTED', `Driver ${definition.id} does not implement ${kind}`);
    const site = `${definition.id} ${kind}.${operation}`;
    if (!operationPattern.test(operation) || notServed.has(operation))
      throw new ComputeError('UNSUPPORTED', `${site} is not an operation`);
    let args: unknown[];
    try {
      args = decodeArgs(request.argsJson);
    } catch {
      throw new ComputeError('INVALID_INPUT', `The arguments of ${site} are not JSON`);
    }
    const rawConfig = parseJson(request.configJson, 'The driver config');
    const retrySafe = (definition.retrySafe as Record<string, readonly string[]> | undefined)?.[
      kind
    ];
    return {
      site,
      retrySafe: retrySafe?.includes(operation) ?? false,
      async run() {
        const parsed = await definition.config['~standard'].validate(rawConfig);
        if (parsed.issues) {
          const [first] = parsed.issues;
          const where = jsonPointer(first?.path);
          throw new ComputeError(
            'INVALID_CONFIG',
            `Invalid config for ${definition.id}: ${where ? `${where}: ` : ''}${first?.message ?? 'invalid'}`,
          );
        }
        const ctx = context(request, rawConfig, signal, emit, deadline);
        const implementation = (await factory(parsed.value, ctx)) as Record<string, unknown>;
        const method = implementation?.[operation];
        if (typeof method !== 'function')
          throw new ComputeError('UNSUPPORTED', `${site} is not an operation`);
        return method.apply(implementation, args);
      },
    };
  };

  /** Aborts `controller` at the request's deadline; returns the deadline and a disposer. */
  const armDeadline = (
    request: driver.InvokeRequest,
    controller: AbortController,
    site: string,
  ) => {
    if (!request.deadline) return { deadline: undefined, dispose: () => {} };
    const deadline = timestampMs(request.deadline);
    const expire = () =>
      controller.abort(driverError('timeout', `${site} did not finish before its deadline`));
    const delay = deadline - Date.now();
    if (delay <= 0) {
      expire();
      return { deadline, dispose: () => {} };
    }
    const timer = setTimeout(expire, delay);
    return { deadline, dispose: () => clearTimeout(timer) };
  };

  async function invoke(stream: ServerHttp2Stream, request: driver.InvokeRequest): Promise<void> {
    const out = openResponse(stream);
    const controller = new AbortController();
    inFlight.add(controller);
    let done = false;
    stream.once('close', () => {
      if (!done) controller.abort(driverError('cancelled', 'The host cancelled the call'));
    });
    const send = (msg: MessageInitShape<typeof driver.InvokeResponseSchema>['msg']) => {
      if (!done)
        out.write(
          toBinary(driver.InvokeResponseSchema, create(driver.InvokeResponseSchema, { msg })),
        );
    };
    const emit = (progress: Progress) => {
      if (isRecord(progress)) send({ case: 'progress', value: progressToWire(progress) });
    };
    const end = (msg: MessageInitShape<typeof driver.InvokeResponseSchema>['msg']) => {
      send(msg);
      done = true;
      out.finish();
    };
    let retrySafe = false;
    const armed = armDeadline(
      request,
      controller,
      `${request.driverId} ${request.kind}.${request.operation}`,
    );
    try {
      const call = prepare(request, controller.signal, emit, armed.deadline);
      retrySafe = call.retrySafe;
      const result = await untilAborted(call.run(), controller.signal);
      if (isByteStream(result)) {
        void closeByteStream(result);
        throw new ComputeError(
          'UNSUPPORTED',
          `${call.site} returns a byte stream: open it with Stream`,
        );
      }
      if (isAsyncIterable(result)) {
        // `AsyncIterable<Progress>` operations (deploy, tearDown, …): each item is progress.
        const iterator = result[Symbol.asyncIterator]();
        try {
          for (;;) {
            const step = await untilAborted(iterator.next(), controller.signal);
            if (step.done) break;
            emit(step.value as Progress);
          }
        } finally {
          void Promise.resolve(iterator.return?.()).catch(() => {});
        }
        end({ case: 'resultJson', value: 'null' });
        return;
      }
      let json: string;
      try {
        json = encodeResult(result);
      } catch {
        throw new ComputeError('DRIVER_ERROR', `The result of ${call.site} is not JSON`);
      }
      end({ case: 'resultJson', value: json });
    } catch (error) {
      if (stream.destroyed || stream.closed) return;
      const retryable =
        retrySafe &&
        !isComputeError(error, 'INVALID_CONFIG') &&
        !isComputeError(error, 'INVALID_INPUT') &&
        !isComputeError(error, 'UNSUPPORTED');
      end({ case: 'error', value: errorToWire(error, retryable) });
    } finally {
      done = true;
      armed.dispose();
      inFlight.delete(controller);
    }
  }

  async function validate(request: driver.ValidateRequest): Promise<driver.ValidateResponse> {
    const definition = drivers.get(request.driverId);
    if (!definition)
      throw new GrpcError(GrpcCode.NOT_FOUND, `This plugin serves no driver ${request.driverId}`);
    const issues: { path: string; message: string }[] = [];
    if (request.kind && !Object.hasOwn(implementations(definition), request.kind))
      issues.push({
        path: '',
        message: `Driver ${definition.id} does not implement ${request.kind}`,
      });
    let rawConfig: unknown;
    try {
      rawConfig = parseJson(request.configJson, 'The driver config');
    } catch (error) {
      issues.push(...issuesOf(error));
    }
    if (!issues.length) {
      const parsed = await definition.config['~standard'].validate(rawConfig);
      if (parsed.issues)
        for (const issue of parsed.issues)
          issues.push({ path: jsonPointer(issue.path), message: issue.message });
      else if (definition.validate) {
        const controller = new AbortController();
        inFlight.add(controller);
        try {
          await definition.validate(
            parsed.value,
            context(request, rawConfig, controller.signal, () => {}),
          );
        } catch (error) {
          issues.push(...issuesOf(error));
        } finally {
          inFlight.delete(controller);
        }
      }
    }
    return create(driver.ValidateResponseSchema, { valid: issues.length === 0, issues });
  }

  /** `Stream`: the first frame opens the operation, then bytes flow both ways until `close`. */
  function duplex(stream: ServerHttp2Stream): void {
    const out = openResponse(stream);
    const decoder = new MessageDecoder(MAX_FRAME_BYTES);
    const controller = new AbortController();
    inFlight.add(controller);
    let opened = false;
    let ended = false;
    let bytes: ByteStream | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    // Host → plugin bytes, written in order; buffered until the operation returned its stream.
    let inbound: Promise<void> = Promise.resolve();
    const early: Uint8Array[] = [];
    let inputClosed = false;

    const send = (msg: MessageInitShape<typeof driver.StreamResponseSchema>['msg']) =>
      out.write(
        toBinary(driver.StreamResponseSchema, create(driver.StreamResponseSchema, { msg })),
      );
    const finish = (error?: unknown, retryable = false, status?: GrpcError) => {
      if (ended) return;
      ended = true;
      if (error !== undefined && !stream.destroyed)
        send({ case: 'error', value: errorToWire(error, retryable) });
      out.finish(status);
      controller.abort(driverError('cancelled', 'The stream closed'));
      inFlight.delete(controller);
      void writer?.abort().catch(() => {});
      void bytes?.readable.cancel().catch(() => {});
      void bytes?.close?.().catch(() => {});
    };
    const write = (chunk: Uint8Array) => {
      const target = writer!;
      inbound = inbound.then(() => target.write(chunk)).catch((error) => finish(error));
    };
    const closeInput = () => {
      inputClosed = true;
      const target = writer;
      if (target) inbound = inbound.then(() => target.close()).catch(() => {});
    };

    async function open(request: driver.InvokeRequest): Promise<void> {
      const site = `${request.driverId} ${request.kind}.${request.operation}`;
      const armed = armDeadline(request, controller, site);
      let retrySafe = false;
      let source: ByteStream | undefined;
      try {
        const call = prepare(request, controller.signal, () => {}, armed.deadline);
        retrySafe = call.retrySafe;
        source = toByteStream(await untilAborted(call.run(), controller.signal));
        if (!source)
          throw new ComputeError('UNSUPPORTED', `${call.site} does not return a byte stream`);
      } catch (error) {
        finish(error, retrySafe);
        return;
      } finally {
        armed.dispose();
      }
      bytes = source;
      if (ended) {
        void source.readable.cancel().catch(() => {});
        void source.close?.().catch(() => {});
        return;
      }
      // An empty data frame tells the host the stream is open.
      send({ case: 'data', value: new Uint8Array(0) });
      if (source.writable) {
        writer = source.writable.getWriter();
        for (const chunk of early.splice(0)) write(chunk);
        if (inputClosed) closeInput();
      }
      const reader = source.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || ended) break;
          if (!send({ case: 'data', value }))
            await new Promise((resolve) => stream.once('drain', resolve));
        }
        if (!ended) send({ case: 'close', value: { reason: 'eof' } });
        finish();
      } catch (error) {
        finish(error);
      }
    }

    stream.on('data', (chunk: Uint8Array) => {
      if (ended) return;
      try {
        for (const message of decoder.push(chunk)) {
          const frame = fromBinary(driver.StreamRequestSchema, message);
          switch (frame.msg.case) {
            case 'open':
              if (opened)
                throw new GrpcError(GrpcCode.INVALID_ARGUMENT, 'the stream is already open');
              opened = true;
              void open(frame.msg.value);
              break;
            case 'data':
              if (!opened)
                throw new GrpcError(GrpcCode.INVALID_ARGUMENT, 'the first frame must be open');
              if (writer) write(frame.msg.value);
              else early.push(frame.msg.value);
              break;
            case 'close':
              closeInput();
              break;
          }
        }
      } catch (error) {
        finish(
          undefined,
          false,
          error instanceof GrpcError
            ? error
            : new GrpcError(GrpcCode.INVALID_ARGUMENT, 'malformed stream frame'),
        );
      }
    });
    stream.on('end', closeInput);
    stream.on('close', () => finish());
  }

  const server = createSecureServer({
    key: identity.keyPem,
    cert: identity.certificatePem,
    ca: [clientPem!],
    requestCert: true,
    rejectUnauthorized: true,
    allowHTTP1: false,
  });
  // The TLS layer verified the chain; only the host's exact certificate may talk to the plugin.
  server.on('secureConnection', (socket: TLSSocket) => {
    if (!matchesCertificate(socket.getPeerCertificate()?.raw, clientCertificate)) socket.destroy();
  });
  server.on('session', (session: Http2Session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    stream.on('error', () => {});
    if (headers[':method'] !== 'POST') {
      stream.respond({ ':status': 405 }, { endStream: true });
      return;
    }
    if (!isGrpcContentType(headers['content-type'])) {
      stream.respond({ ':status': 415 }, { endStream: true });
      return;
    }
    const path = String(headers[':path'] ?? '');
    const method = path.startsWith(`/${DRIVER_PLUGIN_SERVICE}/`)
      ? path.slice(DRIVER_PLUGIN_SERVICE.length + 2)
      : undefined;
    const unary = <Req extends DescMessage, Res extends DescMessage>(
      requestSchema: Req,
      responseSchema: Res,
      call: (request: MessageShape<Req>) => Promise<MessageShape<Res>> | MessageShape<Res>,
    ) =>
      void (async () => {
        try {
          const response = await call(await readUnary(stream, requestSchema));
          const out = openResponse(stream);
          out.write(toBinary(responseSchema, response));
          out.finish();
        } catch (error) {
          respondStatus(stream, toGrpcError(error));
        }
      })();
    switch (method) {
      case 'Describe':
        unary(driver.DescribeRequestSchema, driver.DescribeResponseSchema, describe);
        return;
      case 'Validate':
        unary(driver.ValidateRequestSchema, driver.ValidateResponseSchema, validate);
        return;
      case 'Health':
        unary(driver.HealthRequestSchema, driver.HealthResponseSchema, () =>
          create(driver.HealthResponseSchema, {
            status: serving ? driver.HealthStatus.SERVING : driver.HealthStatus.NOT_SERVING,
            message: serving ? '' : 'shutting down',
          }),
        );
        return;
      case 'Invoke':
        void readUnary(stream, driver.InvokeRequestSchema).then(
          (request) => invoke(stream, request),
          (error) => respondStatus(stream, toGrpcError(error)),
        );
        return;
      case 'Stream':
        duplex(stream);
        return;
      default:
        respondStatus(stream, new GrpcError(GrpcCode.UNIMPLEMENTED, `unknown method ${path}`));
        stream.resume();
    }
  });

  const socketPath =
    network === 'unix'
      ? join(env[BCX_SOCKET_DIR] || tmpdir(), `bcx-${randomBytes(4).toString('hex')}.sock`)
      : undefined;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const listening = () => {
      server.off('error', reject);
      resolve();
    };
    if (socketPath) server.listen(socketPath, listening);
    else server.listen(0, '127.0.0.1', listening);
  });
  const address = socketPath ?? `127.0.0.1:${(server.address() as AddressInfo).port}`;

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      serving = false;
      server.close(() => resolve());
      // GOAWAY: sessions finish their open streams, then close.
      for (const session of sessions) session.close();
      const timer = setTimeout(() => {
        for (const controller of inFlight)
          controller.abort(driverError('unavailable', 'The plugin is shutting down'));
        for (const session of sessions) session.destroy();
      }, graceMs);
      timer.unref();
    }).then(async () => {
      if (socketPath) await rm(socketPath, { force: true }).catch(() => {});
    }));

  if (options.handleSignals ?? true) {
    const stop = () => void close().finally(() => process.exit(0));
    process.on('SIGINT', () => {});
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    process.stdin.once('error', stop);
    process.stdin.resume();
  }

  const handshake = formatHandshake({
    protocolVersion: BCX_PROTOCOL_VERSION,
    network,
    address,
    certificate: identity.certificate,
  });
  (options.stdout ?? process.stdout).write(`${handshake}\n`);
  return { network, address, handshake, close };
}

/**
 * What `Stream` can serve: a web `DuplexStream`, a Node.js `Duplex`, or (read-only) a
 * `ReadableStream` or async iterable of bytes or strings.
 */
function toByteStream(value: unknown): ByteStream | undefined {
  if (isDuplexStream(value))
    return { readable: value.readable, writable: value.writable, close: () => value.close() };
  if (value instanceof Duplex) {
    const web = Duplex.toWeb(value);
    return {
      readable: web.readable as ReadableStream<Uint8Array>,
      writable: web.writable as WritableStream<Uint8Array>,
      close: async () => void value.destroy(),
    };
  }
  if (value instanceof ReadableStream) return { readable: value as ReadableStream<Uint8Array> };
  if (isAsyncIterable(value)) {
    const iterable = value as AsyncIterable<Uint8Array | string>;
    const encoder = new TextEncoder();
    const iterator = iterable[Symbol.asyncIterator]();
    return {
      readable: new ReadableStream<Uint8Array>({
        async pull(controller) {
          const step = await iterator.next();
          if (step.done) controller.close();
          else
            controller.enqueue(
              typeof step.value === 'string' ? encoder.encode(step.value) : step.value,
            );
        },
        async cancel() {
          await iterator.return?.();
        },
      }),
    };
  }
  return undefined;
}

async function closeByteStream(value: unknown): Promise<void> {
  try {
    if (value instanceof Duplex) value.destroy();
    else if (isDuplexStream(value)) await value.close();
    else if (value instanceof ReadableStream) await value.cancel();
  } catch {
    // Best effort: the call already failed.
  }
}
