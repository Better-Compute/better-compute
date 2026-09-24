import {
  connect as connectHttp2,
  constants,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
} from 'node:http2';
import { connect as connectTls } from 'node:tls';
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import type { DuplexStream } from '@better-compute/core';
import { toPem } from '@better-compute/pki';
import { driver, MAX_FRAME_BYTES } from '@better-compute/protocol';
import {
  decodeGrpcMessage,
  DRIVER_PLUGIN_SERVICE,
  frameMessage,
  GrpcCode,
  GrpcError,
  MessageDecoder,
} from './grpc.js';
import { matchesCertificate, type EphemeralIdentity, type Handshake } from './handshake.js';
import { errorFromWire } from './wire.js';

export type InvokeRequestInit = MessageInitShape<typeof driver.InvokeRequestSchema>;
export type ValidateRequestInit = MessageInitShape<typeof driver.ValidateRequestSchema>;

/**
 * One mTLS HTTP/2 connection to a plugin. Transport failures reject with a `GrpcError`
 * (`UNAVAILABLE` when the plugin went away); a plugin's `DriverError` rejects with the
 * `ComputeError` of `errorFromWire`.
 */
export interface PluginConnection {
  describe(signal?: AbortSignal): Promise<driver.DescribeResponse>;
  validate(request: ValidateRequestInit, signal?: AbortSignal): Promise<driver.ValidateResponse>;
  /** Resolves with `result_json`; progress is reported as it streams in. */
  invoke(
    request: InvokeRequestInit,
    onProgress: (progress: driver.Progress) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Opens a `Stream` call; resolves once the plugin reported the stream open. */
  stream(request: InvokeRequestInit, signal?: AbortSignal): Promise<DuplexStream>;
  health(signal?: AbortSignal): Promise<driver.HealthResponse>;
  readonly closed: boolean;
  /** Called once when the connection is gone, whatever the reason. */
  onClose(listener: () => void): void;
  /** Destroys the connection; calls still open fail with `UNAVAILABLE`. */
  close(): void;
}

export interface ConnectPluginOptions {
  /** How long the TLS and HTTP/2 handshakes may take (default 10 000 ms). */
  timeoutMs?: number;
}

function tcpTarget(address: string): { host: string; port: number } {
  const separator = address.lastIndexOf(':');
  return { host: address.slice(0, separator), port: Number(address.slice(separator + 1)) };
}

function statusOf(headers: IncomingHttpHeaders): GrpcError | undefined {
  const code = headers['grpc-status'];
  if (code === undefined) return undefined;
  const message = headers['grpc-message'];
  return new GrpcError(
    Number(code) as GrpcCode,
    typeof message === 'string' ? decodeGrpcMessage(message) : '',
  );
}

/**
 * Dials a plugin from its handshake with the host's ephemeral identity. The plugin must present
 * exactly the certificate its handshake line carried; it in turn accepts only the certificate it
 * was given in `BCX_CLIENT_CERT`.
 */
export async function connectPlugin(
  handshake: Handshake,
  identity: Pick<EphemeralIdentity, 'keyPem' | 'certificatePem'>,
  options: ConnectPluginOptions = {},
): Promise<PluginConnection> {
  const pinned = handshake.certificate;
  const session = connectHttp2('https://localhost', {
    createConnection: () =>
      connectTls({
        ...(handshake.network === 'unix'
          ? { path: handshake.address }
          : tcpTarget(handshake.address)),
        key: identity.keyPem,
        cert: identity.certificatePem,
        ca: [toPem(pinned)],
        servername: 'localhost',
        ALPNProtocols: ['h2'],
        checkServerIdentity: (_host, certificate) =>
          matchesCertificate(certificate.raw, pinned)
            ? undefined
            : new Error('The plugin presented a certificate other than the one in its handshake'),
      }),
  });
  session.on('error', () => {}); // Surfaced through the calls and `closed`.
  await new Promise<void>((resolve, reject) => {
    const fail = (message: string) => {
      clearTimeout(timer);
      session.destroy();
      reject(new GrpcError(GrpcCode.UNAVAILABLE, message));
    };
    const timer = setTimeout(
      () => fail('Timed out connecting to the plugin'),
      options.timeoutMs ?? 10_000,
    );
    session.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    session.once('error', (error: Error) => fail(`Cannot connect to the plugin: ${error.message}`));
    session.once('close', () => fail('The plugin closed the connection'));
  });

  const open = (method: string, signal?: AbortSignal): ClientHttp2Stream => {
    if (session.closed || session.destroyed)
      throw new GrpcError(GrpcCode.UNAVAILABLE, 'The plugin connection is closed');
    signal?.throwIfAborted();
    const stream = session.request({
      ':method': 'POST',
      ':path': `/${DRIVER_PLUGIN_SERVICE}/${method}`,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
    });
    stream.on('error', () => {}); // `close` follows and settles the call.
    if (signal) {
      const cancel = () => {
        if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL);
      };
      signal.addEventListener('abort', cancel, { once: true });
      stream.once('close', () => signal.removeEventListener('abort', cancel));
    }
    return stream;
  };

