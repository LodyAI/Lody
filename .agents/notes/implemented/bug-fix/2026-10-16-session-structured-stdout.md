# Keep Session command diagnostics off structured stdout

Status: implemented
Translation: current

[中文](2026-10-16-session-structured-stdout.zh.md)

## Abstract

Session cancellation could succeed while its MCP caller reported a non-retryable
JSON parsing error: workspace cleanup logged after the JSON receipt on stdout.
The common Session command entry now routes diagnostics to stderr for JSON and
JSONL throughout setup, execution, cleanup and exit flushing. This extends the
existing observation mechanism without relaxing the MCP parser or changing
cancellation semantics. Isolated behavioral checks pass; the repository suites
remain unverified because this checkout lacks installed dependencies.

## Decision and evidence

[Issue #1604](https://github.com/LodyAI/Lody/issues/1604) identifies the trailing
transport-detach message. `withWorkspaceManager` awaits its callback before
cleanup, whereas the callback prints the receipt. `runLodyCliJson` waits for
process close and parses the last stdout line. Archive shares this failure;
Operation cancellation absorbs target-cancellation failures with `allSettled`,
so its successful response does not establish successful CLI parsing.

[runSessionCommand](../../../../apps/cli/src/commands/session.ts) owns the
structured logging scope and restores it in `finally`. Its scope includes error
receipts and exit flushing. Observe uses this shared boundary instead of its own
wrapper. Human output retains ordinary routing. The parser stays strict: scanning
for any valid JSON would hide stdout contamination and could select unrelated
JSON diagnostics. Lowering one message's severity would leave other logs and debug
mode exposed.

This extends the [observation decision](../feature/2026-10-08-cli-session-observe.md).
No native Effect migration is included: this fix changes synchronous log routing
around the existing Promise command owner; migrating workspace acquisition and
cleanup would involve unfinished dependencies unrelated to this output defect.

## Verification and limits

The existing Session suite now exercises real logger streams and workspace-manager
cleanup, structured success/error output, exit diagnostics, human output and
routing restoration. Its time-sync and telemetry boundaries are replaced to avoid
network and process side effects. Running that suite is blocked by missing Vitest;
`pnpm check` is blocked by missing TypeScript tooling.

An isolated harness evaluated the current command runner and console logger source
with locked-version Winston 3.19.0 and synthetic setup/exit boundaries: six cases
(JSON, JSONL and human, each succeeding/failing) passed. Removing the new routing
reproduced the parsing failure. This is not full module integration or an
authenticated CLI/MCP end-to-end test. Changed TypeScript files were formatted with
Oxfmt 0.65.0. Existing documentation checks have missing-submodule link failures.


## Ablation-backed simplification

The output tests share one five-case table for JSON/JSONL success and failure,
and human success. This removes 36 lines of duplicate capture, boundary replacement
and restoration code. Failure cases now also use the real workspace-manager cleanup.

An isolated Vitest 5.0.2 harness ran the exact before/after test blocks against
extracted current command/exit, logger and workspace-manager source with Winston
3.19.0. Only unrelated time-sync, telemetry and file-log dependencies were stubbed;
this does not load the full CLI module graph. Each revision passes all five baseline
cases and detects all six mutations below. Mutations existed only in temporary
copies; production protection remains intact.

| Mutation | Before | After |
| --- | --- | --- |
| Remove stderr routing | Detected | Detected |
| Remove routing restoration | Detected | Detected |
| Omit JSONL routing | Detected | Detected |
| Restore before the action and cleanup | Detected | Detected |
| Restore before successful exit flushing | Detected | Detected |
| Route human output diagnostics to stderr | Detected | Detected |

These results support consolidating the fixtures, not deleting behavioral cases
or the routing guard/finally. Full repository integration remains blocked by the
checkout's missing dependencies.

PR: [LodyAI/Lody #1610](https://github.com/LodyAI/Lody/pull/1610).
