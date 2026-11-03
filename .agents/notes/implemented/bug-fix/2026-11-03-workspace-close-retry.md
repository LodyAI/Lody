# Retry renderer cleanup without reviving its workspace

Status: implemented
Translation: current
PR: [#2279](https://github.com/LodyAI/Lody/pull/2279)

[中文](2026-11-03-workspace-close-retry.zh.md)

## Decision

RuntimeProvider retains both content-close owners across navigation. Successful
siblings stay closed; a rejected attempt is not cached as their final result.
The workspace runtime retries only unfinished close stages, shares concurrent
attempts and retains its original retirement fence between attempts. Native
reader ownership and admission checks remain unchanged. Same-binding acquisition
continues to drain the retained owner before creating a successor.

Transport/cache failures no longer destroy the Repo before recovery. The installed
loro-repo 0.25.0 sets `destroyed` before awaiting its children and returns immediately
on subsequent destroy calls. Therefore retrying a failed terminal destroy cannot
prove that storage or writers drained. That outcome remains blocked; only failures
before terminal destruction can retry. Clearing all rejected promises, ignoring
errors, or treating the SDK's later no-op as a successful close were rejected.

First failure diagnostics record the close stage and bounded, allowlisted cause
categories. They exclude arbitrary exception names, messages, stacks and identifiers.
Logging failure never changes the original close result.

## Evidence and scope

A synthetic admitted two-epoch native port drives the real RuntimeProvider and
IndexedDB Repo. An injected close failure was RED with the previous cached result;
after a controlled actual drain, the same binding reopens and reads its stored
history. Separate transport-close and uncertain-terminal-destroy cases retain the
no-overlap constraint. These are lifecycle fixtures, not native custody or product
acceptance. No crypto, ledger, grant, approval-return or key-delivery semantics change.

The native one-shot Scope failures in the [native diagnostics decision](2026-10-27-e2ee-recovery-diagnostics.md)
still require their existing recovery/restart boundary. That note is not superseded.
Promise Repo and parent React lifetimes remain external dependencies; no broader
Effect migration or new background recovery owner is introduced.
