# @better-compute/console

The better-compute web console (PLAN.md §9.3): better-iam and better-compute in one Next.js process on one origin
(`/api/iam`, `/api/compute`), so the IAM session cookie authenticates both. Pages are built on
`@better-compute/console-kit`.

```bash
node ../../node_modules/next/dist/bin/next dev -p 3100
```

On first start the root administrator is created and, unless `CONSOLE_ADMIN_PASSWORD` is set, its generated password
is printed once. Sign in at `/login`; organization members use `/login?org=<slug>`.

| Page                         | What it shows                                                     |
| ---------------------------- | ----------------------------------------------------------------- |
| Overview                     | Capacity per pool, quota alerts                                   |
| Reservations                 | The reservation form (capacity preview, approvals) and the list   |
| Instances                    | The instance form (sizes per pool), the list, detail and terminal |
| Nodes                        | Filterable node table; a node's conditions and cordon / drain     |
| Pools & capacity, Quotas     | Pools offered or owned; used of max per pool                      |
| Rollouts, Fleet drift (root) | Daemon rollouts wave by wave; drift from the applied FleetConfig  |

## Configuration

| Variable                                                       | Default                                     |
| -------------------------------------------------------------- | ------------------------------------------- |
| `CONSOLE_ORIGIN`                                               | `http://localhost:3100`                     |
| `CONSOLE_SECRET`                                               | generated into `.console-data/secret` (dev) |
| `CONSOLE_DATA_DIR`                                             | `.console-data`                             |
| `CONSOLE_IAM_DATABASE_URL`                                     | libSQL file `.console-data/iam.db`          |
| `BETTER_COMPUTE_DATABASE_URL`                                  | PGlite in `.console-data/compute`           |
| `CONSOLE_ADMIN_EMAIL` / `CONSOLE_ADMIN_PASSWORD`               | `admin@console.local` / generated           |
| `CONSOLE_RELEASE_PINS`, `CONSOLE_DOWNLOADS_URL`, `…_THRESHOLD` | unset: the rollout module is not mounted    |

The terminal needs the host to serve the tunnel WebSocket upgrade (`handleTunnel`) and a gateway relay; until then
it shows the server's refusal.
