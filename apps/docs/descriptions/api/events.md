A tenant's CloudEvents-style events, read from the transactional outbox that every change writes to in its own transaction. Pages follow the outbox's `txid:seq` position, so no event ever appears behind a cursor already handed out. See [Events](/docs/guides/events).

## list

Returns a page of the tenant's committed events after `cursor`, oldest first, optionally only those whose type starts with `type` (for example `node.` or `reservation.`).

- Decided with `compute:events:read` on `compute-tenant/{tenantId}`.
- The cursor is an event's `sequence` in the form `txid:seq`; without one the page starts at the oldest event still in the outbox.
- Only events whose transaction is older than every transaction still open are returned, so a later page never gains an event that sorts before its cursor.
- `limit` is at most 500 (100 by default).
