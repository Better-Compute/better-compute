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
ADMIN_COMPUTE_URL=http://127.0.0.1:3300/api/compute   # the API base, including its basePath
ADMIN_COMPUTE_TOKEN=biam_ses_…                         # optional: without it only public methods answer
ADMIN_COMPUTE_TENANT=ten_…                             # optional: the tenant views default to
```

or the same keys in `apps/admin/.upstream.json` (`{ "url", "token", "tenantId" }`, gitignored). Then pick
**Live API** in Settings → Connection. The browser reaches the API only through `POST /api/upstream/<method>`
(CSRF header required, token added server-side); `lib/api.ts` exposes it as a console-kit `ComputeRequester`.
Modules with a live source switch on `useWorkspaceSettings().source === 'live'`; widgets without one say "sim".

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

| Path                  | What                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `components/shell`    | Shell, palette, keyboard map, workspace (clock, scope, range, source), time travel, peek, tour |
| `components/widgets`  | Dashboards: presets, drag/resize, catalog, configure, persistence                             |
| `components/ui`       | Panel, PageHeader, Stat, Led/Tag, charts, DataTable (saved views), Drawer, Menu, feedback     |
| `components/base`     | BoardUI components (copies from apps/docs)                                                    |
| `components/overview` | Overview module: KPIs, utilization, attention, fleet wall, control plane, sites, digest       |
| `lib/data`            | Seeded generators over a shared topology; platform signals; formatting                        |
| `lib/api.ts`, `lib/upstream.ts`, `app/api/upstream` | The live connection                                             |

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
