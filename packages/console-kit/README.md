# @better-compute/console-kit

Framework-free view models for better-compute consoles (PLAN.md §9.3, v0.5). React, Solid or Vue adapters stay thin: every store exposes `subscribe` + `get`, the contract of React's `useSyncExternalStore`.

```ts
import { createComputeClient } from '@better-compute/client';
import {
  createConsoleResources,
  createPermissions,
  describeAction,
  watchEvents,
} from '@better-compute/console-kit';

const client = createComputeClient({ baseURL, token: () => session.token });
const consoleStores = createConsoleResources(client, { tenantId });
await consoleStores.refreshAll();

// Live updates: each event re-reads the item it names; capacity refreshes debounced.
const watcher = watchEvents({
  url: `${baseURL}/api/compute/watch`,
  headers: () => ({ authorization: `Bearer ${session.token}` }),
  onEvent: (event) => void consoleStores.applyEvent(event),
});

// Enable a button only when IAM would allow it (the server still decides the call).
const permissions = createPermissions({ authorize: (checks) => iam.authorizeMany(checks) });
const release = describeAction('reservations', 'release', reservation.id);
const allowed = await permissions.can(release);
```

- **Lists** (`createListResource`) follow the server's list recipe (`{ items, cursor? }`).
  - `refresh()` reloads, and a stale response never overwrites a newer one.
  - `loadMore()` appends the next page.
  - `upsert`/`remove` apply changes from events.
  - After an error, the list keeps the last good items.
- **Stores**: `nodes`, `pools`, `reservations`, `instances` (vps) and `capacity` (summary) for one tenant.
  - `applyEvent` routes `reservation/…`, `node/…`, `instance/…` and `pool/…` subjects to the store they concern.
  - An item that no longer exists or is no longer visible is dropped.
- **Events** (`watchEvents`): Server-Sent Events read over `fetch`, so the request can carry an Authorization header.
  - A reconnect sends `Last-Event-ID` and resumes exactly after the last event.
  - It reconnects with the server's `retry:` delay, with capped exponential backoff after failures.
- **Actions**: `describeAction(group, method, id)` and `actionsFor(kind, id)` map buttons to the §9.2 IAM action and prefixed resource, read from core's `apiSurface`.
  - `createPermissions` batches checks (50 per call) within one tick and caches answers for 10 s.
  - A failed batch rejects; it never answers "denied".

## License

[Apache License 2.0](LICENSE)
