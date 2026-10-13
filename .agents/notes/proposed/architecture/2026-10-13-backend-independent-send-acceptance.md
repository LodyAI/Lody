# Backend-independent local send acceptance

Status: proposed
Type: architecture
Translation: current

[中文](2026-10-13-backend-independent-send-acceptance.zh.md)

## Abstract

Roost ready messages previously waited for owner history IPC/RPC before the
renderer published its write notification, exposing network and storage delay
in the send interaction. The implemented proposal accepts one frozen input into
a local projection, saves it independently, and reconciles it with an atomic
immutable owner receipt. Normal messages use the existing user-content renderer
without another status badge; owner confirmation remains the execution barrier.
Behavioral verification covers interrupted requests, retained generations,
cancellation and mixed input/queue ordering. A packaged Cloud app also verified
local recovery and remote retry with the published SDK: messages appeared while
their owner was paused and converged to one owner record after it resumed. These
device samples establish ordering, not a latency guarantee or persistence at
first paint.

## Decision and alternatives

Loro's live history document already owns local admission and asynchronous Repo
persistence/sync. The renderer's Roost adapter has no equivalent writable replica:
its owner still signs and stores history. The source therefore retains ready
input, not a second history document or signing writer. The maintainer requested
this local admission direction and the existing presentation.

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

## Verification and remaining acceptance

The owning sender suite uses real IndexedDB transaction behavior through
fake-indexeddb, the actual native send resources, real Loro control/owner documents
and the actual direct workspace writer. Explicit gates cover immediate display,
immutable payloads, lost/absent receipts, storage recovery/FIFO, restore/account
isolation, removed-history handling, abort-ignoring I/O, stale-window cancellation,
non-replayed guides and control queues in one or two windows. UI coverage checks
ordinary presentation and ready image/file content without attachment drafts.

The production receiver suite uses the pinned native SQLite package. It covers
receipt/content conflicts, later history changes, reopen, removed generations,
unreadable projections and delayed-original races where either request wins or
generation replacement intervenes. Browser and Node SDK branch fixtures cover the
same atomic receipt boundary. These synthetic tests establish those boundaries,
not the original production incident's cause or real-device latency.

Packaged Cloud testing exposed a local transport omission: `accept_input` was in
the Zod protocol but absent from the lightweight Node request/receipt guards.
The desktop rejected it before owner execution. The TS guards now admit it and
the CJS mirror carries the history contract; the owning declared-operation suite
also exercises every schema operation so a future addition cannot silently miss
either direction. Immutable receipt lookup and malformed replies are covered.

The same packaged restoration round exposed a cached transport chosen while the
desktop's local-machine probe had not yet resolved its owner. History bridges now
resolve that fixed owner's current plane for every operation, so the existing
store can follow local identity changes without changing backend or recipient.
The owning bridge suite exercises lookup, acceptance, history reads and retained
receipts across those transitions.

Lody pins the published TypeScript SDK `@loro-dev/roost@0.1.3`; the native
`@loro-dev/roost-node@0.1.2` graph is unchanged. A fresh-cache registry download
matches the tested tarball and dependency-lock integrity, and all 57 installed
package files match that download. The
[session files draft](../../../../specs/session-files.md#7-submission-identity-and-local-writes)
retains the separation of local admission, synchronization and execution; it has
no new approval claim.

Final validation passed `pnpm check`: 11,724 Vitest package cases plus scripts and
Electron tests, types, lint, i18n, and public/local/Effect boundary checks. A
31-case focused run covers the final attachment fixes, including preparation
failure, retry, owner refusal and same-ID retry. It asserts exactly one owner
entry, no duplicate upload and cleared IndexedDB, and covers direct-ready image
and file input. Each regression fails when its corresponding fix is withdrawn.
CLI published-bundle and Storybook builds, and the seven-case immutable receipt
suite with pinned SQLite, passed before the final attachment changes.

Before those final attachment changes, the macOS arm64 packaged Cloud app passed
its embedded CLI/native smoke check. Device tests used the existing authenticated
Nightly profile and covered:

- A saved local input recovered with its original ID after the transport fixes;
  the owner contained one user entry and one assistant reply. A following input
  displayed while the embedded owner worker was paused, then received its reply
  after resumption; the owner contained four entries and pending input was cleared.
- An older remote CLI rejected input visibly without changing the Roost backend.
  After updating that same Docker machine to the built CLI, retry retained the
  original input ID, produced one user entry and one assistant reply, and cleared
  the local pending record.
- A following remote input displayed while the Docker daemon was paused, then
  received its reply after resumption. The remote owner's actual transcript
  contained exactly the two user entries and their two assistant replies.
- Relaunching the app retained local and remote entries and replies without
  duplication. A fresh local conversation then accepted its first input and
  returned one assistant reply; its owner contained exactly those two entries.

The paused-worker DOM samples were about 20 ms locally and 16 ms remotely; neither
worker could acknowledge the input during the observation. These are single-run
ordering checks, not a performance benchmark. These checks exercised an ad-hoc
signed local artifact with updates disabled; notarization, publication and the
update flow were not tested.
The final attachment paths were verified by the deterministic integration cases
above; the packaged device tests were not rerun for them.
