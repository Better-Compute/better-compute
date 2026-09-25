import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { bridgeSocket } from '../packages/cli/src/commands/tunnel.js';

// The CLI's socket ↔ tunnel bridge (`forward`, `sandbox exec`) keeps memory bounded: the local socket pauses while
// the tunnel's send buffer is high, and a local reader too far behind is disconnected (a WebSocket cannot pause).

function fakes() {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    paused: false,
    writableLength: 0,
    written: [] as Uint8Array[],
    write(data: Uint8Array) {
      socket.written.push(data);
      return true;
    },
    destroy() {
      socket.destroyed = true;
    },
    pause() {
      socket.paused = true;
    },
    resume() {
      socket.paused = false;
    },
  });
  let deliver: (data: Uint8Array, channel: number) => void = () => undefined;
  const tunnel = {
    bufferedAmount: 0,
    sent: [] as Uint8Array[],
    write(data: Uint8Array) {
      tunnel.sent.push(data);
    },
    onData(handler: (data: Uint8Array, channel: number) => void) {
      deliver = handler;
    },
  };
  return { socket, tunnel, deliver: (data: Uint8Array) => deliver(data, 0) };
}

describe('bridgeSocket', () => {
  it('pauses the local socket while the tunnel is backed up, and resumes once it drains', async () => {
    const { socket, tunnel } = fakes();
    bridgeSocket(socket as never, tunnel as never, () => false);
    socket.emit('data', Buffer.from('a'));
    expect(socket.paused).toBe(false);
    tunnel.bufferedAmount = 5 * 1024 * 1024;
    socket.emit('data', Buffer.from('b'));
    expect(socket.paused).toBe(true);
    tunnel.bufferedAmount = 2 * 1024 * 1024; // above the low-water mark: still paused
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(socket.paused).toBe(true);
    tunnel.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(socket.paused).toBe(false);
    expect(tunnel.sent.map((bytes) => Buffer.from(bytes).toString())).toEqual(['a', 'b']);
  });

  it('disconnects a local reader that falls too far behind', () => {
    const { socket, tunnel, deliver } = fakes();
    bridgeSocket(socket as never, tunnel as never, () => false);
    deliver(Buffer.from('x'));
    expect(socket.written).toHaveLength(1);
    socket.writableLength = 17 * 1024 * 1024;
    deliver(Buffer.from('y'));
    expect(socket.destroyed).toBe(true);
    expect(socket.written).toHaveLength(1);
  });

  it('sends nothing once the connection is over', () => {
    const { socket, tunnel } = fakes();
    bridgeSocket(socket as never, tunnel as never, () => true);
    socket.emit('data', Buffer.from('late'));
    expect(tunnel.sent).toEqual([]);
  });
});
