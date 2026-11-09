import { describe, expect, it } from 'vitest';
import {
  actionsFor,
  createConsoleResources,
  createListResource,
  createPermissions,
  describeAction,
  matchesType,
  parseSseBlock,
  startLiveConsole,
  watchEvents,
  type ComputeEventMessage,
  type ComputeRequester,
  type Item,
} from '@better-compute/console-kit';

// console-kit (PLAN.md §9.3 console, v0.5): framework-free stores, live event refresh and
// permission-aware actions over the compute API.

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('list resources', () => {
  it('pages, refreshes, drops stale responses and updates items in place', async () => {
    const pages: Record<string, { items: Item[]; cursor?: string }> = {
      first: { items: [{ id: 'a' }, { id: 'b' }], cursor: 'c1' },
      c1: { items: [{ id: 'b' }, { id: 'c' }] },
    };
    const list = createListResource<Item>({
      key: (item) => item.id,
      load: async (cursor) => pages[cursor ?? 'first']!,
    });
    const seen: string[] = [];
    list.subscribe(() => seen.push(list.get().status));
    await list.refresh();
    expect(list.get()).toMatchObject({ status: 'ready', hasMore: true });
    await list.loadMore();
    expect(list.get().items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(list.get().hasMore).toBe(false);
    list.upsert({ id: 'b', state: 'active' });
    list.upsert({ id: 'z' });
    list.remove('a');
    expect(list.get().items).toEqual([{ id: 'z' }, { id: 'b', state: 'active' }, { id: 'c' }]);
    expect(seen).toContain('loading');

    // A refresh supersedes a slower load in flight.
    const slow = deferred<{ items: Item[] }>();
    let calls = 0;
    const racing = createListResource<Item>({
      key: (item) => item.id,
      load: () => (++calls === 1 ? slow.promise : Promise.resolve({ items: [{ id: 'new' }] })),
    });
    const first = racing.refresh();
    await racing.refresh();
    slow.resolve({ items: [{ id: 'stale' }] });
    await first;
    expect(racing.get().items).toEqual([{ id: 'new' }]);
  });

  it('loadMore during a refresh is a no-op: the refresh lands, and the next page follows its cursor', async () => {
    type Answer = { items: Item[]; cursor?: string };
    const loads: {
      cursor: string | undefined;
      signal: AbortSignal;
      answer: ReturnType<typeof deferred<Answer>>;
    }[] = [];
    const list = createListResource<Item>({
      key: (item) => item.id,
      load: (cursor, signal) => {
        const answer = deferred<Answer>();
        loads.push({ cursor, signal, answer });
        return answer.promise;
      },
    });
    const first = list.refresh();
    loads[0]!.answer.resolve({ items: [{ id: 'old' }], cursor: 'c1' });
    await first;
    expect(list.get()).toMatchObject({ status: 'ready', hasMore: true });

    const refreshing = list.refresh();
    const during = list.loadMore();
    // Nothing was started, and the refresh was not aborted.
    expect(loads).toHaveLength(2);
    expect(loads[1]!.signal.aborted).toBe(false);
    await during;
    loads[1]!.answer.resolve({ items: [{ id: 'fresh' }], cursor: 'c9' });
    await refreshing;
    expect(list.get()).toMatchObject({ status: 'ready', items: [{ id: 'fresh' }], hasMore: true });

    // Afterwards the next page is the refreshed list's, and two calls share one load.
    const more = list.loadMore();
    const again = list.loadMore();
    expect(loads).toHaveLength(3);
    expect(loads[2]!.cursor).toBe('c9');
    loads[2]!.answer.resolve({ items: [{ id: 'next' }] });
    await Promise.all([more, again]);
    expect(list.get().items).toEqual([{ id: 'fresh' }, { id: 'next' }]);
    expect(list.get().hasMore).toBe(false);
  });

  it('keeps the last good items on error', async () => {
    let fail = false;
    const list = createListResource<Item>({
      key: (item) => item.id,
      load: async () => {
        if (fail) throw new Error('boom');
        return { items: [{ id: 'a' }] };
      },
    });
    await list.refresh();
    fail = true;
    await list.refresh();
    expect(list.get()).toMatchObject({ status: 'error', items: [{ id: 'a' }] });
  });
});

describe('console resources', () => {
  function fakeApi(responses: Record<string, (input: any) => unknown>) {
    const calls: { path: string; input: any }[] = [];
    const api: ComputeRequester = {
      async $request<O>(path: string, input?: unknown) {
        calls.push({ path, input });
        const respond = responses[path];
        if (!respond) throw Object.assign(new Error(`no ${path}`), { code: 'NOT_FOUND' });
        return respond(input) as O;
      },
    };
    return { api, calls };
  }

  it('loads each store and keeps them current from events', async () => {
    const timers: (() => void)[] = [];
    let reservation: Item | undefined = { id: 'rsv_1', state: 'active' };
    const { api, calls } = fakeApi({
      'nodes/list': () => ({ items: [{ id: 'node_1' }] }),
      'pools/list': () => ({ items: [{ id: 'pool_1' }] }),
      'reservations/list': () => ({ items: [{ id: 'rsv_1', state: 'placed' }] }),
      'instances/list': () => ({ items: [] }),
      'capacity/summary': () => ({ gpus: 8 }),
      'reservations/get': () => {
        if (!reservation) throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
        return reservation;
      },
    });
    const console = createConsoleResources(api, {
      tenantId: 'acme',
      setTimer: (callback) => timers.push(callback),
    });
    await console.refreshAll();
    expect(calls.find((call) => call.path === 'nodes/list')!.input).toEqual({
      tenantId: 'acme',
      limit: 50,
    });
    expect(console.capacity.get().value).toEqual({ gpus: 8 });

    const event = (subject: string, type: string): ComputeEventMessage => ({
      id: '1',
      type,
      tenantId: 'acme',
      subject,
    });
    await console.applyEvent(event('reservation/rsv_1', 'reservation.active'));
    expect(console.reservations.find('rsv_1')).toEqual({ id: 'rsv_1', state: 'active' });
    // Capacity refreshes once per burst, after the debounce.
    await console.applyEvent(event('pool/pool_1', 'pool.updated'));
    expect(timers).toHaveLength(1);
    const before = calls.filter((call) => call.path === 'capacity/summary').length;
    timers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((call) => call.path === 'capacity/summary').length).toBe(before + 1);
    expect(calls.filter((call) => call.path === 'pools/list')).toHaveLength(2);

    reservation = undefined;
    await console.applyEvent(event('reservation/rsv_1', 'reservation.released'));
    expect(console.reservations.find('rsv_1')).toBeUndefined();
    // Other tenants' events are ignored.
    await console.applyEvent({
      ...event('reservation/rsv_2', 'reservation.placed'),
      tenantId: 'other',
    });
    expect(calls.filter((call) => call.path === 'reservations/get')).toHaveLength(2);
  });
});

