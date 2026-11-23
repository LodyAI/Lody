# Desktop renderer fatal recovery

Status: draft
Translation: current

[中文](renderer-fatal-recovery.zh.md)

## Scenario

When Electron reports that a product renderer has exited unexpectedly, or an
internal React error boundary catches a render error, the user needs a stable
error screen long enough to read or copy the diagnostics. A background reload or
automatic boundary reset can erase that evidence and terminate error reporting
before it leaves the device.

## Behavior

Electron main records the renderer termination locally and sends a best-effort,
low-cardinality exception report from the process that survived the crash. It
then opens the recovery screen with the crash reason and exit code. The recovery
screen must not automatically reload the product renderer.

The React error boundary captures and reports caught render errors, then keeps its
copyable fallback visible even if its `resetKeys` change. Only an explicit Retry
or Reload action may clear that fallback or navigate the product renderer. Error
reporting is best effort: an unavailable network or disabled local-only telemetry
neither changes recovery behavior nor blocks the user from copying and reloading.

## Unresponsive windows

A stall is separate from a renderer crash. Main immediately records the incident,
window visibility and throttling, renderer PID, app/Electron versions and process
CPU/memory. It requests a JavaScript call stack without waiting for the renderer's
normal event loop. Only trusted product main documents opt into stack collection;
external pages and embedded frames do not. The session header hook is shared by all
product windows; future header policies must compose with it, not replace it.

Main asks the user after 10 seconds of continuing unresponsiveness. Recovery,
navigation and close invalidate that stall. A dialog can outlive recovery: choosing
Wait must never rearm a recovered stall. A new stall has its own incident identity;
only one dialog may be open per window. Reload and quit remain explicit actions.

Diagnostics are local in Electron's logs directory: `renderer-hang.jsonl` and one
rotated file (2 MiB each), plus the latest five macOS thread samples (at most 2 MiB
each). JS stacks are capped at 64 Ki characters and time out after five seconds;
at most one unresolved request remains per WebContents. Native sampling runs for
two seconds, with an eight-second deadline and at most one attempt per minute
across the app. Failure, timeout, unsupported platform and rate limiting are logged.
Diagnostics must not block recovery or upload stacks. Lifecycle records distinguish
initial detection, dialog opening, user choice, recovery and navigation.

A stack can identify the executing bundle function and position; matching build
source maps may be needed to recover original source names. Native samples help
with GC, rendering or native waits where no JS stack is available. Neither a single
sample nor a timeout proves a cause, and new instrumentation cannot recover an
uncaptured historical stall.

## Evidence

- [Crash classification](../apps/electron/src/main/renderer-process-gone.ts)
- [Window event wiring](../apps/electron/src/main/window.ts)
- [Recovery screen](../apps/electron/src/renderer/src/recovery-entry.ts)
- [Deterministic classification tests](../apps/electron/src/main/renderer-process-gone.test.mjs)
- [React boundary](../packages/components/src/components/error-boundary.tsx)
- [Manual boundary recovery tests](../packages/components/tests/error-boundary-manual-recovery.test.tsx)
