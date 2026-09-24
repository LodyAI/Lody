# Official Devframe Hub UI for Desktop diagnostics

Status: implemented
Translation: current

[中文](2026-09-16-devbar-hub-ui.zh.md)

## Abstract

The first Desktop integration exposed diagnostics through Devframe but did not
provide Devframe's complete reference interface. Desktop now composes the official
Hub UI, JSON-render renderer, Inspector, and Accessibility Inspector behind one
loopback server. A separate in-product capability gate adds aggregate MCP and the
Terminals add-on. Filesystem management, code-server, and remote binding remain
excluded.

## Decision

`@devframes/hub` owns composition, connection state, docks, commands, settings,
messages, terminal aggregation, and MCP. `@devframes/hub-ui` supplies its unmodified
prebuilt standalone viewer and `embedded.js` floating dock. Lody's performance
definition registers a JSON-render view and projects it as a `json-render` dock;
`@devframes/json-render-ui` supplies the official `@antfu/design` renderer. Lody
keeps only the compact metrics footer and does not maintain a second detailed UI.
Because the Devframe 1.0 reference catalog does not include a chart component,
the Main Thread view renders its 60-sample FPS, CPU, heap, RSS, and blocked-time
trends as Unicode sparklines inside the stock DataTable. This preserves the
official renderer boundary while giving the dashboard a scannable time-series
view.

The Hub always mounts `plugin-inspect` and `plugin-a11y` with their published asset
packages. It mounts `plugin-terminals` and aggregate MCP only after the user enables
`Agent and terminal access`. Main Thread is the initial activation. The Hub's
automatic iframe entry for the headless `lody-devbar` definition is hidden so the
working JSON-render dock is the only user-facing performance entry.

Electron's user page is `file://`, while the reference Hub normally runs under a
same-origin web host. The node host therefore rewrites mounted iframe entries to
absolute loopback URLs before publication. The hidden Developer Mode control starts
the Hub and reloads the primary window through a separate `devbar.html` renderer
entry. That entry permits loopback scripts, frames, and connections plus the Iconify
endpoint used by the reference UI. The normal `index.html` CSP is unchanged, and
auxiliary windows stay on it. `LODY_DEVBAR=true` remains an automation override.

## Capability boundary

The Hub binds only to `127.0.0.1`, accepts the Lody `file://` page and its own
loopback origin, and rejects other browser origins. Browser auth is disabled inside
that single-user boundary. Devbar is off at each process launch and starts only from
the primary window's hidden Developer Mode control or the automation override.

The default Hub has no aggregate MCP endpoint or Terminals dock. The separate
`Agent and terminal access` switch restarts it with the performance and Inspector
agent surfaces plus Terminals tools. Terminals rejects arbitrary command requests,
but its interactive shell still grants general local process control. Stopping
Devbar closes the listener and removes both capabilities.

Do not add Assets, Code Server, filesystem operations, a non-loopback host, or
remote access under this decision. Those changes require a separate capability
and authentication review.

## Packaging

The Hub core remains bundled into Electron's CommonJS main output. UI and plugin
packages stay as runtime ESM imports so their `import.meta.url`-relative prebuilt
assets resolve from the installed packages. The matching `--assets` packages are
declared directly for packaged builds. All Devframe packages are pinned to 1.0.0;
only those reviewed versions bypass the repository's release-age quarantine.

## Verification

Node and web typechecks and the Electron application build pass. An isolated built
Desktop launch served the Hub index, embedded bootstrap, JSON renderer, and plugin
SPAs from loopback. A launch without `LODY_DEVBAR` verified the runtime sequence
off → Hub without MCP → Hub with MCP and Terminals → off. With the secondary
capability enabled, MCP initialization listed the performance, Inspector,
shared-state, and Terminals tools; shared dock state contained absolute loopback
iframe URLs and selected `lody-main-thread`. Static export, packaged cross-platform
launch, and remote deployment were not validated.

This decision partially supersedes the UI and subprocess exclusions in the
earlier [bridge decision](../architecture/2026-09-16-devbar-devframe-bridge.md).
Current guarantees are owned by the draft
[Desktop performance bar Spec](../../../../specs/desktop-devbar.md).

## Corrections

- 2026-09-16: A `Trends` iframe dock now sits next to Main Thread, served from
  Lody-owned loopback routes (`/__lody/chart`, `/__lody/chart.js`,
  `/__lody/snapshot.json`) on the Hub's origin. The page polls the snapshot route
  directly — no devframe client — and draws canvas line charts. This is a narrow
  exception to "Lody does not maintain a second detailed UI": it adds the
  time-series surface the JSON-render catalog lacks, not a parallel view
  stylesheet.
- 2026-09-16: The separate iframe dock was replaced by embedding: the visible
  `Main thread` dock is now a `custom-render` entry whose Lody-owned module
  (`/__lody/dock-renderer.mjs`) mounts the hidden JSON-render view through the
  client `renderers` registry and appends the canvas trends card inside the
  same dock. The sparkline `DataTable` was removed from the view spec — the
  real charts are its replacement, not a second display.
- 2026-09-16: The earlier "browser auth is disabled inside the single-user
  boundary" line is corrected. Accepting `Origin: null` was broader than the
  packaged `file://` page it was meant for: a sandboxed frame in an arbitrary
  website presents the same opaque origin and could reach the Hub's HTTP routes
  (and, with agent access enabled, the MCP route) through the permissive
  `cross-origin` resource policy. The Hub now installs a `DevframeAuthHandler`:
  the renderer learns a per-process token over IPC, presents it through
  `connectDevframe({ authToken })`, and exposes it to the embedded dock script
  via `__DEVFRAME_CONNECTION_AUTH_TOKEN__`. Hub-origin pages, the dev renderer
  origin, and non-browser callers without an Origin header stay trusted, so the
  standalone viewer and `devframe connect` are unchanged; opaque origins without
  the token can open a connection but `authorize` rejects every non-`anonymous:`
  method. Lody's own `/__lody/*` routes refuse `Origin: null` entirely. MCP
  keeps its existing `authorization: false` + Origin-gate posture; the token
  never enters the instance registry or agent-readable state.
- 2026-09-23: The separate `Agent and terminal access` gate was removed; the
  enabled Hub now always mounts aggregate MCP and Terminals. See
  [the merge decision](../simplification/2026-09-23-devbar-agent-access-merged.md).
