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

## Evidence

- [Crash classification](../apps/electron/src/main/renderer-process-gone.ts)
- [Window event wiring](../apps/electron/src/main/window.ts)
- [Recovery screen](../apps/electron/src/renderer/src/recovery-entry.ts)
- [Deterministic classification tests](../apps/electron/src/main/renderer-process-gone.test.mjs)
- [React boundary](../packages/components/src/components/error-boundary.tsx)
- [Manual boundary recovery tests](../packages/components/tests/error-boundary-manual-recovery.test.tsx)
