# @better-compute/client

The typed, browser-safe client for the better-compute API, with types inferred from the server and a small `fetch` wrapper at run time.

## Install

```sh
npm install @better-compute/client
```

It is also included in the umbrella package as `better-compute/client`:

```sh
npm install better-compute
```

## Usage

```ts
import { createComputeClient } from '@better-compute/client';
import type { compute } from './compute.server'; // type-only

const client = createComputeClient<typeof compute>({
  baseURL: 'https://compute.example.com',
  token: () => session.getToken(), // read at every request, never stored
  requestId: true,
  retryRateLimited: true,
});
const { version } = await client.system.version();
await client.inventory.get({ tenantId, nodeId });
await client.plugins.acme.widgets.poke({ tenantId, widgetId }); // plugins by id
await client.$request('system/whoami'); // any route below the base path
```

The client's types come from the server with a type-only import, so there is no code generation.
At run time it is a small `fetch` wrapper behind a Proxy.

- **Method shape.** Each server method `(credential, input)` becomes `(input, options?)`: the
  client supplies the credential. The input is optional when the server's has no required field
  (`client.system.version()`). Groups exist only for the modules and plugins the server was built
  with (`client.instances` is a type error without `vps()`). `options` takes a `signal` and extra
  `headers`.
- **Requests.**
  - Every call is `POST {basePath}/{group}/{method}` with JSON and `X-Better-Compute: 1`.
  - The default `basePath` is `/api/compute`. `baseURL` defaults to the page's origin in a
    browser, and is required elsewhere.
  - `credentials` defaults to `'omit'`, because compute authenticates bearer tokens. A same-origin
    console that relies on the IAM cookie sets `credentials: 'same-origin'`.
  - `redirect` is `'error'` and `cache` is `'no-store'`.
  - `fetch` and `headers` can be supplied; `requestId` sends an `X-Request-Id` on every request.
- **Tokens.** A Better IAM bearer (`biam_…`) or a session JWT. Other shapes fail with
  `INVALID_TOKEN` before any request.
- **Errors.** Failures throw `ComputeClientError(code, message, status, retryAfterMs?, requestId?)`
  with `details` when the server sent them.
  - Client-side refusals have status `0`: `INVALID_CONFIG`, `INVALID_PATH`, `INVALID_TOKEN`,
    `INVALID_INPUT`.
  - A malformed answer is `INVALID_RESPONSE`.
  - `onUnauthenticated` runs once per `UNAUTHENTICATED` response.
  - `retryRateLimited` retries a `RATE_LIMITED` response once, when the wait is at most
    `maxWaitMs` (5 s by default).
- **Reserved segments.** `then`, `catch`, `finally`, `toJSON`, `constructor`, `prototype` and
  `__proto__` never route, so the client is not thenable.

## Watching events

`client.$watch(options?)` follows the server's Server-Sent Events stream (`GET {basePath}/watch`)
as the caller and yields events in commit order:

```ts
for await (const event of client.$watch({ types: ['reservation.*'] })) {
  console.log(event.type, event.subject);
}
```

It resumes with `Last-Event-ID` after every reconnect (the server's `retry:`, or capped back-off
after failures, `maxBackoffMs`, 30 s by default). `lastEventId` resumes after a known cursor,
`tenantId` follows another tenant's events, and `signal` (or `break`) ends it. `UNAUTHENTICATED`
and `ACCESS_DENIED` end it with a `ComputeClientError`.

## Tunnels

After `tunnels.open` returns a ticket path, `connectTunnel({ url: tunnelUrl(baseURL, basePath, path) })`
opens the WebSocket tunnel and exchanges tunnel frames, encoded by hand so the client needs no
protobuf runtime. The connection exposes `ready`, `exited`, `write`, `resize`, `onData`, `close`,
`terminate` and `bufferedAmount`. The ticket is single-use and valid for 60 s. `WebSocket`
defaults to the global one (browsers, Node.js 22+). `encodeTunnelFrame` and `decodeTunnelFrame`
are exported for other transports.

## Documentation

- [TypeScript client](https://better-compute.com/docs/guides/clients/typescript-client)
- [Watching events](https://better-compute.com/docs/guides/events/watch)
- [Tunnels](https://better-compute.com/docs/guides/access/tunnels)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
