# Bound the landing MCP confirmation wait

Status: implemented
Translation: current

[中文](2026-10-26-mcp-send-wait.zh.md)

PR: [#1922](https://github.com/LodyAI/Lody/pull/1922)

## Abstract

New-chat Send was disabled until project MCP defaults became ready, and a direct
submit displayed a loading message. A stalled catalog could block it indefinitely.
Landing now uses the loaded local snapshot, with remote updates applied in the
background. Only an unfinished local read gets a two-second send deadline, without
MCP-specific loading copy. Failure preserves the draft and uses the ordinary
send error; no unconfirmed empty selection is accepted.

## Decision and ownership

This extends the [local-snapshot policy](2026-10-26-mcp-defaults-send-gate.md)
already merged in #1920 with a bounded local-read waiter and quieter landing UI.
It preserves that policy's independent cold-start coverage for plaintext and E2EE;
the two-second deadline never waits for remote catch-up.
The requested policy is optimistic local selection, not a remote freshness barrier. The mounted catalog hook already
starts loading while the user composes. Ready or explicit ids are captured immediately;
a pending send borrows the existing shared catalog room and captures defaults from its
loaded snapshot before authoring the first turn, in every sync mode. Flock subscription
updates refresh later draft selections without changing ids already captured for a send.
A new replica may have an empty or stale snapshot before remote updates arrive; that
is an accepted availability trade-off, not a read failure. CLI/Operation authoring is
outside this composer change.

The hook owns only the bounded waiter. Timeout, project/workspace change and unmount
release its lease and timer; they do not cancel another consumer's synchronization.
Late catalog readiness cannot submit a timed-out turn. A later click can use the
completed snapshot. A catalog that remains unavailable still fails sends quickly;
this does not repair transport recovery or invent a second sync owner.

Removing the guard entirely would silently persist an incorrect empty selection.
Keeping a permanently disabled button would hide an unbounded wait. The bounded
submit path retains confirmation while restoring control promptly. This is a small
React catalog consumer change; it does not migrate the existing shared room to Effect.

## Verification

The owning project-default suite exercises delayed local reads, cached defaults and background updates, deadline/retry,
project-change cancellation and explicit empty selection through the real shared room.
The merged selection, catalog-room and landing-derived suites passed 107 tests; component
type-checking and scoped lint passed; `pnpm format` passed. Full `pnpm check`
stops at CLI type-checking because this checkout lacks the Claude/Codex/Grok/Devin
ACP submodules and Claude SDK manifests. Documentation checking retains 31
pre-existing missing-submodule link errors, with no new errors. Packaged desktop
interaction remains unverified.

## Ablation evidence

Each variant was run against the same selection, catalog-room and landing-derived
suites. Accepted removals accumulate; destructive variants start from that cleaned
baseline and are restored independently.

| Variant                                                            | Result               | Decision                                 |
| ------------------------------------------------------------------ | -------------------- | ---------------------------------------- |
| Baseline with deterministic cancellation assertions                | 106 passed           | Baseline                                 |
| Remove unused `defaultsFailed` result                              | 106 passed           | Keep removal; callers use send rejection |
| Remove duplicate hook-level failed guard                           | 106 passed           | Keep removal; room snapshot owns failure |
| Replace optional mutable cleanup handles with concrete lease/timer | 106 passed           | Keep simplification                      |
| Remove scope/unmount cancellation                                  | 3 failed, 103 passed | Restore cancellation                     |
| Remove send deadline                                               | 1 failed, 105 passed | Restore deadline                         |

The earlier project-change test awaited any eventual rejection and could mistake
deadline expiry for cancellation. Tests now hold fake time still and assert immediate
cancellation for project changes, workspace changes and unmount; the deadline test
asserts settlement after an explicit clock advance. These tests check send outcomes,
not source shape or mock call counts. The shared room does not invoke a listener
synchronously during acquire, so cleanup has concrete handles before checking its
initial snapshot. No second failure flag or optional cleanup handle is needed.
