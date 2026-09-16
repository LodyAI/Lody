# Renderer crashes wait for the user before retrying

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/742

[中文](2026-09-16-renderer-crash-manual-recovery.zh.md)

## Abstract

An Electron renderer-process crash destroys the process that normally reports
frontend exceptions, while an automatic retry in either Electron or a React
error boundary removes diagnostics before the user can share them. Main now
classifies native termination, and React boundaries keep their copyable fallback
when `resetKeys` change; both wait for an explicit user recovery action. This
keeps local-only telemetry disabled and remains best effort when PostHog cannot
be reached; the trade-off is that a user must choose Retry or Reload.

## Decision

`render-process-gone` is handled by a pure classifier so the clean-exit path,
telemetry shape, and recovery payload are deterministic without an Electron
runtime. For every non-clean exit, `window.ts` starts the existing main-process
PostHog exception capture before loading the existing recovery page. The report
contains only the source, Chromium reason, and numeric exit code; it avoids
renderer content and diagnostics that may contain user data.

The recovery page is not a product reload. It is a minimal independent surface
that exposes the reason and exit code, persists the full local diagnostic record,
and keeps its Reload button user initiated. The shared React `ErrorBoundary`
follows the same rule: `resetKeys` remain accepted by its API, but cannot clear a
captured error; only its visible Retry or Reload action can do so. This is
deliberately different from waiting for renderer-side PostHog: a native-crashed
process is already gone, while a React boundary can keep its error visible as the
exception client flushes.

Buttonless boundaries need an owner-provided user action. The onboarding workspace
slug probe deliberately renders `null` after a query error because the form owns
the inline diagnostic and Retry button; that Retry now calls the boundary's public
reset method before remounting the probe. Leaving it to `resetKeys` would make the
retry inert under this contract and strand the required onboarding step.
The chat target selector instead renders its own compact Retry control from the
boundary fallback, so a transient selector failure remains recoverable without a
page reload.

## Alternatives considered

**Ask the failed renderer to report before reloading.** A terminated process
cannot reliably execute JavaScript or flush a network request, so it cannot make
the native-crash path dependable.

**Automatically retry after a fixed delay.** Rejected because it removes the
copyable context and can repeat the same edge case before a user can act.

## Verification

`renderer-process-gone.test.mjs` exercises both the clean-exit exclusion and a
crash payload, including the stable telemetry fields and recovery details.
`error-boundary-manual-recovery.test.tsx` proves reset-key changes retain the
crash screen and only a user retry renders the healthy subtree.
`workspace-screen.test.tsx` proves the buttonless slug probe recovers through its
form-owned Retry action. The inline-boundary case proves a fallback-provided
recovery action remounts its healthy subtree. A real renderer-process crash has
not been forced in a packaged desktop build.
