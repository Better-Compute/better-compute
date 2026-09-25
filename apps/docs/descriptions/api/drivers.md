The drivers this deployment registered through its options, modules and plugins, so `metal.enroll` callers and the console can offer valid choices. The group returns declarations only, never a driver's configuration or credentials. See [Drivers](/docs/extending/drivers).

## list

Lists the registered drivers with their id, version, `runsOn`, implemented kinds, capabilities and the operations safe to retry per kind; `kind` keeps only drivers that implement it.

Decided with `compute:drivers:read` on `compute-tenant/{tenantId}`. Items are sorted by id, then version, and the result is not paged.