describe('event stream', () => {
  it('parses SSE blocks and type patterns', () => {
    expect(parseSseBlock('id: 42\nevent: reservation.active\ndata: {"a":1}\ndata: x')).toEqual({
      id: '42',
      event: 'reservation.active',
      data: '{"a":1}\nx',
    });
    expect(parseSseBlock(': comment\nretry: 1500')).toEqual({ retry: 1500 });
    expect(matchesType('reservation.*', 'reservation.active')).toBe(true);
    expect(matchesType('node.connected', 'node.disconnected')).toBe(false);
    expect(matchesType('*', 'x')).toBe(true);
  });

  it('delivers events, resumes with Last-Event-ID after the server closes, and stops', async () => {
    const requests: { url: string; lastEventId: string | null; auth: string | null }[] = [];
    const bodies = [
      'retry: 5\n\nid: 1\nevent: node.connected\ndata: {"id":"e1","type":"node.connected","tenantId":"acme","subject":"node/n1"}\n\n',
      'id: 2\nevent: node.status\ndata: {"id":"e2","type":"node.status","tenantId":"acme","subject":"node/n1"}\n\n',
    ];
    const fetch = (async (input: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push({
        url: String(input),
        lastEventId: headers.get('last-event-id'),
        auth: headers.get('authorization'),
      });
      const body = bodies.shift();
      if (body === undefined) return new Response('nope', { status: 503 });
      return new Response(
        new ReadableStream({
          start(controller) {
            // Split mid-event to exercise buffering.
            const bytes = new TextEncoder().encode(body);
            controller.enqueue(bytes.slice(0, 20));
            controller.enqueue(bytes.slice(20));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const events: ComputeEventMessage[] = [];
    const statuses: string[] = [];
    const watcher = watchEvents({
      url: 'https://compute.test/api/compute/watch',
      types: ['node.*'],
      headers: () => ({ authorization: 'Bearer t' }),
      fetch,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
    });
    for (let i = 0; i < 100 && events.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    watcher.stop();
    await watcher.done;
    expect(events.map((event) => event.id)).toEqual(['e1', 'e2']);
    expect(watcher.lastEventId).toBe('2');
    expect(requests[0]).toEqual({
      url: 'https://compute.test/api/compute/watch?types=node.*',
      lastEventId: null,
      auth: 'Bearer t',
    });
    expect(requests[1]!.lastEventId).toBe('1');
    expect(statuses).toContain('open');
    expect(statuses.at(-1)).toBe('stopped');
  });
});

describe('live console', () => {
  it('loads, follows the stream, routes events and forgets permissions after access events', async () => {
    const calls: string[] = [];
    const api: ComputeRequester = {
      async $request<O>(path: string) {
        calls.push(path);
        return (path.endsWith('/get') ? { id: 'rsv_1', state: 'active' } : { items: [] }) as O;
      },
    };
    let cleared = 0;
    const permissions = {
      clear: () => cleared++,
    } as unknown as Parameters<typeof startLiveConsole>[1]['permissions'];
    const events = [
      'id: 1\ndata: {"id":"e1","type":"reservation.active","tenantId":"acme","subject":"reservation/rsv_1"}\n\n',
      'id: 2\ndata: {"id":"e2","type":"iam.binding.revoked","tenantId":"acme","subject":"tenant/acme"}\n\n',
    ].join('');
    const fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(events));
          },
        }),
      )) as unknown as typeof globalThis.fetch;
    const live = await startLiveConsole(api, {
      tenantId: 'acme',
      watchUrl: 'https://compute.test/api/compute/watch',
      fetch,
      permissions,
    });
    const seen: string[] = [];
    live.onEvent((event) => seen.push(event.type));
    for (let i = 0; i < 100 && live.connection.get().lastEventId !== 'e2'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual(
      expect.arrayContaining(['nodes/list', 'pools/list', 'reservations/list', 'reservations/get']),
    );
    expect(cleared).toBe(1);
    expect(live.connection.get()).toMatchObject({ status: 'open', lastEventId: 'e2' });
    await live.stop();
    expect(live.connection.get().status).toBe('stopped');
  });

  /** A compute API with one reservation, and a watch endpoint that streams only what happens while connected. */
  function world() {
    const reservation = { id: 'rsv_1', state: 'placed' };
    const calls: string[] = [];
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    /** What happens right after a list of reservations was answered. */
    const hooks: { afterList?: () => void } = {};
    const api: ComputeRequester = {
      async $request<O>(path: string) {
        calls.push(path);
        if (path === 'reservations/get') return { ...reservation } as O;
        if (path !== 'reservations/list') return { items: [] } as O;
        const snapshot = { items: [{ ...reservation }] };
        queueMicrotask(() => hooks.afterList?.());
        return snapshot as O;
      },
    };
    let sequence = 0;
    const activate = () => {
      reservation.state = 'active';
      const id = String(++sequence);
      const event = { id: `e${id}`, type: 'reservation.active', tenantId: 'acme', subject: 'reservation/rsv_1' };
      const bytes = new TextEncoder().encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
      // Nobody connected: nobody is told.
      for (const stream of streams) stream.enqueue(bytes);
    };
    const open = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => void streams.add(controller),
        }),
      );
    const lists = () => calls.filter((path) => path === 'reservations/list').length;
    return { api, calls, hooks, activate, open, lists, reservation };
  }
  const settled = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  };

  it('does not lose what happens between the first load and the stream: the stream is open first', async () => {
    const server = world();
    // The reservation becomes active right after its list was read, once.
    server.hooks.afterList = () => {
      delete server.hooks.afterList;
      server.activate();
    };
    const live = await startLiveConsole(server.api, {
      tenantId: 'acme',
      watchUrl: 'https://compute.test/api/compute/watch',
      fetch: (async () => server.open()) as unknown as typeof globalThis.fetch,
    });
    await settled(() => live.reservations.find('rsv_1')?.state === 'active');
    expect(live.reservations.find('rsv_1')).toEqual({ id: 'rsv_1', state: 'active' });
    // The event was held until the load finished, then applied: one list, one reread.
    expect(server.lists()).toBe(1);
    expect(server.calls.indexOf('reservations/get')).toBeGreaterThan(
      server.calls.lastIndexOf('reservations/list'),
    );
    expect(live.connection.get()).toMatchObject({ status: 'open', lastEventId: 'e1' });
    await live.stop();
  });

  it('loads once more when the stream opens only after the load, with nothing to resume from', async () => {
    const server = world();
    let attempts = 0;
    const fetch = (async () =>
      ++attempts === 1 ? new Response('down', { status: 503 }) : server.open()) as unknown as typeof globalThis.fetch;
    const live = await startLiveConsole(server.api, {
      tenantId: 'acme',
      watchUrl: 'https://compute.test/api/compute/watch',
      fetch,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    });
    // The first attempt failed: the console is up from its load, and nobody streams to it yet.
    expect(live.reservations.find('rsv_1')).toEqual({ id: 'rsv_1', state: 'placed' });
    expect(server.lists()).toBe(1);
    server.activate();
    await settled(() => live.reservations.find('rsv_1')?.state === 'active');
    expect(live.reservations.find('rsv_1')).toEqual({ id: 'rsv_1', state: 'active' });
    expect(server.lists()).toBe(2);
    expect(live.connection.get().status).toBe('open');
    await live.stop();
  });

  it('does not wait for a stream that will not answer: it loads, and loads once more when the stream opens', async () => {
    const server = world();
    const hung = deferred<Response>();
    const live = await startLiveConsole(server.api, {
      tenantId: 'acme',
      watchUrl: 'https://compute.test/api/compute/watch',
      fetch: (() => hung.promise) as unknown as typeof globalThis.fetch,
      openWaitMs: 5,
    });
    expect(live.connection.get().status).toBe('connecting');
    expect(live.reservations.find('rsv_1')).toEqual({ id: 'rsv_1', state: 'placed' });
    server.activate();
    hung.resolve(server.open());
    await settled(() => live.reservations.find('rsv_1')?.state === 'active');
    expect(live.reservations.find('rsv_1')).toEqual({ id: 'rsv_1', state: 'active' });
    expect(server.lists()).toBe(2);
    await live.stop();
  });
});

