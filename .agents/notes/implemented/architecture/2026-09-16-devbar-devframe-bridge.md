# Devframe bridge for Desktop diagnostics

Status: implemented
Translation: current

[中文](2026-09-16-devbar-devframe-bridge.zh.md)

## Abstract

The Desktop performance bar could show live counters but could not preserve a
short diagnostic history or expose it to coding agents. The bar now uses one
Devframe definition as a loopback RPC, shared-state, and streaming bridge while
retaining its existing React surface. Agent projection is available only through
a second explicit capability gate. Filesystem control, standalone/static UI
assets, and CPU profile attribution remain separate security and product decisions.

## Problem and responsibilities

The existing bar owns renderer and Electron process measurements and must keep
working in packaged local builds without telemetry. Devframe owns the portable
transport and agent projection, not metric collection. The renderer records FPS,
CLS, heap, route, and Chromium Long Tasks; the Electron main process adds process
metrics, validates samples, bounds history, and serves the definition. Shared
schemas in `@lody/shared/devbar` are the contract across both processes.

## Decision

Ship `lody-devbar` in the production application but leave it off at process
launch. The hidden Developer Mode control starts it on demand and reloads only the
primary window through the Devbar-specific renderer entry; `LODY_DEVBAR=true`
remains an automation override. The server binds to `127.0.0.1` on the first free
port from 9765 through 9785 and uses the existing React footer/overlay as its
browser client. `record-sample` updates a shared snapshot and a replayable stream;
samples are capped at 120 and recent Long Tasks at 100, with aggregate Long Task
totals retained for the process lifetime.

Devframe browser authentication is disabled only for this single-user loopback
listener. The HTTP host accepts the packaged file renderer and its own origin and
rejects other browser origins. The default surface contains diagnostic data and no
shell, terminal, or process operations. Developer Mode provides a second switch
that restarts the Hub with aggregate MCP and the restricted Terminals add-on; the
later [official Hub UI decision](../feature/2026-09-16-devbar-hub-ui.md) owns that
privileged boundary. A remote listener must restore authentication and define a
capability policy first. Startup failure leaves the normal renderer active.

The installation-profile URL `<protocol>://devbar?view=main-thread` opens the
overlay. The Markdown agent resource includes this link, so an agent can report a
stall and direct the user to the same bounded history without receiving permission
to manipulate the application.

## Packaging and dependency policy

Electron's main output is CommonJS while Devframe 1.0 is ESM-only. Devframe is
therefore bundled into the main-process output instead of being externalized into
a runtime `require()`; `@devframes/agentic` remains a declared packaged dependency
loaded by Devframe's optional-peer adapter. Version 1.0.0 was released inside the
repository's seven-day dependency quarantine, so only the two reviewed exact
versions are listed in `minimumReleaseAgeExclude`; later releases remain quarantined.

## Alternatives and limits

A separate Devframe SPA would duplicate the established footer and delay the first
useful integration. It remains appropriate if diagnostics need a standalone or
static deployment, at which point the definition must gain client assets and the
build adapter. Subprocess access stays outside the default diagnostic capability
and requires its separate runtime switch. Long Tasks do not contain JavaScript
stacks, so CPU profile capture remains a later feature.

This decision extends, rather than replaces, the original
[runtime bar decision](../feature/2026-09-08-desktop-devbar.md). Current guarantees
are owned by the draft [Desktop performance bar Spec](../../../../specs/desktop-devbar.md).
The later [official Hub UI decision](../feature/2026-09-16-devbar-hub-ui.md)
partially supersedes this note's UI and subprocess exclusions.

## Outcome and verification

Electron and shared-package typechecks pass. Deterministic Devbar tests cover the
runtime and secondary capability gates, browser-origin boundary, renderer entry,
metrics, CLS windows, bounded Long Task history, aggregate recording, and deep-link
selection. The Electron application build succeeds with
Devframe in the main bundle. A built-output smoke starts the server, fetches its
connection metadata, and completes the MCP initialize handshake through the
loopback Origin gate. This is not a packaged cross-platform launch, broad MCP-client
interoperability test, or CPU-profile validation.

## Addendum: failure containment (2026-09-17)

The disabled-by-default boundary now also holds for failures inside the opt-in
path. The main process exits on uncaughtException, so the loopback request
listener (`createDevbarRequestListener`) catches a throwing route or Hub
middleware into an HTTP 500, and the HTTP server keeps a permanent `error`
listener after listen succeeds. Closing the Hub can no longer reject the disable
or quit path, and the renderer bar mounts inside a dedicated `ErrorBoundary`
that renders nothing on crash. A Devbar failure degrades to no diagnostics
instead of taking the application down. The deterministic suite covers the
listener's 500/503/404/403 branches.
