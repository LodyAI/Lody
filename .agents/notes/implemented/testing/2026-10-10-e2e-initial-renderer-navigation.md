# Wait for the application document before reading boot evidence

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1398

[中文](2026-10-10-e2e-initial-renderer-navigation.zh.md)

## Abstract

Two desktop smoke journeys failed in their launch hook before any scenario step,
because boot profiling evaluated a renderer context that initial navigation then
destroyed. The harness now waits for the built application entry document to reach
DOMContentLoaded before collecting boot evidence. This preserves early console and
trace capture and the existing launch deadline without retrying failed journeys.

## Evidence and decision

The complete [failed job log](https://github.com/LodyAI/Lody/actions/runs/38048553136/job/114202910380)
shows successful installation, suite checking and desktop build, followed by
`readBootProfile()` failures in ONBOARDING-001 and SESSION-005; four other smoke
journeys passed. Their artifacts contain a main-window-opened diagnostic but no
boot points. The renderer load failure appears during cleanup after the launch
exception, so it does not establish an earlier product failure.

`firstWindow()` observes window creation, before the asynchronous `loadFile()`
necessarily commits. The initial `about:blank` document can already have a complete
readyState. Wait for the exact built `index.html` URL, ignoring its route hash,
and its DOMContentLoaded event before the first renderer evaluation. Attach console
listeners and tracing first. Neither sleeps nor exception retries prove that the
correct document is ready. The [hidden-window policy](2026-09-12-desktop-e2e-window-visibility.md)
and real Electron/CLI boundary remain in place; product behavior and the
[query recovery decision](../bug-fix/2026-10-10-cloud-query-server-recovery.md) are unchanged.

## Verification

`pnpm --filter @lody/e2e check` passes the 24 scenario bindings, typecheck and 49
existing harness/tooling tests. `pnpm e2e:build` and the complete `pnpm e2e:smoke`
pass locally on Linux with an isolated Xvfb display: six scenarios and 40 steps,
including both CI failures. Xvfb readiness uses its display-fd signal; the display
and application processes are closed after the run. Changed-file lint and formatting
and repository documentation checks also pass. macOS validation remains owned by CI.

Root `pnpm check` passes typechecking and lint but exits in unchanged CLI tests:
18 failures across Roost history, native Git credentials, cloudflared and simulator
process suites. These include 30-second timeouts, subsequent leaked-mock assertions,
child fixture startup failures, and the local Git wrapper's `context_unreadable`
diagnostic. An unchanged mention-textarea test also reached its five-second timeout
before recursive testing stopped. This is not a passing full-suite result; no
unrelated test or timeout was changed.
