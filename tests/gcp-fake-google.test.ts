import { describe, expect, it } from 'vitest';
import { FakeGoogle } from './support/gcp/fake-google.js';

// The FakeGoogle path templates follow Google's: `{name}` is one segment that stops at a `:verb`.

describe('FakeGoogle route templates', () => {
  const call = async (fake: FakeGoogle, path: string, method = 'POST') => {
    const response = await fake.fetch(`https://x.googleapis.com${path}`, {
      method,
      headers: { authorization: 'Bearer fake-token' },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it('{id} does not match a :verb, and {id}:verb does', async () => {
    const fake = new FakeGoogle()
      .route('POST', '/x/{id}', () => ({ body: { route: 'plain' } }))
      .route('POST', '/x/{id}:cancel', (_request, params) => ({
        body: { route: 'cancel', id: params.id },
      }));
    expect((await call(fake, '/x/abc')).body).toEqual({ route: 'plain' });
    expect((await call(fake, '/x/abc:cancel')).body).toEqual({ route: 'cancel', id: 'abc' });
  });

  it('a lone /x/{id} route does not answer /x/abc:cancel', async () => {
    const fake = new FakeGoogle().route('POST', '/x/{id}', () => ({ body: {} }));
    expect((await call(fake, '/x/abc:cancel')).status).toBe(404);
    expect((await call(fake, '/x/abc')).status).toBe(200);
  });

  it('{name=**} still takes the rest of the path, colons included', async () => {
    const fake = new FakeGoogle().route('GET', '/v1/{name=**}', (_request, params) => ({
      body: { name: params.name },
    }));
    expect((await call(fake, '/v1/projects/p/things/t:verb', 'GET')).body).toEqual({
      name: 'projects/p/things/t:verb',
    });
  });
});