describe('permission-aware actions', () => {
  it('maps buttons to the §9.2 action and resource', () => {
    expect(describeAction('reservations', 'release', 'rsv_1')).toEqual({
      group: 'reservations',
      method: 'release',
      path: 'reservations/release',
      action: 'compute:reservations:release',
      resource: { type: 'compute-reservation', id: 'rsv_1' },
      kind: 'mutation',
    });
    const node = actionsFor('node', 'node_1').map((action) => action.path);
    expect(node).toEqual(expect.arrayContaining(['nodes/cordon', 'nodes/drain']));
    expect(node).not.toContain('nodes/list');
    expect(() => describeAction('nodes', 'nope', 'x')).toThrow();
  });

  it('a user who may only read flavors is offered no enabled instances/create on a pool', async () => {
    // `instances.estimate` is a read on the pool (flavors:read): it is no pool button, and create is not one either.
    const buttons = actionsFor('pool', 'pool_1');
    expect(buttons.map((action) => action.path)).not.toContain('instances/create');
    expect(buttons.map((action) => action.path)).not.toContain('instances/estimate');
    expect(buttons.every((action) => action.kind === 'mutation')).toBe(true);
    const permissions = createPermissions({
      authorize: async (checks) => checks.map((check) => check.action === 'compute:flavors:read'),
    });
    const enabled: string[] = [];
    for (const action of buttons)
      if (await permissions.can({ action: action.action, resource: action.resource }))
        enabled.push(action.path);
    expect(enabled).toEqual([]);
    // The estimate itself is decided as a flavors read on the pool.
    expect(describeAction('instances', 'estimate', 'pool_1')).toMatchObject({
      action: 'compute:flavors:read',
      resource: { type: 'compute-pool', id: 'pool_1' },
      kind: 'read',
    });
  });

  it('batches checks, caches answers and never turns a failure into "denied"', async () => {
    const batches: number[] = [];
    let now = 0;
    let fail = false;
    const permissions = createPermissions({
      now: () => now,
      authorize: async (checks) => {
        batches.push(checks.length);
        if (fail) throw new Error('IAM down');
        return checks.map((check) => check.resource.id !== 'forbidden');
      },
    });
    const check = (id: string) => ({
      action: 'compute:nodes:cordon',
      resource: { type: 'compute-node', id },
    });
    const answers = await Promise.all([
      permissions.can(check('a')),
      permissions.can(check('b')),
      permissions.can(check('forbidden')),
      permissions.can(check('a')),
    ]);
    expect(answers).toEqual([true, true, false, true]);
    expect(batches).toEqual([3]);
    expect(permissions.peek(check('a'))).toBe(true);
    expect(await permissions.can(check('b'))).toBe(true);
    expect(batches).toEqual([3]);
    now = 20_000; // past the 10 s cache
    expect(permissions.peek(check('a'))).toBeUndefined();
    fail = true;
    await expect(permissions.can(check('a'))).rejects.toThrow('IAM down');
    permissions.clear();
    expect(permissions.get().size).toBe(0);
  });
});
