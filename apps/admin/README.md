# @better-compute/admin

The operator admin panel for a better-compute fleet: capacity, nodes, workloads and the control plane in one
modular, keyboard-first workspace. Next.js 16 + [BoardUI](https://www.boardui.com) (components copied from
`apps/docs`), in the docs' "instrument" theme: graphite, thermal amber as the one signal hue, square corners,
IBM Plex Sans and Mono.

```bash
cd apps/admin && node node_modules/next/dist/bin/next dev --port 4200   # or .claude/launch.json "admin"
```

## Data: simulated or live

By default the panel runs on a deterministic **simulated fleet** (5 sites, 9 pools, 440 nodes), a pure
function of time, so the clock can be paused and scrubbed back 7 days (time travel). To read a real control
plane, configure it **on the admin server** (never in the browser):

```bash
ADMIN_COMPUTE_URL=http://127.0.0.1:3300/api/compute   # the API base, including its basePath (no credentials)
ADMIN_IAM_URL=http://127.0.0.1:3300/api/iam           # better-iam's API; default: the compute origin + /api/iam
ADMIN_COMPUTE_TENANT=ten_…                             # the platform (root) tenant operators sign in to by default
ADMIN_SESSION_SECRET=…                                 # 32+ characters; seals operator sessions (dev generates one)
ADMIN_COMPUTE_TOKEN=biam_ses_…                         # optional read-only shared connection for signed-out viewers
ADMIN_ALLOWED_HOSTS=admin.example.com                  # extra Host names when served behind a proxy
```

or `apps/admin/.upstream.json` (`{ "url", "iamUrl", "tenantId", "token" }`, gitignored) in development. Then
pick **Live API** in Settings → Connection.

**Security model.** The dev and start scripts bind to 127.0.0.1. The browser reaches the API only through
`POST /api/upstream/<method>`, which accepts only this admin's own page (Host/Origin allowlist plus the
`x-better-compute` header). Operators **sign in** (`/signin`) with their better-iam account; the admin keeps
their own session token sealed in an HttpOnly cookie and forwards it as the bearer, so every change is
authorized and audited as that person. Cookies ignore ports, so the cookie alone is not a session: it is bound
to a random key in this origin's localStorage (`lib/session-key.ts`, header `x-bc-session-key`), and a copy
replayed by another local server opens nothing. Sign-in is throttled per account (10 failures / 15 min), a
second-factor challenge takes 5 codes and signs in once, sign-out revokes the session here even when
better-iam can't be reached, and beyond loopback sign-in needs https (the cookie is then `__Host-`).
Signed out, the proxy only forwards read methods (by name: give `ADMIN_COMPUTE_TOKEN` a read-only role, the
API's authorization is the real boundary). `lib/api.ts`
exposes the proxy as a console-kit `ComputeRequester`; `useConnection().status.writable` says whether
changes are possible. Modules with a live source switch on `useWorkspaceSettings().source === 'live'`;
widgets without one say "sim".

## Modules

Everything the shell shows comes from `lib/modules.ts`. A module is one descriptor; add it to `modules` (one
line) and it appears in the sidebar, ⌘K, the shortcut sheet, the widget catalog, search, peeks, the status bar
and the attention queue. Its pages live under `app/(admin)/<route>/`.

| Field       | What it contributes                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `nav`       | Sidebar entries (grouped by `group`), breadcrumbs, `g`-chord shortcuts, palette "Go to"               |
| `widgets`   | Dashboard widgets: body only; `settings` (per-instance options), `live`, sizes, `href`                |
| `commands`  | Palette commands (pages add "This page" commands with `usePageCommands`)                               |
| `search`    | Entities for ⌘K: `(query, { now, siteId }) => SearchResult[]`                                           |
| `peeks`     | A compact view per entity kind, opened in a side sheet by `<EntityLink kind id>` from any page        |
| `status`    | Compact readouts in the status bar (`StatusItem`)                                                     |
| `attention` | Items that need an operator: `(now, scope, { source }) => AttentionItem[]` (pure: time travel)        |
| `watch`     | Per entity kind, `(id, now, { source }) => WatchState \| null`: the Watching widget and change toasts   |

Widgets get `{ size, editing, settings, updateSettings }`. `settings` are the instance's values for the
widget's declared `settings`; `updateSettings(patch)` lets a widget save its own state (a note, a filter).
Every widget can be pinned to a site in Configure (`useScope()` and `useLive()` follow the pin) and, with
`pins: { range: true }`, to a time range read through `useRange()`.

| Path                  | What                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `components/shell`    | Shell, palette, keyboard map, workspace (clock, scope, range, source), time travel, peek, tour |
| `components/widgets`  | Dashboards: presets, drag/resize, catalog, configure, persistence                             |
| `components/ui`       | Panel, PageHeader, Stat, Led/Tag, charts, DataTable (saved views), Drawer, Menu, feedback     |
| `components/base`     | BoardUI components (copies from apps/docs)                                                    |
| `components/overview` | Overview module: KPIs, utilization, attention, fleet wall, control plane, sites, digest       |
| `lib/data`            | Seeded generators over a shared topology; platform signals; formatting                        |
| `lib/api.ts`, `lib/upstream.ts`, `app/api/upstream` | The live connection                                             |

## For operators

- **Time travel**: the clock in the top bar scrubs back 7 days; `,` `.` step; "compare with now" pins a moment
  and the Overview shows what changed (`?compare=`). Links carry `?site=&range=&at=`.
- **Dashboards**: presets plus your own; arrange with the mouse or the keyboard (`e`, then arrows); configure
  and pin widgets; share with "Copy share link" (`?dashboard=`); export/import JSON in Settings.
- **Peek and watch**: click any id to peek; "watch" it to follow it in the Watching widget and get a toast when
  it changes. Critical items toast as they open.
- **Wall display**: `?kiosk=1` (or ⌘K → Wall display) for a NOC screen; dashboards rotate (`&rotate=45`).

## Tests and build

```bash
pnpm --filter @better-compute/admin test        # vitest over apps/admin/tests (pure logic, fixed clocks)
pnpm --filter @better-compute/admin build       # next build --webpack (Turbopack's build trips on next/font)
```

## Rules of the room

- Amber (`signal`) marks what is live, booked or needs an operator; red only what failed; the rest is graphite.
- Never call `Date.now()` in a simulated view: derive from the workspace clock. `useLive(fn, { bucketMs })` and
  `useNow(bucketMs)` re-render only when their bucket changes; `useWorkspaceSettings()` never re-renders on a
  tick; `useWorkspace()` does (every 2 s), so keep it out of heavy components.
- Destructive actions go through `useFeedback().confirm` (or `confirmWithReason`, with the API method shown),
  and are refused while the clock is in the past.
- Numbers are mono and tabular; ids are `<Mono>` or `<EntityLink>`; times are UTC.
- Keyboard: ⌘K or `/` palette, `g` + key to jump, `e` arrange, `p` pause, `,` `.` step time, `[` sidebar,
  `?` all keys.
