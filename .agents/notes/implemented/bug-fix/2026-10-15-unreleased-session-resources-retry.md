# Retryable unreleased Session resources

Status: implemented
Translation: current

[中文](2026-10-15-unreleased-session-resources-retry.zh.md)

## Abstract

Termination can report failure even when a root ended or a process group contains only zombies. Process-tree verification accepts those cases and keeps real survivors observable. The [Inbox availability decision](2026-10-29-inbox-no-durable-block.md) replaces the former successor fence: failed Agent instances are detached and cleanup never blocks subsequent input.

## Process decision retained

A failed SIGKILL delivery still waits the bounded kill budget. Only visible zombie-only POSIX groups count as gone; an unavailable or empty scan while the kernel reports a group remains uncertain. The exact member scan starts only after a group survives 250 ms and at expired signal budgets; macOS ps can cost up to two seconds, so healthy exits avoid it. Windows root exit can succeed despite a partial taskkill failure. Session termination waits its process trees and sandbox concurrently, avoiding doubled waits. Becoming a subreaper was rejected because it could take children owned by Node handles. Under hidepid, a zombie-only visible group can omit foreign members we cannot signal.

The old preparation pool has been removed. Its retry/fencing policy and the rejected log-and-continue alternative are superseded by the linked availability decision; process failure evidence is retained, while the failed Agent is never reused.

## Verification limits

`packages/shared/tests/process.test.ts` covers injected process tables and clocks; `apps/cli/src/session/session-terminate-cleanup.test.ts` covers concurrent termination. Real Windows taskkill behavior and host-specific ps parsing remain separate acceptance.
