# @better-compute/admin

The operator admin panel for a better-compute fleet: capacity, nodes, workloads and the control plane in one
modular, keyboard-first workspace. Next.js 16 + [BoardUI](https://www.boardui.com) (components copied from
`apps/docs`), in the docs' "instrument" theme: graphite, thermal amber as the one signal hue, square corners,
IBM Plex Sans and Mono.

```bash
cd apps/admin && node node_modules/next/dist/bin/next dev --port 4200   # or .claude/launch.json "admin"
```

The data is a deterministic **simulated fleet** today (labelled in the UI); every view reads it through
`lib/data`, so a live adapter over the compute API replaces the generators without touching pages.

## Modules

Everything the shell shows comes from `lib/modules.ts`. A module is one descriptor:

```ts
export const capacityModule: AdminModule = {
  id: 'capacity',
  title: 'Capacity',
  nav: [{ href: '/pools', label: 'Pools', icon: RiServerLine, group: 'Capacity', shortcut: 'g l' }],
  widgets: [{ id: 'capacity.heatmap', title: 'Heatmap', description: '…', icon, module: 'capacity',
              defaultSize: { w: 12, h: 4 }, component: Heatmap }],
  commands: [{ id: 'capacity.new', label: 'New reservation', group: 'Capacity', href: '/reservations/new' }],
};
```

Add it to the `modules` array (one line) and it appears in the sidebar, the ⌘K palette, the shortcut sheet and
the widget catalog. Its pages live under `app/(admin)/<route>/`. Widgets render only their body; the dashboard
draws the frame (title, menu, drag, resize, expand) and contains a crash to the one widget.

| Path                   | What                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `components/shell`     | Sidebar, top bar, command palette, keyboard map, workspace (clock, range, site scope)  |
| `components/widgets`   | Dashboards: presets, drag/resize, catalog, persistence                                 |
| `components/ui`        | Panel, PageHeader, Stat, Led/Tag, charts, DataTable, Drawer, Menu, Select              |
| `components/base`      | BoardUI components (unmodified copies from apps/docs)                                  |
| `components/overview`  | The Overview module: KPIs, utilization, attention, fleet wall, control plane, sites    |
| `lib/data`             | Seeded generators over a shared topology; `useLive` derives views from the clock       |

## Rules of the room

- Amber (`signal`) marks what is live, booked or needs an operator; red only what failed; the rest is graphite.
- Never call `Date.now()` in a view: take `now` from `useWorkspace()` or derive with `useLive`, so pausing (`p`)
  freezes the panel and server and client renders agree.
- Numbers are mono and tabular; ids are `<Mono>`; times are UTC.
- Keyboard: ⌘K or `/` palette, `g` + key to jump, `e` arrange the dashboard, `[` sidebar, `?` all keys.
