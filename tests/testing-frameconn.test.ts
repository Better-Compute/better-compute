import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  AgentFrameSchema,
  ProtocolError,
  ServerFrameSchema,
  type AgentFrame,
} from '@better-compute/protocol';
import {
  DOWN,
  UP,
  createAgentLink,
  createFramePair,
  createRealtimeScheduler,
  createRng,
  createSimScheduler,
  type CloseInfo,
  type FramePairOptions,
  type LinkEvent,
} from '@better-compute/testing';

// FrameConn (PLAN.md §15): an in-memory Session stream with seeded faults on the sim scheduler.

type Msg = { n: number; tag?: string };

function pair(options: Partial<FramePairOptions<Msg, Msg>> = {}) {
  const scheduler = createSimScheduler({ start: 0 });
  const link = createFramePair<Msg, Msg>({
    scheduler,
    id: 'test',
    rng: createRng('frameconn'),
    ...options,
  });
  const atB: Msg[] = [];
  const atA: Msg[] = [];
  const closes: { side: string; info: CloseInfo }[] = [];
  link.b.onFrame((m) => void atB.push(m));
  link.a.onFrame((m) => void atA.push(m));
  link.a.onClose((info) => void closes.push({ side: 'a', info }));
  link.b.onClose((info) => void closes.push({ side: 'b', info }));
  return { scheduler, ...link, atA, atB, closes };
}

const ns = (msgs: Msg[]) => msgs.map((m) => m.n);

