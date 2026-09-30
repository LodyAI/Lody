# Prompt Shortcuts runtime retirement

Status: implemented
Translation: current

[中文](2026-09-25-prompt-shortcut-runtime-lifecycle.zh.md)

## Abstract

Prompt Shortcuts could crash the application when a mounted provider lost and
regained readiness for the same workspace. Cleanup disposed the runtime but left
it in React state, so matching account/workspace IDs later exposed that disposed
object to directory effects. Cleanup now withdraws its instance immediately, and
rendering checks the owning effect lifetime and all initialization dependencies.
The existing durable-close barrier remains in place; native device behavior still
requires manual verification.

## Cause and decision

`MainLayout` keeps the provider mounted across workspace readiness transitions.
Its workspace ID can therefore move from A to null and back to A without resetting
component state. Feature disable/re-enable and A → B → A transitions have the same
problem. `setDirectory` synchronously asserts that its runtime is active, explaining
why the stale reference reaches the route error boundary.

The provider now clears only the instance owned by its retiring effect. An active
lifetime predicate also fences retained state, while platform and cloud capability
checks cover the remaining initialization dependencies. New replicas still wait for
the previous writer's durable close. Making disposed runtime methods silently ignore
calls would hide stale consumers and leave the provider pointing at an unusable service.

This complements the [mobile beta control](2026-09-25-mobile-prompt-shortcuts-beta.md):
that control can trigger retirement, but the lifecycle bug affects every platform.

## Validation

The provider suite mounts under StrictMode and uses the real shortcut runtime with
injected storage/network boundaries. It covers readiness and feature toggles,
workspace return, a blocked durable close, and platform replacement. Explicit
promise barriers hold reopening pending so assertions check that consumers receive
loading state rather than the retired runtime. No timers or remote services are used.

All five cases pass with the fix. The unchanged provider fails four cases, including
three with the exact `Shortcut runtime disposed` error. Component typechecking,
changed-file lint/format checks, and documentation validation pass.
