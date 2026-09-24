# @better-compute/client

The typed, browser-safe client for the better-compute API. Its types are inferred from the server
with a type-only import, so there is no code generation; at run time it is a small `fetch`
wrapper behind a Proxy.

```ts
import { createComputeClient } from 'better-compute/client';
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

- **Method shape.** Each server method `(credential, input)` becomes `(input, options?)`: the
  client supplies the credential. The input is optional when the server's has no required field
  (`client.system.version()`). Groups exist only for the modules and plugins the server was built
  with (`client.instances` is a type error without `vps()`).
- **Requests.**
  - Every call is `POST {basePath}/{group}/{method}` with JSON and `X-Better-Compute: 1`.
  - The default `basePath` is `/api/compute`.
  - `credentials` defaults to `'omit'`, because compute authenticates bearer tokens. A same-origin
    console that relies on the IAM cookie sets `credentials: 'same-origin'`.
  - `redirect` is `'error'` and `cache` is `'no-store'`.
- **Tokens.** An IAM bearer (`biam_…`) or a session JWT. Other shapes fail with `INVALID_TOKEN`
  before any request.
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
