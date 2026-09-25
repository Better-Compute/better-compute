The hourly usage windows compute meters per allocation and hands to Better IAM billing, as the tenant can read them. Both methods decide `compute:usage:read` on `compute-tenant/{tenantId}`, or on `compute-project/{projectId}` when the call names a project, since windows carry their project as a tag. See [Billing and usage](/docs/guides/iam/billing-and-usage).

## list

Lists the tenant's usage windows ordered by window start, optionally for one project, one meter and a time range; returns a page with a cursor.

- Each window carries its billing idempotency key (`cmp:<allocationId>:<windowStartMs>`), meter, quantity, bounds and tags, and, once the usage sink has handed it to IAM billing, `recordedAt` and the `outcome` (`recorded`, `duplicate`, `reattributed` or `dead-lettered`).
- `from` and `to` (epoch milliseconds) select windows that end after `from` and start before `to`; `to` not after `from` is `INVALID_INPUT`.
- `limit` is at most 500 (100 by default). A cursor this method did not return is `INVALID_INPUT`.

## export

Exports every usage window of a time range as CSV (the default) or JSON Lines, with the window count and the summed quantity per meter.

- `from` and `to` are required, and the range is at most 93 days; `to` not after `from`, or a longer range, is `INVALID_INPUT`.
- One export returns at most 50,000 windows; when more match, `truncated` is `true` and the range or meter should be narrowed.
- CSV has a header row and ISO 8601 timestamps; JSON Lines has one window object per line.
