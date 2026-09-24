import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ComputeError, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { eventsMigrations, handleWatch } from '@better-compute/events';

// SSE /watch (PLAN.md §9.3): a tenant's outbox events, resumable with Last-Event-ID.

let db: SqlExecutor;
beforeAll(async () => {
  db = pglite();
  await db.migrate([...eventsMigrations]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query('DELETE FROM outbox');
});

const emit = (tenantId: string, type: string, n: number) =>
  db.query(`INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)`, [
    type,
    JSON.stringify({
      id: `evt_${type}_${n}`,
      type,
      tenantId,
      subject: `s/${n}`,
      time: new Date().toISOString(),
      data: { n },
    }),
  ]);

interface SseEvent {
  id: string;
  event: string;
  data: { id: string; type: string; tenantId: string; sequence: string };
}

/** Reads SSE events from a response until `count` arrived (or 3 s passed), then cancels the stream. */
async function collect(
  response: Response,
  count: number,
): Promise<{ events: SseEvent[]; raw: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const events: SseEvent[] = [];
  const deadline = Date.now() + 3000;
  while (events.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(
          () => resolve({ done: true, value: undefined }),
          Math.max(1, deadline - Date.now()),
        ),
      ),
    ]);
    if (chunk.done) break;
    raw += decoder.decode(chunk.value, { stream: true });
    const blocks = raw.split('\n\n');
    events.length = 0;
    for (const block of blocks) {
      const fields = Object.fromEntries(
        block
          .split('\n')
          .filter((line) => line && !line.startsWith(':'))
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
      );
      if (fields.data && fields.id)
        events.push({ id: fields.id, event: fields.event, data: JSON.parse(fields.data) });
    }
  }
  await reader.cancel();
  return { events, raw };
}

const watch = (url: string, init: RequestInit = {}, tenantId = 'ten_a') =>
  handleWatch(new Request(`https://compute.test${url}`, init), {
    sql: db,
    authorize: async () => ({ tenantId }),
    pollMs: 20,
  });

describe('handleWatch', () => {
  it('streams new events of the caller’s tenant only, from the tail', async () => {
    await emit('ten_a', 'reservation.placed', 0); // history: not replayed
    const response = await watch('/watch');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    await emit('ten_b', 'reservation.placed', 1);
    await emit('ten_a', 'reservation.placed', 2);
    await emit('ten_a', 'node.connected', 3);
    const { events, raw } = await collect(response, 2);
    expect(raw).toMatch(/^retry: 2000/);
    expect(events.map((event) => event.data.id)).toEqual([
      'evt_reservation.placed_2',
      'evt_node.connected_3',
    ]);
    expect(events.every((event) => event.data.tenantId === 'ten_a')).toBe(true);
    expect(events[0]!.id).toBe(events[0]!.data.sequence);
    expect(events[0]!.event).toBe('reservation.placed');
  });

  it('resumes after Last-Event-ID and filters by type', async () => {
    for (let n = 0; n < 12; n++)
      await emit('ten_a', n % 2 ? 'node.connected' : 'reservation.placed', n);
    const first = await collect(await watch('/watch?lastEventId=0.0'), 12);
    expect(first.events).toHaveLength(12);
    const resumeAt = first.events[9]!.id;
    const resumed = await collect(
      await watch('/watch', { headers: { 'last-event-id': resumeAt } }),
      2,
    );
    expect(resumed.events.map((event) => event.data.id)).toEqual([
      'evt_reservation.placed_10',
      'evt_node.connected_11',
    ]);
    const typed = await collect(await watch('/watch?lastEventId=0.0&types=node.*'), 6);
    expect(typed.events).toHaveLength(6);
    expect(typed.events.every((event) => event.event === 'node.connected')).toBe(true);
  });

  it('refuses unauthorized callers, bad cursors and bad methods with JSON errors', async () => {
    const denied = await handleWatch(new Request('https://compute.test/watch'), {
      sql: db,
      authorize: async () => {
        throw new ComputeError('ACCESS_DENIED', 'Access denied');
      },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: { code: 'ACCESS_DENIED', message: 'Access denied' },
    });
    expect((await watch('/watch', { headers: { 'last-event-id': 'nope' } })).status).toBe(400);
    expect((await watch('/watch?types=')).status).toBe(400);
    expect((await watch('/watch', { method: 'POST' })).status).toBe(405);
  });
});