describe('delivery', () => {
  it('delivers in order after the latency, as copies', async () => {
    const { scheduler, a, atB } = pair({ faults: { latencyMs: 10 } });
    const sent = { n: 1 };
    a.send(sent);
    a.send({ n: 2 });
    sent.n = 99;
    await scheduler.advance(9);
    expect(atB).toEqual([]);
    await scheduler.advance(1);
    expect(ns(atB)).toEqual([1, 2]);
  });

  it('keeps FIFO order under jitter (head-of-line blocking)', async () => {
    const { scheduler, a, atB } = pair({ faults: { latencyMs: 5, jitterMs: 50 } });
    for (let n = 0; n < 50; n++) {
      a.send({ n });
      await scheduler.advance(1);
    }
    await scheduler.advance(200);
    expect(ns(atB)).toEqual(Array.from({ length: 50 }, (_, n) => n));
  });

  it('buffers frames that arrive before the handler and delivers them in order', async () => {
    const scheduler = createSimScheduler({ start: 0 });
    const { a, b } = createFramePair<Msg, Msg>({ scheduler });
    a.send({ n: 1 });
    a.send({ n: 2 });
    await scheduler.advance(10);
    const got: number[] = [];
    b.onFrame((m) => void got.push(m.n));
    a.send({ n: 3 });
    await scheduler.advance(10);
    expect(got).toEqual([1, 2, 3]);
  });

  it('awaits an async handler before the next frame', async () => {
    const scheduler = createSimScheduler({ start: 0 });
    const { a, b } = createFramePair<Msg, Msg>({ scheduler });
    const order: string[] = [];
    b.onFrame(async (m) => {
      order.push(`start ${m.n}`);
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push(`end ${m.n}`);
    });
    a.send({ n: 1 });
    a.send({ n: 2 });
    await scheduler.advance(5);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('encodes agent frames as protobuf and refuses oversized ones at send time', async () => {
    const scheduler = createSimScheduler({ start: 0 });
    const link = createAgentLink({ scheduler });
    const got: AgentFrame[] = [];
    link.server.onFrame((f) => void got.push(f));
    const frame = create(AgentFrameSchema, {
      msg: { case: 'heartbeat', value: { appliedGeneration: 7n } },
    });
    link.agent.send(frame);
    await scheduler.advance(5);
    expect(got[0]?.msg.case).toBe('heartbeat');
    expect(got[0]).not.toBe(frame);
    expect(link.control.stats(UP).bytes).toBeGreaterThan(0);
    const huge = create(AgentFrameSchema, {
      msg: {
        case: 'inventory',
        value: { section: 'gpus', content: new Uint8Array(6 * 1024 * 1024) },
      },
    });
    expect(() => link.agent.send(huge)).toThrow(ProtocolError);
  });
});

describe('faults', () => {
  it('drops, duplicates and reorders deterministically from the seed', async () => {
    const run = async (seed: string) => {
      const scheduler = createSimScheduler({ start: 0 });
      const events: string[] = [];
      const { a, b, control } = createFramePair<Msg, Msg>({
        scheduler,
        rng: createRng(seed),
        faults: {
          latencyMs: 3,
          jitterMs: 4,
          drop: 0.1,
          duplicate: 0.1,
          reorder: 0.1,
          reorderWindowMs: 20,
        },
        observe: (e: LinkEvent) => {
          if (e.type !== 'close' && e.type !== 'fault')
            events.push(`${e.type}:${(e.frame as Msg).n}`);
        },
      });
      const got: number[] = [];
      b.onFrame((m) => void got.push(m.n));
      for (let n = 0; n < 200; n++) {
        a.send({ n });
        await scheduler.advance(1);
      }
      await scheduler.advance(100);
      return { got, events, stats: control.stats('a->b') };
    };
    const first = await run('seed-1');
    const again = await run('seed-1');
    const other = await run('seed-2');
    expect(again).toEqual(first);
    expect(other.events).not.toEqual(first.events);
    const { stats, got } = first;
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.duplicated).toBeGreaterThan(0);
    expect(stats.reordered).toBeGreaterThan(0);
    expect(got.length).toBe(200 - stats.dropped + stats.duplicated);
    const sorted = [...got].sort((x, y) => x - y);
    expect(got).not.toEqual(sorted);
  });

  it('targets the next frames and consults an interceptor', async () => {
    const { scheduler, a, atB, control } = pair();
    control.dropNext('a->b');
    control.duplicateNext('a->b');
    a.send({ n: 1 });
    a.send({ n: 2 });
    control.intercept('a->b', (m) =>
      (m as Msg).tag === 'hold' ? { delayMs: 30 } : (m as Msg).tag === 'x' ? 'drop' : undefined,
    );
    a.send({ n: 3, tag: 'hold' });
    a.send({ n: 4, tag: 'x' });
    a.send({ n: 5 });
    await scheduler.advance(100);
    expect(ns(atB)).toEqual([2, 2, 5, 3]);
  });

  it('a reset-mode drop breaks the stream for both ends', async () => {
    const { scheduler, a, b, atB, closes, control } = pair();
    a.send({ n: 1 });
    await scheduler.advance(5);
    control.configure('a->b', { drop: 1, dropMode: 'reset' });
    expect(a.send({ n: 2 })).toBe(true);
    await scheduler.advance(5);
    expect(a.closed && b.closed).toBe(true);
    expect(closes.map((c) => `${c.side}:${c.info.by}`).sort()).toEqual(['a:fault', 'b:fault']);
    expect(a.send({ n: 3 })).toBe(false);
    expect(ns(atB)).toEqual([1]);
  });

  it('stalls hold frames and pings, then deliver them in order', async () => {
    const { scheduler, a, atB, control } = pair({ faults: { latencyMs: 2 } });
    control.stall('a->b', 100);
    const pings: boolean[] = [];
    a.send({ n: 1 });
    a.ping(1_000, (alive) => void pings.push(alive));
    a.send({ n: 2 });
    await scheduler.advance(99);
    expect(atB).toEqual([]);
    expect(pings).toEqual([]);
    await scheduler.advance(10);
    expect(ns(atB)).toEqual([1, 2]);
    expect(pings).toEqual([true]);
  });

  it('a partition holds everything until heal; pings time out; a timed partition heals itself', async () => {
    const { scheduler, a, b, atA, atB, control } = pair({ faults: { latencyMs: 5 } });
    control.partition();
    expect(control.partitioned).toBe(true);
    a.send({ n: 1 });
    b.send({ n: 10 });
    const pings: boolean[] = [];
    a.ping(50, (alive) => void pings.push(alive));
    await scheduler.advance(1_000);
    expect(atB).toEqual([]);
    expect(atA).toEqual([]);
    expect(pings).toEqual([false]);
    a.send({ n: 2 });
    control.heal();
    await scheduler.advance(20);
    expect(ns(atB)).toEqual([1, 2]);
    expect(ns(atA)).toEqual([10]);
    control.partition(100);
    a.send({ n: 3 });
    await scheduler.advance(50);
    expect(ns(atB)).toEqual([1, 2]);
    await scheduler.advance(100);
    expect(ns(atB)).toEqual([1, 2, 3]);
    expect(control.partitioned).toBe(false);
  });

  it('a close sent during a partition arrives after the heal', async () => {
    const { scheduler, a, b, closes, control } = pair();
    control.partition();
    a.close('bye');
    await scheduler.advance(100);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    control.heal();
    await scheduler.advance(10);
    expect(b.closed).toBe(true);
    expect(closes).toEqual([
      { side: 'a', info: { reason: 'bye', by: 'local' } },
      { side: 'b', info: { reason: 'bye', by: 'remote' } },
    ]);
  });

  it('half-open: the dead end sees a close, the live end never does and its frames vanish', async () => {
    const { scheduler, a, b, atA, closes, control } = pair();
    control.halfOpen('a');
    await scheduler.advance(10);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(b.send({ n: 1 })).toBe(true);
    const pings: boolean[] = [];
    b.ping(100, (alive) => void pings.push(alive));
    await scheduler.advance(1_000);
    expect(atA).toEqual([]);
    expect(pings).toEqual([false]);
    expect(closes).toEqual([{ side: 'a', info: { reason: 'half-open', by: 'fault' } }]);
    control.heal();
    await scheduler.advance(100);
    expect(b.closed).toBe(false);
    expect(control.stats('b->a').dropped).toBe(1);
  });
});

describe('closing', () => {
  it('close() delivers frames in flight, then the peer sees the close', async () => {
    const { scheduler, a, b, atB, closes } = pair({ faults: { latencyMs: 10 } });
    a.send({ n: 1 });
    a.send({ n: 2 });
    a.close('done');
    expect(a.send({ n: 3 })).toBe(false);
    await scheduler.advance(50);
    expect(ns(atB)).toEqual([1, 2]);
    expect(b.closed).toBe(true);
    expect(b.closeInfo).toEqual({ reason: 'done', by: 'remote' });
    expect(closes.map((c) => c.side)).toEqual(['a', 'b']);
  });

  it('abort() discards frames in flight; the peer sees the reset after one latency', async () => {
    const { scheduler, a, b, atB } = pair({ faults: { latencyMs: 10 } });
    a.send({ n: 1 });
    a.abort('kill');
    await scheduler.advance(9);
    expect(b.closed).toBe(false);
    await scheduler.advance(1);
    expect(b.closed).toBe(true);
    expect(atB).toEqual([]);
    expect(b.send({ n: 9 })).toBe(false);
  });

  it('reset() closes both ends at once, and onClose fires for late subscribers', async () => {
    const { scheduler, a, b, control } = pair();
    control.reset('boom');
    expect(a.closed && b.closed).toBe(true);
    const late: CloseInfo[] = [];
    a.onClose((info) => void late.push(info));
    await scheduler.advance(1);
    expect(late).toEqual([{ reason: 'boom', by: 'fault' }]);
  });

  it('pings answer while the link is healthy', async () => {
    const { scheduler, a, b } = pair({ faults: { latencyMs: 7 } });
    const results: boolean[] = [];
    a.ping(100, (alive) => void results.push(alive));
    b.ping(100, (alive) => void results.push(alive));
    await scheduler.advance(14);
    expect(results).toEqual([true, true]);
    b.close();
    a.ping(100, (alive) => void results.push(alive));
    await scheduler.advance(200);
    expect(results).toEqual([true, true, false]);
  });
});

describe('agent link', () => {
  it('names the directions UP (daemon → gateway) and DOWN', async () => {
    const scheduler = createSimScheduler({ start: 0 });
    const link = createAgentLink({ scheduler, down: { latencyMs: 50 }, up: { latencyMs: 1 } });
    const upFrames: string[] = [];
    const downFrames: string[] = [];
    link.server.onFrame((f) => void upFrames.push(f.msg.case ?? ''));
    link.agent.onFrame((f) => void downFrames.push(f.msg.case ?? ''));
    link.agent.send(create(AgentFrameSchema, { msg: { case: 'heartbeat', value: {} } }));
    link.server.send(
      create(ServerFrameSchema, { msg: { case: 'drain', value: { reconnectAfterMs: 5 } } }),
    );
    await scheduler.advance(2);
    expect(upFrames).toEqual(['heartbeat']);
    expect(downFrames).toEqual([]);
    await scheduler.advance(50);
    expect(downFrames).toEqual(['drain']);
    expect(link.control.stats(DOWN).delivered).toBe(1);
  });

  it('works on the realtime scheduler too', async () => {
    const scheduler = createRealtimeScheduler();
    const link = createAgentLink({ scheduler, up: { latencyMs: 1 } });
    const got = new Promise<string>((resolve) =>
      link.server.onFrame((f) => resolve(f.msg.case ?? '')),
    );
    link.agent.send(create(AgentFrameSchema, { msg: { case: 'heartbeat', value: {} } }));
    await expect(got).resolves.toBe('heartbeat');
    link.control.reset();
  });
});

describe('sim scheduler', () => {
  it('runs tasks in (time, insertion) order and moves the clock to each', async () => {
    const scheduler = createSimScheduler({ start: 1_000 });
    const seen: string[] = [];
    scheduler.after(10, () => void seen.push(`b@${scheduler.now()}`));
    scheduler.after(5, () => {
      seen.push(`a@${scheduler.now()}`);
      scheduler.after(0, () => void seen.push(`a2@${scheduler.now()}`));
    });
    const cancelled = scheduler.after(7, () => void seen.push('never'));
    scheduler.after(10, () => void seen.push(`c@${scheduler.now()}`));
    cancelled.cancel();
    expect(scheduler.pending).toBe(3);
    await scheduler.advance(20);
    expect(seen).toEqual(['a@1005', 'a2@1005', 'b@1010', 'c@1010']);
    expect(scheduler.now()).toBe(1_020);
    const times: number[] = [];
    scheduler.onTime(async (ms) => void times.push(ms));
    scheduler.after(3, () => undefined);
    expect(await scheduler.step()).toBe(true);
    expect(times).toEqual([1_023]);
    expect(await scheduler.step()).toBe(false);
  });

  it('turns a zero-delay loop into an error', async () => {
    const scheduler = createSimScheduler({ start: 0, maxTasksPerAdvance: 1_000 });
    const loop = () => void scheduler.after(0, loop);
    loop();
    await expect(scheduler.advance(1)).rejects.toThrow(/reschedules itself/);
  });
});
