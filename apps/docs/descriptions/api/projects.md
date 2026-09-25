Projects group a tenant's work without creating more tenants. A project is app-owned, lives in one tenant, and its creator becomes its owner in the authorization projection; membership is a Better IAM relationship on `compute-project/{id}`. See [Tenancy](/docs/guides/iam/tenancy).

## create

Creates an `active` project with a DNS-label name that is unique in the tenant; returns the project.

- Decided with `compute:projects:manage` on `compute-tenant/{tenantId}`.
- Idempotent per tenant, caller identity and `idempotencyKey`: the project id derives from them, and the same request again returns the existing project without a second IAM decision. The same key with a different name is `CONFLICT`.
- A second project with the same name in the tenant is `CONFLICT`.
- Emits `project.created`.

## get

Returns one project of the tenant by id.

Decided with `compute:projects:read` on `compute-project/{projectId}`. `NOT_FOUND` when the project is not in the tenant.

## list

Lists the tenant's projects the caller may read, ordered by id, optionally filtered by `state` (`active` or `archived`); returns a page with a cursor.

Decided with `compute:projects:read` on the tenant, then per project. Items the caller may not read are dropped from the page, so a page can hold fewer than `limit` items (at most 50, the default) while a cursor is still returned.

## archive

Marks a project `archived` and increments its version; returns the project.

- Decided with `compute:projects:manage` on `compute-project/{projectId}`.
- Archiving an archived project returns it unchanged and emits nothing.
- Emits `project.archived`. `NOT_FOUND` when the project is not in the tenant.
