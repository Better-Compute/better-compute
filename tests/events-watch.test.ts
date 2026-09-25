import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ComputeError, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createWatchRegistry,
  eventsMigrations,
  handleWatch,
  type WatchRegistry,
  type WatchSubject,
} from '@better-compute/events';

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

/** Reads a stream to its end (or `ms`), returning the raw text and whether it ended by itself. */
async function drain(response: Response, ms = 2000): Promise<{ raw: string; ended: boolean }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const deadline = Date.now() + ms;
  for (;;) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk === 'timeout') {
      await reader.cancel();
      return { raw, ended: false };
    }
    if (chunk.done) return { raw, ended: true };
    raw += decoder.decode(chunk.value, { stream: true });
  }
}

describe('closing open streams (revocation, §16 v0.3)', () => {
  const open = (
    registry: WatchRegistry,
    subject: WatchSubject,
    extra: Partial<Parameters<typeof handleWatch>[1]> = {},
    tenantId = 'ten_a',
  ) =>
    handleWatch(new Request('https://compute.test/watch'), {
      sql: db,
      authorize: async () => ({ tenantId, subject }),
      registry,
      pollMs: 20,
      ...extra,
    });

  it('closes the streams a revoked delegation, agent or session opened, and no others', async () => {
    const registry = createWatchRegistry();
    const agent = await open(registry, {
      identityId: 'idn_alice',
      sessionId: 'ses_1',
      agentId: 'agt_1',
      delegationId: 'dlg_1',
    });
    const person = await open(registry, { identityId: 'idn_alice', sessionId: 'ses_2' });
    const other = await open(registry, { identityId: 'idn_bob', agentId: 'agt_2' }, {}, 'ten_b');
    expect(registry.size).toBe(3);
    expect(() => registry.closeWhere({ tenantId: 'ten_a' }, 'x')).toThrow(/needs/);

    expect(registry.closeWhere({ delegationId: 'dlg_1', agentId: 'agt_1' }, 'task finished')).toBe(
      1,
    );
    const closed = await drain(agent);
    expect(closed.ended).toBe(true);
    expect(closed.raw).toContain('event: error');
    expect(closed.raw).toContain('"code":"ACCESS_DENIED","message":"task finished"');
    expect(registry.size).toBe(2);

    // suspend-all in ten_a touches no person's stream; ten_b's agent is another tenant's.
    expect(registry.closeWhere({ tenantId: 'ten_a', anyAgent: true }, 'suspended')).toBe(0);
    expect(registry.closeWhere({ sessionId: 'ses_2' }, 'signed out')).toBe(1);
    expect((await drain(person)).raw).toContain('signed out');
    expect(registry.closeWhere({ tenantId: 'ten_b', anyAgent: true }, 'suspended')).toBe(1);
    expect((await drain(other)).ended).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('a consumer that goes away unregisters its stream', async () => {
    const registry = createWatchRegistry();
    const response = await open(registry, { sessionId: 'ses_9' });
    expect(registry.size).toBe(1);
    await drain(response, 50);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.size).toBe(0);
  });

  it('re-authorizes while open: a refusal closes it, a short IAM outage does not, a long one does', async () => {
    const registry = createWatchRegistry();
    let allowed = true;
    const refused = await open(
      registry,
      {},
      {
        authorize: async () => ({ tenantId: 'ten_a', reauthorize: async () => allowed }),
        reauthorizeMs: 30,
      },
    );
    await emit('ten_a', 'node.connected', 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    allowed = false;
    const first = await drain(refused);
    expect(first.ended).toBe(true);
    expect(first.raw).toContain('evt_node.connected_1');
    expect(first.raw).toContain('"message":"access revoked"');

    let failing = true;
    const brief = await open(
      registry,
      {},
      {
        authorize: async () => ({
          tenantId: 'ten_a',
          reauthorize: async () => {
            if (failing) throw new Error('IAM away');
            return true;
          },
        }),
        reauthorizeMs: 10,
        iamOutageMs: 400,
      },
    );
    setTimeout(() => (failing = false), 100);
    expect((await drain(brief, 600)).ended).toBe(false);

    const outage = await open(
      registry,
      {},
      {
        authorize: async () => ({
          tenantId: 'ten_a',
          reauthorize: () => Promise.reject(new Error('IAM away')),
        }),
        reauthorizeMs: 10,
        iamOutageMs: 100,
      },
    );
    const long = await drain(outage);
    expect(long.ended).toBe(true);
    expect(long.raw).toContain('authorization could not be re-checked');
  });
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
