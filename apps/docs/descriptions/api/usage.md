The hourly usage windows compute meters per allocation and hands to Better IAM billing, as the tenant can read them. `list` and `export` decide `compute:usage:read` on `compute-tenant/{tenantId}`, or on `compute-project/{projectId}` when the call names a project, since windows carry their project as a tag. `platform`, `deadLetters`, `retry` and `void` are the root tenant's: the cross-tenant view and the corrections to what the usage sink sent. They decide `compute:usage:read` (`compute:usage:manage` for `retry` and `void`) on `compute-fleet/global`, so only root can call them. A voided window is not usage: `list` and `export` leave it out of rows and totals, and `platform` counts it apart. See [Billing and usage](/docs/guides/iam/billing-and-usage).

## list

Lists the tenant's usage windows ordered by window start, optionally for one project, one meter and a time range; returns a page with a cursor.

- Each window carries its billing idempotency key (`cmp:<allocationId>:<windowStartMs>` for an allocation, which it also names as `allocationId`; `cmp:<kind>:<sourceId>:<windowStartMs>:<meter>` for another source), meter, quantity, bounds and tags, and, once the usage sink has handed it to IAM billing, `recordedAt` and the `outcome` (`recorded`, `duplicate`, `reattributed` or `dead-lettered`).
- `from` and `to` (epoch milliseconds) select windows that end after `from` and start before `to`; `to` not after `from` is `INVALID_INPUT`.
- `limit` is at most 500 (100 by default). A cursor this method did not return is `INVALID_INPUT`.
- Windows of every source appear, including the provider instance, grant, network and snapshot windows of the tenant's cloud VMs. Voided windows are left out; `includeVoided: true` lists them with `voided: true` and `voidedAt`. The reason root gave when voiding is root's and is never shown to tenants.

## export

Exports every usage window of a time range as CSV (the default) or JSON Lines, with the window count and the summed quantity per meter.

- `from` and `to` are required, and the range is at most 93 days; `to` not after `from`, or a longer range, is `INVALID_INPUT`.
- One export returns at most 50,000 windows; when more match, `truncated` is `true` and the range or meter should be narrowed.
- CSV has a header row and ISO 8601 timestamps; JSON Lines has one window object per line.
- Voided windows are in neither `data`, `count` nor `totals`; `voided` counts them.
- Cells a spreadsheet would read as a formula (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) are prefixed with `'`; the same holds for the CSV of `platform`.

## platform

Totals the usage windows of every tenant over a time range, grouped by any of `tenant`, `pool`, `meter`, `source` (the window's source kind: allocation, instance, grant, network, snapshot or cost) and `provider`. Root only: the decision is `compute:usage:read` on `compute-fleet/global`, which resolves only in the root tenant, so a tenant administrator gets `ACCESS_DENIED`.

- `groupBy` is required and lists each key at most once; an empty list gives one row for everything. `tenantId` narrows the view to one tenant.
- Each row has `keys` (the values of the `groupBy` keys; `''` where a window has no `pool` or `provider` tag), the summed `quantity`, the number of `windows`, and `outcomes`, the windows per outcome (`pending` for a window not yet handed to IAM billing).
- `from` and `to` are required and select windows by their start, `from` inclusive and `to` exclusive, so adjacent ranges never count a window twice. The range is at most 93 days; `to` not after `from`, or a longer range, is `INVALID_INPUT`.
- Voided windows are in no row; `voided` counts them for the same range and tenant.
- One call returns at most 50,000 groups; when more match, `truncated` is `true` and the grouping or range should be narrowed.
- `format: 'csv'` answers the same groups as `data` (a header row, the keys, `quantity`, `windows`, and `outcomes` as JSON) with `rows` empty; `count` is the number of groups either way.

## deadLetters

Root only. Lists the open dead letters of the usage sink (events Better IAM refused for good), ordered by idempotency key; returns a page with a cursor. Decides `compute:usage:read` on `compute-fleet/global`.

- Each item has `idempotencyKey`, `tenantId`, `meter`, `quantity`, `windowStart`, the better-iam `error` message and a `reason`: `meter-missing`, `period-closed`, `identity`, `invalid` or `other`. A letter disappears once a retry is recorded.
- A pass-through (`cost`) window's letter also has `cost`, its reported amount in currency units (the window's `cost_micros` / 10^6), so root can raise a Better IAM invoice item for a `period-closed` one. Rated usage has no `cost`.
- `reason` filters the list. `limit` is at most 500 (100 by default); a cursor this method did not return is `INVALID_INPUT`.

## retry

Root only. Clears the outcome of dead-lettered windows so the next usage flush sends them again. Decides `compute:usage:manage` on `compute-fleet/global`.

- Give `idempotencyKeys` (1 to 1000 open dead letters) or a `reason`, not both. A key without an open dead letter is `NOT_FOUND` and nothing is retried.
- `period-closed` letters are refused with `INVALID_STATE`: retrying would only fail again, and the usage needs a root invoice item in Better IAM (`billing.createInvoiceItem`).
- A key whose window retention already pruned is `NOT_FOUND` ("window pruned; record it in Better IAM by hand").
- Answers `retried`, the windows put back to pending (their claim is released too). A voided window stays voided. The letter stays open until a flush records the window.

## void

Root only. Voids usage windows no flush has sent, and dead-lettered ones, so no flush ever sends them: sets `voided_at` and `void_reason`. Decides `compute:usage:manage` on `compute-fleet/global`.

- `idempotencyKeys` (1 to 1000) and a `reason` are required.
- Voidable: a pending window, and a dead-lettered one (Better IAM refused it; nothing was billed). Voiding any window resolves its open dead letters.
- A window Better IAM recorded (outcome `recorded`, `duplicate` or `reattributed`) gives `INVALID_STATE` with the hint to issue a credit note in Better IAM. A window a usage flush claimed within the last 10 minutes is being sent and gives `INVALID_STATE` ("being sent; retry shortly"); a claim older than that belongs to a dead sender and does not block. An unknown key is `NOT_FOUND`. The call is all or nothing.
- A window voided before is left as it is and counted in `alreadyVoided`.
- Voided windows are left out of the tenants' `usage.list` and `usage.export`, and of `usage.platform` rows (which counts them apart).
