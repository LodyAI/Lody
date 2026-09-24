# Route unsupported composer steering through the regular Queue

Status: implemented
Translation: current

PR: [#861](https://github.com/LodyAI/Lody/pull/861)

[中文](2026-09-21-unsupported-steer-regular-queue.zh.md)

## Abstract

A busy composer previously attempted Guide even when the capability cache did not
confirm native steering. The daemon's rejection promoted that message into history,
which could overtake existing queued messages and removed normal queue editing.
Composer routing now shares the queued-row capability predicate and appends to the
regular Queue unless acknowledged steering is authoritative and supported. Unknown
capabilities conservatively queue; native requests already submitted retain their
existing delivery and recovery semantics.

## Decision and ownership

The [submit-route resolver](../../../../packages/components/src/components/sessions/session-message-submit-route.ts)
requires `nativeSteerAvailable` in addition to live activity and an unfinished
assistant turn. `SessionChatInterface` derives that value from the current session's
ACP capability and passes the same value to composer routing and queued-row steering.
Its existing `queueInputBlocks` path owns queue acceptance and captured input/config;
this change adds no history writer, queue implementation, or recovery state.

Both a Guide preference and an inverted Queue shortcut use this gate. Capability
changes update the submission callback. Explicit force-direct/force-queue overrides
and idle dispatch keep their existing precedence. The first queued row's explicit
interrupt-and-send fallback remains unchanged.

This partially supersedes the composer fallback described in the
[per-row steer and inverted-send decision](../feature/2026-09-18-per-row-queue-steer-and-inverted-send.md).
Attempting an unsupported RPC was rejected as the normal routing strategy: proven
non-delivery recovery does not preserve the regular Queue's position or edit lifecycle.
A supported native steer can still be rejected at runtime; its history promotion and
unknown-delivery freeze remain governed by the
[history-write Spec](../../../../specs/session-history-writes.md).

## Verification

The owning route suite exercises configured Guide and inverted Queue against
supported, unsupported, absent, provisional, and unavailable capability states,
plus idle/ordering barriers and explicit overrides. Ablation removes only the
capability guard and reruns the same assertions, then restores the guard.
The focused route, capability, and queue-editing suites pass all 37 tests. Removing
only `nativeSteerAvailable &&` makes eight regression cases fail while twelve route
cases pass; restoring it returns all 37 focused tests to passing. Tests run in an
isolated checkout with the recorded ACP submodule revisions and frozen lockfile.
On Node 22.23.2, `pnpm check` passed typechecking, lint, and the component suite
(3,821 tests), then stopped at a Git fixture inheriting host commit signing.
With signing disabled only in test processes, the helper retry passed 34 tests,
CLI passed 2,825 (four existing skips), and Electron passed 152 after its runtime
was installed. The remaining i18n/import/platform/public-boundary checks passed,
as did `pnpm format`, scoped Oxfmt verification, and `pnpm run docs check`.
No live-provider or interactive desktop verification was performed.
