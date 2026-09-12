# Keep desktop E2E windows in the background by default

Status: implemented
Translation: current

[中文](2026-09-12-desktop-e2e-window-visibility.zh.md)

## Abstract

Desktop E2E continues to launch the built Lody application, real Electron main process,
preload, renderer, IPC graph, and bundled CLI, but its product windows remain hidden by
default. This prevents each serial Cucumber scenario from activating Lody and taking
keyboard focus from the developer. `LODY_E2E_SHOW_WINDOW=1` restores normal visible
windows for interactive debugging. Hidden E2E renderers disable Chromium background
throttling so timers and performance instrumentation continue to run normally.

## Decision

- Apply hidden mode only when the unpackaged application receives `LODY_E2E=1`.
  Packaged applications ignore the test window flags and retain normal visibility and
  throttling behavior.
- Keep `show: false` during construction in every mode. On `ready-to-show`, ordinary
  desktop launches and explicit headed E2E runs call `show()`; default E2E runs do not.
- Set `backgroundThrottling: false` for both hidden and headed E2E runs. The headed
  switch changes visibility only, so it does not create a second timing profile.
- Forward only `LODY_E2E_SHOW_WINDOW` through the harness environment allowlist. Other
  inherited Lody variables remain excluded from isolated scenario processes.
- Keep Cucumber serial. Window visibility removes desktop interference but does not
  resolve the fixed operating-system endpoints that currently prevent parallel runs.

This decision complements the [five journey matrices](2026-09-12-desktop-e2e-user-journey-expansion.md)
without changing their interaction contract or public product intent, so no Spec revision
is required.

## Evidence and limits

The pure window policy test covers normal, hidden E2E, headed E2E, and packaged behavior.
The harness environment test proves that the headed switch crosses the isolation boundary
without admitting unrelated variables. Every harness launch also reads the real
`BrowserWindow` state after its first renderer frame and rejects the run unless visibility
matches the requested mode and background throttling is disabled. Real-Electron smoke and
full-suite validation passed four hidden smoke scenarios with 28 steps and 21 hidden scenarios
with 223 steps. One headed scenario with six steps also passed, proving the explicit visibility
override without changing the timing policy.
