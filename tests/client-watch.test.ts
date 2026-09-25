import { afterEach, describe, expect, it } from 'vitest';
import { createComputeClient, type ComputeWatchEvent } from '@better-compute/client';
import { ComputeError } from '@better-compute/core';
import { handleWatch } from '@better-compute/events';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';

// The client's `$watch` (PLAN.md §9.3) over the events module's SSE `handleWatch`: events in commit
// order for the caller's tenant, resumed with Last-Event-ID, across the server closing the stream
// (reconnect), ended by `break`; a refused credential ends it with UNAUTHENTICATED.

afterEach(closeFixtures);

const ORIGIN = 'https://compute.test';

function transport(fixture: ComputeFixture) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/api/compute/watch')
      return handleWatch(request, {
        sql: fixture.database,
        authorize: async (watch) => {
          const token = watch.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
          if (!token) throw new ComputeError('UNAUTHENTICATED', 'A credential is required');
          const caller = await fixture.compute.context.iam.authenticate({ token });
          return { tenantId: caller.tenantId };
        },
        pollMs: 20,
        retryMs: 30,
        // Short streams, so the test crosses a reconnect.
        maxDurationMs: 400,
      });
    return fixture.compute.handler(request);
  };
}

describe('$watch', () => {
  it('follows the tenant’s events, resumes after a cursor, and reconnects after the server closes', async () => {
    const fixture = await computeFixture({ clock: 'system' });
    const acme = fixture.tenants.acme;
    fixture.iam.allow({ token: acme.token });
    const client = createComputeClient<any>({
      baseURL: ORIGIN,
      token: acme.token,
      fetch: transport(fixture),
    });
    const create = (name: string) =>
      client.projects.create({ tenantId: acme.id, name, idempotencyKey: `watch-${name}` });
    // A watch without a cursor starts at the outbox tail: these commit once it is open.
    setTimeout(() => void create('one').then(() => create('two')), 150);
    const seen: ComputeWatchEvent[] = [];
    for await (const event of client.$watch({ types: ['project.*'] })) {
      seen.push(event);
      if (seen.length === 2) {
        // Created after the first stream closed (400 ms): arrives through a reconnect.
        setTimeout(() => void create('three'), 600);
      }
      if (seen.length === 3) break;
    }
    expect(seen.map((event) => (event.data as { name: string }).name)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(seen.every((event) => event.tenantId === acme.id && event.sequence)).toBe(true);

    // Resuming after the first event starts with the second.
    for await (const event of client.$watch({
      types: ['project.created'],
      lastEventId: seen[0]!.sequence!,
    })) {
      expect((event.data as { name: string }).name).toBe('two');
      break;
    }
  }, 30_000);

  it('ends with UNAUTHENTICATED when the stream refuses the credential', async () => {
    const fixture = await computeFixture({ clock: 'system' });
    let told = 0;
    const client = createComputeClient<any>({
      baseURL: ORIGIN,
      fetch: transport(fixture),
      onUnauthenticated: () => void told++,
    });
    await expect(
      (async () => {
        for await (const _ of client.$watch()) break;
      })(),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(told).toBe(1);
  });

  it('stops on its signal', async () => {
    const fixture = await computeFixture({ clock: 'system' });
    fixture.iam.allow({ token: fixture.tenants.acme.token });
    const client = createComputeClient<any>({
      baseURL: ORIGIN,
      token: fixture.tenants.acme.token,
      fetch: transport(fixture),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const events: unknown[] = [];
    for await (const event of client.$watch({ signal: controller.signal })) events.push(event);
    expect(events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
