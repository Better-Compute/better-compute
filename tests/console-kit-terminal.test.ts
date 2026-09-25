import { describe, expect, it } from 'vitest';
import type { TunnelConnection } from '@better-compute/client';
import { createTerminalSession, type ComputeRequester } from '@better-compute/console-kit';

// The console terminal: tunnels.open, then the WebSocket tunnel, with a bounded output buffer.

function fakeTunnel() {
  const handlers: ((data: Uint8Array, channel: number) => void)[] = [];
  let markReady!: () => void;
  let markExited!: (value: { exitCode: number; reason: string }) => void;
  const sent: unknown[] = [];
  const tunnel: TunnelConnection = {
    ready: new Promise<void>((resolve) => (markReady = resolve)),
    exited: new Promise((resolve) => (markExited = resolve)),
    write: (data) =>
      sent.push({ write: typeof data === 'string' ? data : Buffer.from(data).toString() }),
    resize: (rows, cols) => sent.push({ resize: [rows, cols] }),
    onData: (handler) => void handlers.push(handler),
    close: () => markExited({ exitCode: 0, reason: 'bye' }),
    terminate: () => markExited({ exitCode: -1, reason: 'terminated' }),
    bufferedAmount: 0,
  };
  return {
    tunnel,
    sent,
    ready: () => markReady(),
    emit: (text: string, channel = 0) =>
      handlers.forEach((handler) => handler(Buffer.from(text), channel)),
  };
}

describe('terminal session', () => {
  it('opens through tunnels.open, streams output, sends input and ends with the exit status', async () => {
    const calls: { path: string; input: unknown }[] = [];
    const api: ComputeRequester = {
      async $request<O>(path: string, input?: unknown) {
        calls.push({ path, input });
        return { tunnelId: 'tun_1', path: 'tunnels/TICKET' } as O;
      },
    };
    const fake = fakeTunnel();
    const urls: string[] = [];
    const session = createTerminalSession(api, {
      tenantId: 'acme',
      instanceId: 'inst_1',
      baseURL: 'https://compute.test',
      maxBufferedBytes: 10,
      connect: (url) => {
        urls.push(url);
        return fake.tunnel;
      },
    });
    const opening = session.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.get().status).toBe('opening');
    session.write('ignored before open');
    fake.ready();
    await opening;
    expect(session.get()).toMatchObject({ status: 'open', tunnelId: 'tun_1' });
    expect(calls).toEqual([
      { path: 'tunnels/open', input: { tenantId: 'acme', instanceId: 'inst_1', op: 'exec' } },
    ]);
    expect(urls).toEqual(['wss://compute.test/api/compute/tunnels/TICKET']);

    const streamed: string[] = [];
    session.onOutput((data) => streamed.push(Buffer.from(data).toString()));
    fake.emit('hello ');
    fake.emit('world!', 1);
    expect(streamed).toEqual(['hello ', 'world!']);
    // The buffer keeps at most 10 bytes (oldest chunks dropped, the newest always kept).
    expect(session.get().output.map((chunk) => Buffer.from(chunk.data).toString())).toEqual([
      'world!',
    ]);
    expect(session.get().output[0]!.channel).toBe(1);

    session.write('ls\n');
    session.resize(40, 120);
    session.resize(0, 10);
    expect(fake.sent).toEqual([{ write: 'ls\n' }, { resize: [40, 120] }]);
    session.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.get()).toMatchObject({ status: 'closed', exit: { exitCode: 0, reason: 'bye' } });
  });

  it('opens a node console, and needs exactly one target', async () => {
    const calls: unknown[] = [];
    const api: ComputeRequester = {
      async $request<O>(path: string, input?: unknown) {
        calls.push([path, input]);
        return { tunnelId: 'tun_2', path: 'tunnels/T2' } as O;
      },
    };
    const fake = fakeTunnel();
    const session = createTerminalSession(api, {
      tenantId: 'root',
      nodeId: 'node_1',
      baseURL: 'https://compute.test',
      connect: () => fake.tunnel,
    });
    const opening = session.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.ready();
    await opening;
    expect(calls).toEqual([
      ['tunnels/open', { tenantId: 'root', nodeId: 'node_1', op: 'console' }],
    ]);
    expect(() => createTerminalSession(api, { tenantId: 'root', baseURL: 'https://x' })).toThrow(
      /exactly one/,
    );
    expect(() =>
      createTerminalSession(api, {
        tenantId: 'root',
        nodeId: 'node_1',
        instanceId: 'inst_1',
        baseURL: 'https://x',
      }),
    ).toThrow(/exactly one/);
  });

  it('reports a refused open', async () => {
    const api: ComputeRequester = {
      async $request() {
        throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' });
      },
    };
    const session = createTerminalSession(api, {
      tenantId: 'acme',
      instanceId: 'inst_1',
      baseURL: 'https://compute.test',
    });
    await session.open();
    expect(session.get()).toMatchObject({ status: 'error', error: { code: 'ACCESS_DENIED' } });
  });
});
