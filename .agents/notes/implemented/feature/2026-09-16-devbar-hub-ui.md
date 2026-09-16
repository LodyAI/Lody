# Official Devframe Hub UI for Desktop diagnostics

Status: implemented
Translation: current

[中文](2026-09-16-devbar-hub-ui.zh.md)

## Abstract

The first Desktop integration exposed diagnostics through Devframe but did not
provide Devframe's complete reference interface. Desktop now composes the official
Hub UI, JSON-render renderer, Inspector, Accessibility Inspector, and Terminals
add-ons behind one loopback server and aggregate MCP endpoint. This deliberately
adds local subprocess access under the explicit Devbar runtime gate; filesystem
management, code-server, and remote binding remain excluded.

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

The Hub also mounts `plugin-inspect`, `plugin-a11y`, and `plugin-terminals` with
their published asset packages. Main Thread is the initial activation. The Hub's
automatic iframe entry for the headless `lody-devbar` definition is hidden so the
working JSON-render dock is the only user-facing performance entry.

Electron's user page is `file://`, while the reference Hub normally runs under a
same-origin web host. The node host therefore rewrites mounted iframe entries to
absolute loopback URLs before publication. A separate `devbar.html` renderer entry
loads only when `LODY_DEVBAR=true`; it permits loopback scripts, frames, and
connections plus the Iconify endpoint used by the reference UI. The normal
`index.html` CSP is unchanged.

## Capability boundary

The Hub binds only to `127.0.0.1`, accepts the Lody `file://` page, and exists only
when the developer explicitly sets `LODY_DEVBAR=true`. Browser auth is disabled
inside that boundary. The aggregate MCP endpoint exposes the performance and
Inspector read surfaces plus Terminals tools. Terminals rejects arbitrary command
requests, but its interactive shell still grants general local process control;
this is the explicit subprocess capability requested for Devbar, not a read-only
extension of diagnostics.

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
Desktop launch served the Hub index, embedded bootstrap, JSON renderer, and all
three plugin SPAs from loopback. MCP initialization listed the performance,
Inspector, shared-state, and Terminals tools; shared dock state contained absolute
loopback iframe URLs and selected `lody-main-thread`. Static export, packaged
cross-platform launch, and remote deployment were not validated.

This decision partially supersedes the UI and subprocess exclusions in the
earlier [bridge decision](../architecture/2026-09-16-devbar-devframe-bridge.md).
Current guarantees are owned by the draft
[Desktop performance bar Spec](../../../../specs/desktop-devbar.md).