  /** Feeds every response message to `onMessage`; settles with the call's status. */
  const receive = (
    stream: ClientHttp2Stream,
    onMessage: (bytes: Uint8Array) => void,
    signal?: AbortSignal,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const decoder = new MessageDecoder(MAX_FRAME_BYTES);
      let status: GrpcError | undefined;
      let failure: { error: unknown } | undefined;
      stream.on('response', (headers) => {
        const http = headers[':status'];
        status = http === 200 ? statusOf(headers) : new GrpcError(GrpcCode.UNKNOWN, `HTTP ${http}`);
      });
      stream.on('trailers', (trailers) => {
        status = statusOf(trailers) ?? status;
      });
      stream.on('data', (chunk: Uint8Array) => {
        if (failure) return;
        try {
          for (const message of decoder.push(chunk)) onMessage(message);
        } catch (error) {
          failure = { error };
          stream.close(constants.NGHTTP2_CANCEL);
        }
      });
      stream.on('close', () => {
        if (failure) reject(failure.error);
        else if (signal?.aborted) reject(signal.reason);
        else if (!status)
          reject(new GrpcError(GrpcCode.UNAVAILABLE, 'The plugin ended the call without a status'));
        else if (status.code !== GrpcCode.OK) reject(status);
        else resolve();
      });
    });

  const unary = async <Req extends DescMessage, Res extends DescMessage>(
    method: string,
    requestSchema: Req,
    request: MessageInitShape<Req>,
    responseSchema: Res,
    signal?: AbortSignal,
  ): Promise<MessageShape<Res>> => {
    const stream = open(method, signal);
    stream.end(frameMessage(toBinary(requestSchema, create(requestSchema, request))));
    const messages: Uint8Array[] = [];
    await receive(stream, (bytes) => messages.push(bytes), signal);
    if (messages.length !== 1)
      throw new GrpcError(
        GrpcCode.INTERNAL,
        `Expected one ${method} response, got ${messages.length}`,
      );
    return fromBinary(responseSchema, messages[0]!);
  };

  const siteOf = (request: InvokeRequestInit) => ({
    driver: request.driverId ?? '',
    kind: request.kind ?? '',
    operation: request.operation ?? '',
  });

  return {
    describe: (signal) =>
      unary('Describe', driver.DescribeRequestSchema, {}, driver.DescribeResponseSchema, signal),
    validate: (request, signal) =>
      unary(
        'Validate',
        driver.ValidateRequestSchema,
        request,
        driver.ValidateResponseSchema,
        signal,
      ),
    health: (signal) =>
      unary('Health', driver.HealthRequestSchema, {}, driver.HealthResponseSchema, signal),

    async invoke(request, onProgress, signal) {
      const stream = open('Invoke', signal);
      stream.end(
        frameMessage(
          toBinary(driver.InvokeRequestSchema, create(driver.InvokeRequestSchema, request)),
        ),
      );
      let outcome: { json: string } | { error: driver.DriverError } | undefined;
      await receive(
        stream,
        (bytes) => {
          if (outcome) return; // Nothing counts after the terminal message.
          const response = fromBinary(driver.InvokeResponseSchema, bytes);
          switch (response.msg.case) {
            case 'progress':
              try {
                onProgress(response.msg.value);
              } catch {
                // A failing progress sink must not fail the operation.
              }
              break;
            case 'resultJson':
              outcome = { json: response.msg.value };
              break;
            case 'error':
              outcome = { error: response.msg.value };
              break;
          }
        },
        signal,
      );
      if (!outcome)
        throw new GrpcError(GrpcCode.INTERNAL, 'The plugin ended Invoke without a result');
      if ('error' in outcome) throw errorFromWire(outcome.error, siteOf(request));
      return outcome.json;
    },

    async stream(request, signal) {
      const call = open('Stream', signal);
      const send = (msg: MessageInitShape<typeof driver.StreamRequestSchema>['msg']) =>
        new Promise<void>((resolve, reject) =>
          call.write(
            frameMessage(
              toBinary(driver.StreamRequestSchema, create(driver.StreamRequestSchema, { msg })),
            ),
            (error) => (error ? reject(error) : resolve()),
          ),
        );
      let readable!: ReadableStreamDefaultController<Uint8Array>;
      let state: 'opening' | 'open' | 'done' = 'opening';
      let opened!: () => void;
      let refused!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        opened = resolve;
        refused = reject;
      });
      ready.catch(() => {}); // Awaited below, possibly after a quick refusal.
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          readable = controller;
        },
        cancel() {
          if (!call.closed) call.close(constants.NGHTTP2_CANCEL);
        },
      });
      const settle = (error?: unknown) => {
        if (state === 'opening') {
          if (error === undefined) opened();
          else refused(error);
        }
        if (state !== 'done') {
          try {
            if (error === undefined) readable.close();
            else readable.error(error);
          } catch {
            // The reader already cancelled.
          }
        }
        state = 'done';
      };
      receive(
        call,
        (bytes) => {
          const response = fromBinary(driver.StreamResponseSchema, bytes);
          switch (response.msg.case) {
            case 'data':
              if (state === 'opening') {
                state = 'open';
                opened();
              }
              if (state === 'open' && response.msg.value.byteLength)
                readable.enqueue(response.msg.value);
              break;
            case 'error':
              settle(errorFromWire(response.msg.value, siteOf(request)));
              break;
            case 'close':
              settle();
              break;
          }
        },
        signal,
      ).then(
        () => settle(),
        (error) => settle(error),
      );
      await send({ case: 'open', value: request });
      await ready;
      const input = new WritableStream<Uint8Array>({
        write: (chunk) => send({ case: 'data', value: chunk }),
        close: async () => {
          await send({ case: 'close', value: { reason: 'eof' } });
          call.end();
        },
        abort: () => {
          if (!call.closed) call.close(constants.NGHTTP2_CANCEL);
        },
      });
      return {
        readable: output,
        writable: input,
        close: async () => {
          if (!call.closed) call.close(constants.NGHTTP2_CANCEL);
        },
      };
    },

    get closed() {
      return session.closed || session.destroyed;
    },
    onClose(listener) {
      if (session.closed || session.destroyed) queueMicrotask(listener);
      else session.once('close', listener);
    },
    close() {
      session.destroy();
    },
  };
}
