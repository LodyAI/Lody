# Bound ACP terminal output drain after command exit

Status: proposed
Translation: current

[中文](2026-10-26-acp-terminal-exit-drain.zh.md)

## Abstract

ACP terminal waits used Node `close`, so background descendants inheriting stdout
or stderr could hold an agent turn open after its command exited. The fix records
the direct process status on `exit` and drains output until `close` or 100 ms,
then preserves the existing resource inspection before completing waiters.
Kill/release can recognize an exited command during drain and leave its background
descendants alone. The 100 ms budget retains ordinary trailing output without
promising every future byte from a long-running descendant; this proposal remains
subject to review and does not bound resource inspection itself.

## Boundary and decision

[Issue #1270](https://github.com/LodyAI/Lody/issues/1270) and its contributor's
[reference diff](https://github.com/Dante-dan/Lody/compare/86e0da5ee125d911d097210dda6ac4d382230c1a...cbea5f4adfc81798d21f6d1bf51ba693ba08face)
identify the same event mismatch. The current sandbox already buffers/replays
independent exit and close events; it needs no modification. This builds on the
[terminal spawn decision](../../implemented/bug-fix/2026-09-12-acp-terminal-unsplit-command-line.md).

The manager owns the output buffer, subscriptions, one drain timer and waiters.
Direct exit records an immutable status; drain completion is separate so a new
waiter cannot bypass trailing output. Close can finish early, or supply a fallback
status when no exit arrived. One reporting guard prevents duplicate inspection
and cancels the timer. Release clears subscriptions/timer, settles all waiters
with the recorded status (SIGTERM fallback for active commands), and removes the
terminal. Repeated disposal of an empty manager does nothing. A released id keeps
its existing not-found behavior.

Cancellation through kill/release still terminates an active command through the
sandbox. Once direct exit is observed, kill/release cannot kill its background
descendants, including during the drain window. The timeout completes a local wait;
it does not claim tree termination or create a successor process owner. The
session sandbox retains its existing process ownership and shutdown policy.
Inspection/callback errors are logged through the existing error hook without
replacing a known exit code/signal. No new failure fence, retry owner or retention
map is introduced; independent terminals keep independent timers and cleanup.

Native Effect migration was assessed in feature/fix mode against Effect 4.0.2.
The terminal manager still consumes the registered Promise sandbox facade and
Session's resource-limit callback. Migrating their ownership would extend the
unfinished Session orchestration chain. This fix stays inside that adapter;
no new Effect runtime/facade or migration-ledger claim is added.

## Verification and simplification

The owning terminal suite controls exit/close independently and advances fake
timers. It checks bounded return, both output tails, original status, a waiter
joining during drain, kill/release, spawn errors and failed inspection. A real
POSIX shell backgrounds a descendant blocked on a FIFO; the test observes actual
exit, advances only the drain timer and proves return before pipes close. Kill/release run before writing
the FIFO, then the descendant emits `background survived` and closes its pipes.
The FIFO control descriptor uses O_RDWR so cleanup cannot block opening a pipe
whose reader a regression killed. No real sleep or network is used.

Mock-call-only command-routing/termination tests were removed. Real command output,
argv and executable-path tests retain observable boundary coverage. Windows
execution and Linux cgroup behavior are not claimed by the macOS reproduction.
The PR carries red/green commands, screenshots, ablation comparisons and check
results; temporary ablations are excluded from the final tree.

The same 15-test suite was run against baseline `91fa467a` production source and
each temporary ablation, then against the reduced fix:

| Removed or simplified design | Result |
| --- | --- |
| Entire fix (baseline) | Exit 1; 6 failed, 9 passed, including the real FIFO regression. |
| Drain deadline / 100 ms window changed to zero | Exit 1; 3 / 2 failed respectively. |
| Early completion on close | Exit 1; 3 failed. |
| Separate waiter drain-completion state | Exit 1; waiter joining during drain completed prematurely. |
| Immutable first exit status | Exit 1; 3 failures for code/signal/error preservation. |
| Single report guard | Exit 1; late close delivered the resource-limit notification twice. |
| Release timer cancellation | Exit 1; timer remained after release. |
| Stored original status for inspection | Exit 1; close's signal lost the original resource-limit notification. |
| Dispose flag assignment / exit-entry guard | Both exit 0, 15 passed; both removed from the final fix. |
| Reduced fix | Exit 0; all 15 passed. |

These are per-terminal state and adapter callbacks, with no new exported
abstraction, service, facade, retry or fence. Existing sandbox event subscriptions
are the cleanup boundary; their unsubscribe functions are idempotent.

Validation uses an independent clone with the locked dependencies/submodules and
Node 26.12.1 (Node-API 10); the original nested checkout is not installed into.
The final full check reaches CLI tests: 4,657 pass, four skip, and one unrelated
relative-global Git identity test fails identically with baseline production
source (one failed/nine passed in its isolated suite on both sides). Formatting
passes. Docs check has the same two old bilingual subagent-note links to missing
Pi `src/subagents.ts` on baseline and fix; no protected topics are registered.
These limits are reported rather than repaired under this Issue.
