# Open standalone Today from its local page

Status: implemented
Translation: current

[中文](2026-11-25-today-window-local-open.zh.md)

## Abstract

Standalone Today previously cold-booted a desktop renderer and waited for the workspace
conversation metadata scan on every open. The first day now opens as soon as its workspace
runtime is available. Local desktop can reuse one previously opened renderer after leaving
its workspace route. A matching day commit reveals that window. A failed bind falls back to
a cold open.

The [shared-renderer companion](2026-11-25-today-shared-renderer.md) uses this independent path for fallback and handoff.

## Decision

The local outline can render before conversation projections. Workspace admission, slug and
ID still determine which runtime supplies the page. The top day acquires its store immediately
and earlier days keep viewport loading. The local Today window starts the conversation
metadata subscription after its first day paints, keeping the scan off the opening path.

Reuse begins after the first user open and retains one renderer while another product window
remains. The neutral route releases page references, runtime and sync resources through their
existing owners. Starting a hidden renderer at app launch would add memory cost even when
Today is unused. Cloud Today uses its existing close lifecycle. The
[developer prewarm pool](../feature/2026-09-18-desktop-window-prewarming.md) still serves
session and workspace opens.

Main accepts readiness from the bound window and current generation. A local read failure
can reveal the retry UI. If the renderer cannot bind within 1.5 seconds, main destroys it
and opens a fresh window for the requested day. Closing cancels pending work. The product
window registry removes hidden windows when the last product window closes.

## Verification

The [lifecycle tests](../../../../apps/electron/src/main/today-window-lifecycle.test.mjs)
cover binding identity, recovery, retention and close. The
[scope tests](../../../../packages/components/tests/workspace-data-scope.test.ts) cover
workspace identity with pending conversation metadata.

On Linux arm64 with Xvfb, the built Electron app and its bundled CLI ran the
instrumentation-only baseline (`9bd504d10`) and this implementation serially on
the same synthetic profiles. Each profile held a saved day. Cold results are
request to first day paint (four samples per build). Reopen results are request
to native show after the bound day commits (sixteen samples).

| Sessions | Baseline cold median | Current cold median | Reopen median |
| --- | ---: | ---: | ---: |
| 0 | 1,156 ms | 1,171 ms | 41 ms |
| 300 | 1,648 ms | 1,491 ms | 48 ms |

All sampled reopens were 28–71 ms. The probe checked the requested date and saved
text in both runs. Cold opens still pay for a new Electron renderer and the
application bundle. These timings cover the local build on this test host.
