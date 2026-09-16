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
