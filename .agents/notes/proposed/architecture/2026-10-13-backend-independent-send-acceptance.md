# Backend-independent local send acceptance

Status: proposed
Type: architecture
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1546

[中文](2026-10-13-backend-independent-send-acceptance.zh.md)

## Abstract

Roost ready messages previously waited for owner history IPC/RPC before the
renderer published its write notification, exposing network and storage delay
in the send interaction. The implemented proposal accepts one frozen input into
a local projection, saves it independently, and reconciles it with an atomic
immutable owner receipt. Normal messages use the existing user-content renderer
without another status badge; owner confirmation remains the execution barrier.
First paint does not imply local persistence, owner acceptance or execution.

## Decision and alternatives

Loro's live history document already owns local admission and asynchronous Repo
persistence/sync. The renderer's Roost adapter has no equivalent writable replica:
its owner still signs and stores history. The source therefore retains ready
input, not a second history document or signing writer. The
[session files draft](../../../../specs/session-files.md#7-submission-identity-and-local-writes)
defines the separation of local admission, synchronization and execution.

An ephemeral bubble alone would lose saved-input recovery. A complete writable
Roost replica would change signing, ownership and synchronization; it is outside
this change. The old [send journal removal](../../implemented/simplification/2026-09-29-remove-session-send-journal.md)
remains historical guidance: unprepared Blobs are still memory-only, and an
uncertain guide is never replayed. The new retained record is limited to immutable
ready Roost input and final attachment references.

## Responsibilities and lifecycle

1. Admission freezes account/workspace, source user, target, session/turn identity,
   content, input configuration and delivery intent. New routing metadata commits
   locally before the conversation can acquire its first history store. The row
   appears before owner work completes; local storage finishes in the background.
   Routing preparation does not acquire a history store. Background delivery
   commits the trusted `humanInputReceipts` control record before owner acceptance,
   as ordinary Loro writes and control queues do before activation. Receipt lookup
   remains read-only; slow store acquisition does not hold up local admission.
2. Account/workspace-scoped IndexedDB retains ready input in admission order.
   Saving new input applies `parseHistoryWrite` to its entry before storage
   validation, so generated file/image data with `text: undefined` behaves like
   ordinary history writes. Persisted records still decode strictly, and same-ID
   content conflicts still fail.
   Failed saves retain the only in-memory copy through projection refresh, block
   later sends in that session and keep leave protection. Ordinary cache recovery
   preserves this user database; explicit full reset may delete it.
3. The workspace's native send-resource scope owns raw storage, session Web Locks,
   store borrows and owner/control I/O. Its Promise coordinator does not claim a
   complete native migration of the document/RPC lifecycle. Cross-window workers
   reread stored input under the shared lease. Control queues retain their Loro
   writer but wait behind prior accepted input under the same lease; later inputs
   do not become predecessors. The merged projection preserves source order and
   persisted peer order, including the latest pending run configuration.
   After attachment preparation hands input to the durable owner, retry targets
   that owner even while the held queue awaits it. Preparation-only failures
   continue through the held queue's retry path.
4. `sessionInputAcceptance` version 1 gates `accept_input` and the read-only
   `inputAcceptance` query. Older or changed targets fail visibly without backend
   fallback. The acquired renderer port must match the frozen target, independently
   of mutable metadata. Existing identity/access checks and RPC refusal receipts
   remain in force.
5. The SDK binds operation identity and immutable content fingerprint in the same
   transaction as the history mutation. A missing query is unknown evidence;
   retrying the exact immutable acceptance operation safely converges with a late
   original. Current and retained generation receipts take precedence over branch
   placement. Changed input conflicts; removed input is never recreated. Unreadable
   history is a failure to observe, not evidence of removal.
6. The atomic owner history/receipt commit is the execution boundary, not the
   source observing its reply. A daemon may start committed pending history while
   that reply is lost, matching the existing Loro/history contract. The source
   activates or offers a guide only after it observes acceptance; its local
   projection alone cannot execute. A guide offer is fenced
   before handoff and never replayed after interruption. History acceptance is not
   proof of Agent execution. The local row remains until the authoritative view
   contains that same ID; the UI never renders both copies.
7. Cancel/archive/delete discover durable rows independently of the window's
   snapshot, persist cancellation, and join local raw work plus matching session
   leases. A peer checks that stored fence before dispatch. Cancellation does not
   undo a remote history write. Closing joins started I/O and leaves saved unknown
   input for recovery by the same identity.

## Transport and compatibility

Each history operation resolves the fixed owner's current transport through the
workspace router. A store must not cache the local-machine probe's initial route
or change the recipient when that route becomes unavailable. Both Node IPC guard
implementations must accept the declared history request/receipt contract.

Immutable acceptance uses `@loro-dev/roost@0.1.3`; the native
`@loro-dev/roost-node@0.1.2` graph is unchanged.

## Verification and limits

Deterministic sender tests exercise IndexedDB transactions, native send resources,
real Loro documents and the workspace writer. Coverage includes immediate display,
immutable retries, recovery and ordering, account isolation, cancellation across
windows, attachment handoff, guide replay prevention and human-input provenance
before owner acceptance. Receiver tests use the pinned native SQLite package to
cover receipt conflicts, delayed originals, reopen, retained generations and
unreadable history. Bridge and IPC tests cover route changes, all declared history
operations and malformed replies.

Packaged macOS Cloud tests cover local and remote sends with paused owners,
same-ID recovery after restart and visible refusal by unsupported targets. The
final attachment changes and operation-inbox integration passed deterministic
tests and `pnpm check`; packaged tests were not rerun for those changes. These
checks establish the covered behavior, not the original production incident's
cause, a latency guarantee or release/signing validation.
