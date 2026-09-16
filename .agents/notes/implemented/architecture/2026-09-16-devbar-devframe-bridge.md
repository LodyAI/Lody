# Devframe bridge for Desktop diagnostics

Status: implemented
Translation: current

[中文](2026-09-16-devbar-devframe-bridge.zh.md)

## Abstract

The Desktop performance bar could show live counters but could not preserve a
short diagnostic history or expose it to coding agents. The bar now uses one
Devframe definition as a loopback RPC, shared-state, streaming, and read-only MCP
bridge while retaining its existing React surface. This first phase intentionally
excludes filesystem and subprocess control, standalone/static UI assets, and CPU
profile attribution; those capabilities require separate security and product
decisions.

## Problem and responsibilities

The existing bar owns renderer and Electron process measurements and must keep
working in packaged local builds without telemetry. Devframe owns the portable
transport and agent projection, not metric collection. The renderer records FPS,
CLS, heap, route, and Chromium Long Tasks; the Electron main process adds process
metrics, validates samples, bounds history, and serves the definition. Shared
schemas in `@lody/shared/devbar` are the contract across both processes.

## Decision

Start `lody-devbar` only when `LODY_DEVBAR=true`. It binds to `127.0.0.1` on the
first free port from 9765 through 9785 and uses the existing React footer/overlay
as its browser client. `record-sample` updates a shared snapshot and a replayable
stream; `get-snapshot` and a Markdown resource are the explicitly registered
agent-facing surfaces. Samples are capped at 120 and recent Long Tasks at 100, with
aggregate Long Task totals retained for the process lifetime. Devframe also
projects that shared state as a read-only MCP resource/tool.

Devframe browser authentication is disabled only for this single-user loopback
listener; MCP retains its loopback Origin gate. The surface contains diagnostic
data and has no file, shell, terminal, or process operations. A remote listener or
privileged RPC must restore authentication and define a capability policy first.
Bridge startup failure is non-fatal: local metrics and the overlay continue without
MCP or streaming. Coding-agent hosts use `devframe connect` so discovery follows
the runtime-selected port and requests carry the required loopback Origin header.

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
build adapter. The terminals add-on was not included: subprocess access is a
privileged capability unrelated to observing main-thread stalls. Long Tasks also
do not contain JavaScript stacks, so CPU profile capture remains a later feature.

This decision extends, rather than replaces, the original
[runtime bar decision](../feature/2026-09-08-desktop-devbar.md). Current guarantees
are owned by the draft [Desktop performance bar Spec](../../../../specs/desktop-devbar.md).
The later [official Hub UI decision](../feature/2026-09-16-devbar-hub-ui.md)
partially supersedes this note's UI and subprocess exclusions.

## Outcome and verification

Electron and shared-package typechecks pass. Seven deterministic Devbar tests cover
the runtime gate, metrics, CLS windows, bounded Long Task history, aggregate
recording, and deep-link selection. The Electron application build succeeds with
Devframe in the main bundle. A built-output smoke starts the server, fetches its
connection metadata, and completes the MCP initialize handshake through the
loopback Origin gate. This is not a packaged cross-platform launch, broad MCP-client
interoperability test, or CPU-profile validation.
