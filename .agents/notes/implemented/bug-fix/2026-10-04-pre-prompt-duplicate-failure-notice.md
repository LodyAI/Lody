# One failure notice per failed pre-prompt turn

Status: implemented
Translation: current

[中文](2026-10-04-pre-prompt-duplicate-failure-notice.zh.md)

## Abstract

A turn that failed before its prompt was dispatched produced two visible
`chat_failed` history entries: `recordPrePromptFailure` wrote a generic
pre-prompt notice, then `handleTurnError` wrote a second, correctly classified
one. A JSON-RPC `-32603` showed `turn_pre_prompt_failed` plus
`acp_internal_error`, an auth-required error showed `acp_auth_required` twice,
and a disconnect showed `turn_pre_prompt_failed` plus `agent_disconnected`.
`recordPrePromptFailure` now skips any error the turn-error classifier owns
(`parseACPError` result or agent-disconnect text), leaving `handleTurnError` as
the single writer for those failures while keeping its generic notice for
non-ACP faults. Classification, error detail, termination, and finalization are
unchanged.

## Evidence

`handleVisibleTurnUnhandledError` in
`apps/cli/src/session/session-execution-service.ts` ran three steps in order:
`recordPrePromptFailure` (appends `chat_failed` for anything not cancelled or
already started), `markTurnFailed`, then `handleTurnError`, which parses the
same error through `parseACPError`/`isAgentDisconnectedError` and appends a
second `chat_failed` with the classified reason. Reproduced in
`tests/session-execution-service.test.ts` by driving `session/create` failures
through a history-backed fixture: each ACP-shaped or disconnect rejection
yielded two `chat_failed` items in the session's visible history.

## Decision

Ownership is split by error kind, not by ordering. `handleTurnError` is the
single writer for every error its classifier recognizes, because that notice
carries the right reason (`acp_internal_error`, `acp_auth_required`,
`agent_disconnected`) and the provider's own detail text. `recordPrePromptFailure`
keeps only what the classifier ignores: ordinary non-ACP faults, which still
record `turn_pre_prompt_failed`, and the Git-executable failure, which keeps its
`git_executable_not_found` code. The now-unreachable
`instanceof AcpAuthenticationRequiredError` branch was removed; that error
always carries numeric `code = -32000`, so the guard above routes it to the
classifier, which still produces `acp_auth_required` through the name/code
match. A rejected alternative was first-recorder-wins deduplication: it would
have kept the weaker `turn_pre_prompt_failed` classification for ACP errors and
added cross-method coupling through the `prePromptFailureRecorded` latch. A
history-level dedupe was also rejected: it would hide any future double-write
instead of fixing ownership.

## Validation

`tests/session-execution-service.test.ts` gained regression cases that read the
visible history a user would see, not mock call counts: `session/create`
failures for `-32603`, auth-required, disconnect, ordinary, and Git-executable
errors each yield exactly one `chat_failed` item with the expected reason,
message, and code, plus the preserved termination (`force` for `-32603` and
disconnect, graceful for auth) and `setSessionError('execution_error')`. ACP
errors after `promptStarted` still record exactly one classified notice, and a
cancel-during-create turn records none. The suite is green at 154 tests.

Not validated: the fix assumes `handleVisibleTurnUnhandledError` always calls
`handleTurnError` next, which the code guarantees today; a future path that
records pre-prompt notices without that follow-up would need its own review.
