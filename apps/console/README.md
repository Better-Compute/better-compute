# @better-compute/console

The better-compute web console (PLAN.md §9.3): better-iam and better-compute in one Next.js process on one origin
(`/api/iam`, `/api/compute`), so the IAM session cookie authenticates both. Pages are built on
`@better-compute/console-kit`.

```bash
node server.mjs --dev
```

`server.mjs` runs Next.js plus the WebSocket upgrade of `/api/compute/tunnels/{ticket}` (terminals and node
consoles), which Next route handlers cannot serve; `node server.mjs --prod` after `next build`.

`--dev` sets `CONSOLE_DEV=1`, the only mode in which the console generates secrets for itself: the session secret,
the exec ticket and SSH CA keys (under the data directory) and, on first start, the root administrator's password
(printed once). Without it every secret comes from the environment. Sign in at `/login`; organization members use
`/login?org=<slug>`.

| Page                         | What it shows                                                            |
| ---------------------------- | ------------------------------------------------------------------------ |
| Overview                     | Capacity per pool, quota alerts                                          |
| Reservations                 | The form (capacity preview, earliest start, approvals), list and detail  |
| Instances                    | The form (sizes per pool), the list, detail and terminal                 |
| Nodes                        | Filterable table; conditions, cordon / drain, console, break-glass SSH   |
| Pools & capacity             | Pools offered or owned; a 7-day booking calendar; join tokens / requests |
| Quotas, Usage & spend        | Used of max per pool; usage per meter, day, project and person; CSV      |
| Activity                     | The live event stream                                                    |
| Rollouts, Fleet drift (root) | Daemon rollouts wave by wave; drift from the applied FleetConfig         |

## Configuration

| Variable                                                       | Default (`--dev`) / otherwise                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `CONSOLE_ORIGIN`                                               | `http://localhost:3100`                                              |
| `CONSOLE_SECRET`                                               | generated into `.console-data/secret` / required                     |
| `CONSOLE_DATA_DIR`                                             | `.console-data`                                                      |
| `CONSOLE_IAM_DATABASE_URL`                                     | libSQL file `.console-data/iam.db`                                   |
| `BETTER_COMPUTE_DATABASE_URL`                                  | PGlite in `.console-data/compute`                                    |
| `CONSOLE_ADMIN_EMAIL` / `CONSOLE_ADMIN_PASSWORD`               | `admin@console.local` / generated / password required on first start |
| `CONSOLE_RELEASE_PINS`, `CONSOLE_DOWNLOADS_URL`, `…_THRESHOLD` | unset: the rollout module is not mounted                             |
| `CONSOLE_EXEC_TICKET_KEY_FILE`                                 | generated `exec-ticket.pem` / unset: tunnels off                     |
| `CONSOLE_SSH_CA_KEY_FILE`                                      | generated `ssh-ca.pem` / unset: no break-glass SSH                   |
| `CONSOLE_GATEWAY_TLS_CERT` / `_KEY` / `_CA`                    | all three or none; none (h2c gateways) only with `--dev`             |
| `PORT` / `HOSTNAME`                                            | `3100` / `localhost`                                                 |

Every replica and gateway must share the exec ticket key, and nodes pin its public key (and the SSH CA's), so
production supplies the key files. Tunnels relay through the gateway holding the node's session
(`gatewayTunnelRelay`, over mTLS), open only from this console's origin and, for a signed-in browser, only for that
person's own tickets; the caller is re-authorized for the tunnel's lifetime. Break-glass certificates name their node
(`root@<nodeId>`), so one opens no other node.
