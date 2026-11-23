# Stop one context compaction from rendering as n stacked rows

Status: implemented
Translation: current

[中文](2026-09-20-stacked-context-compaction-rows.zh.md)

## Abstract

A single context compaction could show up in the conversation as up to six
consecutive "Compacting context" rows, all but the last spinning forever. The
cause is upstream of the host: a compaction marker is a synthetic ACP tool call,
history merges tool calls by `toolCallId`, and two adapters minted a fresh id
every time the runtime re-announced a compaction that was already in flight — so
only the last id was still correlated when the terminal update landed. The fix
runs at all three layers: the Kimi ACP server now ignores a re-announcement while
a compaction is active, the Claude extension settles an abandoned legacy tool
call as `failed` at the turn boundary instead of leaving it `in_progress`, and
assistant-turn finalization in the host settles or removes whatever markers a
finished turn still leaves open. The host layer is what reaches users first:
adapters ship as independently versioned managed runtimes, so an installed old
adapter keeps producing duplicate ids until it is rebuilt.

## Discovery

Decoding real session documents out of `~/.lody/loro-repo` separated two
populations. Turns that compact several times legitimately put hundreds of items
between their markers and every marker reaches a terminal status. The broken
shape is adjacent markers with nothing between them: `session-eec5b16a…` turn
`assistant:a5111fb7…` holds six at items 109–114, five `in_progress` and one
`completed`, each with its own `context-compaction:<uuid>` id.

The emitter in the build that produced them is the `status` handler in the
Claude extension, which minted `context-compaction:${randomUUID()}` on every
`status: "compacting"` frame with no "already compacting" guard. The shipped
`claude-acp.js` (built 2026-09-19) still contains that code; the guard reached
`main` only with the submodule bump on 2026-09-20.

Auditing the other adapters: `codex` keys markers on the Codex thread item id and
`dsh` on the runtime's own `compactionId`, so both are already idempotent; `pi`
reuses one keyed activity and sweeps every unsettled activity in a `finally`,
which is the reference behavior; `grok` emits no compaction markers at all. Only
`kimi` shared the defect, in `onCompactionStarted`.

## Decision

Three changes, because no single layer covers the problem.

`acp-extension-kimi` returns early from `onCompactionStarted` while
`activeCompaction` is set. This is the root-cause fix for that adapter and
mirrors the guard `ContextCompactionLifecycle.start` already has.

`acp-extension-claude` settles an open legacy tool call as `failed` in
`reset()`. The previous comment declined to do this because ACP `ToolCallStatus`
has no cancelled state, but the alternative is a row that spins forever, and the
host already treats an unresolved compaction as failed. The `compaction_update`
presentation keeps its `cancelled` terminal; Lody does not advertise
`clientCapabilities.session.compaction`, so it is the legacy presentation that
was actually reaching users.

The host settles markers in `markAssistantTurnFinished`, unconditionally. The
previous `settleContextCompactionAsFailed` option gated the sweep on the paths
that happened to know the provider had failed; a marker still open on a finished
turn is stale regardless of why, so the option is gone and its wiring with it.
Markers that a later compaction marker supersedes are removed rather than marked
failed: they are duplicate identities for one episode, they never reported an
outcome of their own, and marking them failed would replace n spinners with n
false failures. A provider update that later arrives for the same `toolCallId`
still wins, because history merges by id.

The alternative of normalizing the run in the renderer was rejected: it treats
the symptom in the one place that cannot also fix the durable record, and the
stale markers would survive in exported and shared history.

## Verification

`acp-extension-claude`: 1369 tests pass. One existing expectation changed — a
compaction opened from a stream heartbeat now receives a terminal `failed` at the
turn boundary, which is the behavior under change.

`acp-extension-kimi`: `lody-session-updates.test.ts` passes (10 tests). Ablating
the guard fails the new re-announcement test, confirming it detects the
regression.

Host: `assistant-turn-finalize`, `message-handler-acp-batching`,
`session-execution-service`, and `local-project-history-sync-service` pass.
Ablating the finalize sweep fails three of the new tests. The
`message-handler-acp-batching` case crosses the real `SessionDocument` boundary
and covers reload plus a late provider update overriding the settled status.

Not verified: no end-to-end run against a rebuilt managed runtime. Until the
adapters are rebuilt and shipped, the host sweep is what users see.

## Follow-up

`codex` and `dsh` can still strand a single marker when a compaction is
interrupted, since neither sweeps at a turn boundary. The host sweep covers that
case, so no adapter change was made for them.
