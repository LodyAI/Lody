# Give failing sync confirmations at least 30 seconds

Status: implemented
Translation: current

[中文](2026-10-21-sync-confirmation-timeout-floor.zh.md)

## Abstract

Several CLI paths failed an operation when a Loro sync confirmation did not
finish within 1.5 to 20 seconds, and told the caller to retry. A slow but
healthy sync therefore failed every attempt the same way. Sync confirmations
whose timeout fails the operation now wait at least
`SYNC_CONFIRMATION_TIMEOUT_MS` (30 seconds); waits that continue on timeout
keep their short budgets, because they sit on turn finalization and other
latency-sensitive paths. The cost is a slower failure when sync is genuinely
unavailable, and MCP calls can now outlast a client tool timeout that is
shorter than their combined sync budget.

## Decision

The rule is set by its failure semantics, not by the helper it calls:

| Wait | Before | Now | Timeout result |
| --- | --- | --- | --- |
| `syncMetaOrThrow` (`LODY_LORO_SYNC_META_TIMEOUT_MS`) | 20s | 30s | error |
| `syncDocOrThrow` / `syncRemoteDocOrThrow` (`LODY_LORO_SYNC_DOC_TIMEOUT_MS`) | 8s | 30s | error |
| Machine Flock sync and its coordinator (`LODY_LORO_SYNC_MACHINE_FLOCK_TIMEOUT_MS`) | 8s | 30s | retryable `SYNC_UNAVAILABLE` / backoff retry |
| `ensureWorkspaceMetaSynced`, owner history write meta wait | 4s | 30s | "retry the command" |
| Agent Role and Schedule proposal confirmation | 4s | 30s | "retry with requestId" |
| Replaced external history confirmation | 4s | 30s | error |
| Local project root path resolution (3 syncs between 4 reads) | ~5.7s | ~31s | Session init fails |
| Fallback-restore replayable history | 15s | 30s | turn fails `session_restore_failed` |

Unchanged on purpose:

- Best-effort waits that continue on timeout: the default 4s
  `waitUntilSynced` / `waitUntilMetaSynced` used in turn finalization, the
  dispatch confirmation after create, the 8s initial session-doc sync, the 5s
  MCP catalog refresh at session start, and the 1.5s local project lookup
  before registration. Raising them only delays idle status or session start.
  `confirmDispatchSyncedBestEffort` now calls the best-effort meta wait
  directly, so the create path does not inherit the 30s budget.
- The meta recovery wait after reconnect and the one-shot attach wait keep
  20s: one only logs while holding the serialized recovery queue, the other
  continues in degraded mode.
- Serialized background loops pass explicit 8s budgets: Coordinator target
  catch-up before replay and Schedule definition reads. Each loop walks its
  items one by one, so a stalled room would otherwise delay every unrelated
  Operation or Schedule by up to 30s per pass. Their timeouts are uncertainty
  with an owned retry, and the abandoned `repo.sync` keeps running.
- Nested budgets: the 10s Session history metadata wait runs inside a 30s
  client RPC, and Machine RPC defaults (2 to 15s) are request deadlines over
  Streams. Raising either alone only moves the failure to the outer deadline.
- `LODY_LORO_RECONNECT_TIMEOUT_MS` (10s) bounds one serialized reconnect
  fiber and each room rejoin; the 30s watchdog retries it.
- Presence, teardown, process exit and renderer timeouts are not sync
  confirmations.

## Limits

Before acceptance, the single MCP create waits up to about 30s each for its
workspace meta and Machine Flock syncs (about 28s in total before), which
reaches a 60s client tool timeout when sync is degraded. The daemon continues after the client gives up;
[fresh-id retry adoption](2026-10-21-mcp-create-fresh-id-retry.md) prevents an
identical retry from duplicating the Session, but the caller still sees a
false failure until the client timeout for the Lody MCP server is raised
above the server budget.

## Verification

- `local-project-meta.test.ts` uses fake timers to show that a stuck sync is
  not declared missing before 30s.
- No test drives the two serialized loops with a stalled real room; their
  explicit budgets are checked only by type checking and review.
- Assertions in `command-runtime.test.ts` and `lody-mcp-server.test.ts` cover
  the 30s budget passed to failing meta confirmations.
