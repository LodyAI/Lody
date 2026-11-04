# Shared command workspace manager

Status: implemented
Translation: current

[中文](2026-10-14-workspace-presence-manager-collision.zh.md)

> Later change: [daemon-hosted MCP workspace commands](../architecture/2026-10-16-daemon-hosted-mcp-workspace-commands.md) moves cloud MCP commands onto the daemon replica and removes the unreleased-presence fence described below.

## Abstract

Overlapping cloud commands share one document manager, avoiding duplicate presence acquisition while preserving authorization isolation and last-user cleanup. The fix stays in command composition and leaves presence, tokens and revocation unchanged.

## Cause and scope

Concurrent cloud MCP requests created separate temporary `LoroDocumentManager`s in one application. The workspace presence registry permits one owner and rejected the second acquisition even when the first owner was healthy. Its Legacy error became `INTERNAL_ERROR`, `retryable:false`, before `Operation.accept` or target input materialization. The exclusive registry was introduced by `e0ad6d4870be2ccd409e45462c713f03ef5feb4e`; `2263513f1841a9bf7d79530d977fbd55e7fda20c` connected product managers to it.

The fix shares the command's existing document manager, rather than introducing a general presence/token leasing system. Discovery/MCP helpers and `commands/session.ts` now use the same `command-runtime.ts` entry. A daemon-provided Session command environment continues borrowing its existing manager.

```text
Concurrent commands → one document manager → existing presence / transport / tokens
One callback ends   → surviving callbacks keep using the manager
Last callback ends  → await the manager's existing cleanup
```

## Lifecycle contract

- Trigger and owner: `workspace-command-manager.ts` holds one pending/ready manager per workspace during overlapping cloud command callbacks. Same user, exact token, machine and configured authentication endpoints are required; differing scopes fail without exposing credentials. Scope metadata is copied and removed after successful cleanup.
- Cancellation: callbacks retain their borrow until their actual Promise settles. Ending one command cannot dispose a manager used by another; callbacks must not call manager cleanup themselves.
- Handoff: commands arriving during last cleanup wait for its actual receipt. Another workspace can proceed independently. There is no idle cache, timer, new execution runtime or new transport/token owner.
- Failures: shared creation failures reach all waiters, then allow a new attempt. Last cleanup failures preserve the accepted result under the existing logging policy. Only unreleased presence retains the original manager and failed receipt and blocks replacement. Once presence is actually released, transport/session/repo errors are reported and the entry is removed; waiting and subsequent commands may create a fresh manager. `isPresenceReleased()` reads the native owner through the Legacy facade, rather than guessing from error types: a later destructor error can mask a presence-stop failure. Existing document/application cleanup retains its native resource owners; no live recovery API or blanket retryability change is added.

This coordination remains explicitly Legacy: document creation, command callbacks and document cleanup still own Promise workflows. Migrating those dependencies is outside this fix. Presence, token providers, platform ports and machine revocation are unchanged. Direct construction of two same-workspace document managers remains unsupported; cloud command composition now avoids it.

## Verification

Owning command tests cover concurrent pending creation, survivor writes, last release, cleanup handoff, independent workspaces, authorization isolation, creation/callback failures and failed cleanup fencing. A document-manager regression invokes the real command entry and native presence registry, with synthetic repo/transport ports, to prove overlapping commands enter and the survivor remains writable. Readiness and release use explicit Promise gates, without sleeps or external network.

Validation uses a standalone checkout with frozen dependencies and matching changed source bytes. The running packaged app, user Sessions and network configuration are untouched; source checks do not prove packaged-app or remote delivery acceptance.

The overlap regression fails on original `08a58d6f3bcd4d0dc7287d6462548b83113a0cf2` with `Workspace presence operation failed`, and passes with the shared command entry. The two owning suites and native presence suite pass all 76 cases. Restoring the original `d9f430518` pool, while retaining the read-only release observer, reproduces two post-cleanup failures: `removeTransport` and repo destruction errors block the next command despite confirmed presence release. The fixed pool permits both replacements and already-waiting callers, while unreleased presence still fences replacement. Full `pnpm check`, `pnpm format`, `pnpm format:check` and `pnpm run docs check` passed in the standalone checkout, using system Git to isolate the session wrapper. Live-agent E2E and opt-in macOS host-key tests were not enabled; packaged-app acceptance remains untested.
