# The local Loro data plane (Electron renderer ↔ CLI)

How durable Loro state reaches an Electron renderer without a cloud round trip.
[`apps/cli/src/lib/AGENTS.md`](../../apps/cli/src/lib/AGENTS.md) requires this page to
be read before `local-loro-data-plane-server.ts` is changed, because the rules below
bind that file.

## Rules

- Construct `LoroDocumentManager` with its named options object. Positional lifecycle
  dependencies let a newly added transport/runtime silently shift the data-plane
  binding.
- Never run the bulk writer inline from a CRDT callback, restore its unbounded loop, or
  create a scheduler per workspace; those variants starve the socket.
- An oversized DOC delta must chunk into `doc-update-chunk` frames rather than fail the
  room, `payload_too_large` stays terminal only for a single oversized flock entry, and
  a framing overflow must never destroy the socket.
- Feed `createJsonLineSplitter` the RAW socket chunk; corrupted U+FFFD path keys are
  never "restored".
- A renderer joining a Session Doc room must NOT call `getOrCreateSessionDoc` or retain
  a live cloud room.
- Never push the CLI's cloud room status to renderers as local room health, and never
  add polling or a request/response HTTP path.

## Shape

Protocol v7, push-only, peer-scoped. A dedicated `lody-loro-data-plane` socket in the
0700 run dir routes persistent connections to per-workspace
`LocalLoroDataPlaneServerLegacy` engines (`@lody/shared`, owned by `LoroDocumentManager`).
Before protocol messages, each socket exchanges an `authenticate` token frame and
an `authenticated` receipt. Electron reads the current address and token from the
private daemon run file on each dial and exposes connected status only after that
receipt. Windows uses a random per-process pipe suffix separate from the secret.
See the [security decision](../notes/implemented/bug-fix/2026-11-12-local-ipc-and-native-preview-security.md)
for compatibility and filesystem limits.

Workspace messages carry `workspaceId` + `peerId` (a per-adapter uuid), and the server
keys sync state per PEER (`lastSentVV`, flock bundle hash), so multiple windows
multiplexed over the one relay socket sync independently and a sender's own ops are
never echoed back to it.

Doc rooms sync by version-vector deltas; Flock rooms export independently importable
LWW entries from each peer's frontier. Frontiers and framing remain ordinary CRDT
computation. Outbound tasks materialize only when the physical connection is writable.

All workspace engines consume one process/application `LocalLoroWriterLive`. Its
native Effect FIFO pacer rotates workspace lanes after one task/frame, including
remaining catch-up chunks on the same socket. One physical connection owns one drain
subscription and one backpressure latch across every workspace: `write(false)` pauses
both export and send until drain. Parked lanes keep their order. The Node turn and
socket adapters live in `packages/shared/src/node/local-loro-writer.ts`.

A renderer installs its presence listener before opening the connection. A scoped
v7 `ping` carries both workspace and peer identifiers and registers presence after
workspace admission, without joining a Doc or Flock room. Bare watchdog pings keep
their connection-only behavior. The main relay records scoped peers for navigation
cleanup; detaching the last peer releases its presence receiver. Native domains
therefore do not depend on a legacy Meta join to learn the real machine status.

Presence uses the same writer and snapshots local-origin state at execution. Repeated
changes retain one running plus one queued task, so the final clear/delete still gets
a follow-up. Machine-monitor observer application and publication keep their existing
semantics on this same queue. There is no separate presence scheduler.

`LocalLoroDataPlaneServerLegacy` explicitly retains Promise room resolution,
join/leave/import and LoroRepo orchestration. Its native frame builders compose the
writer directly; only `exportLocalFlock` adapts genuine SDK I/O. The one deprecated
`local-loro-writer/legacy` facade executes for doc/socket owners. `disposeLegacy` and
`handleDisconnectLegacy` revoke queued work and await actual running export and drain
cleanup. A failed bounded release retains full Cause and recovery ownership; late
results cannot write or advance a disconnected/superseded frontier. Full room/app
lifecycle migration remains separate. Stable API and evidence:
[writer README](../../packages/shared/src/local-loro-writer/README.md).

## Framing discipline

`ping`/`pong` plus a 60s idle timeout are the watchdog. Framing is sender-enforced: an
oversized flock delta chunks entry-wise, and an oversized DOC delta chunks at the
transport layer as `doc-update-chunk` frames reassembled before a single import. A big
session document's first catch-up is a realistic oversize, so it cannot be a terminal
room error; `payload_too_large` stays terminal only for a single flock entry above the
budget. Receiver-side skip-until-newline is only a backup — a framing overflow must not
destroy the socket.

`createJsonLineSplitter` owns a stateful UTF-8 decode and must be fed the RAW socket
chunk. A per-chunk `toString('utf8')` mangles a multi-byte character split across a
chunk boundary into U+FFFD. A flock bundle carries file paths as literal UTF-8 JSON, so
that corruption becomes a permanent garbled LWW key in the receiver's replica;
`isCorruptedCodeCollabWorkspacePath` prunes the survivors.

## Room bridging and its cost

`LoroDocumentManager` bridges named Flock docs opened by a renderer into
`repo.joinFlockDocRoom()` and releases them on the last local peer leave. Code Collab
`fi`/`fis` and machine flock docs must not treat `syncOnce()` as a live cloud
subscription; those cloud hydrates are background data relays only.

A renderer-joined Session Doc is different: renderers may visit thousands of historical
sessions, and coupling a local join to a `SessionDocument` would retain every one of
them until GC. So it uses a bounded, one-shot raw `joinDocRoom` reconciliation that
never creates a `SessionDocument`, releases after the first remote sync or local leave,
and unloads the repo doc after the last local peer leaves unless dispatch has activated
the Session. That preserves CLI-authored offline backfill without retaining every
historical cloud room. Raw join/leave and `SessionDocument` activation are serialized
per doc id so an in-flight renderer-only release cannot evict a handle dispatch retains.

## Two planes, not one

For both room kinds the CLI's cloud room status is never pushed to renderers as local
room health: offline cloud failures must not poison the renderer's local reconnect loop
(the current `WorkspaceTargetRouter` and local/cloud readiness contracts). The historical
`specs/local-first-two-plane.md` is absent from this checkout; it is not current authority.
There is no polling and no request/response HTTP path.

## The two ends

- Electron main: `apps/electron/src/main/services/loro-data-plane-relay.ts` — a
  persistent socket with redial backoff and a ping watchdog, `webContents.send`
  broadcast fan-out plus a status channel, synthesizing peer `detach` for destroyed or
  navigated windows.
- Renderer adapter: `@lody/shared` `local-loro-transport.ts` — filters inbound frames
  by workspaceId + peerId and treats every (re)join as the reconciliation point,
  up-syncing its delta from the returned `serverVersion` regardless of the in-memory
  dirty flag, so offline writes survive app restarts and dropped frames. Regression
  suite: `packages/shared/tests/local-loro-transport-bug-repro.test.ts`.

## Optional native backend migration

Legacy domains still use separate renderer and CLI persisted replicas over the v7
plane. Selected local domains now use a shared Node owner and finite renderer IPC;
persistent ownership markers keep them on that path when selection flags are off.
The [Electron migration plan](electron-loro-repo-rs-migration.zh.md) records the fixed
SDK capabilities, local desktop acceptance and remaining ordinary Cloud and platform
checks. This does not replace the v7 compatibility path for unselected domains.
Domain ownership remains with the linked WorkspaceData proposal.


## Native local file-index observation

The opt-in FI/FIS pilot uses the same authenticated socket and bounded writer, with
read-only `file-index-observe/unobserve` requests and index/generation snapshots.
The v7 ping/pong capability `nativeFileIndexSnapshots` is explicit: an old pong
selects the original legacy Flock subscription; timeout does not infer a backend.
The daemon rejects legacy FI/FIS room admission after whole-pair native cutover.
Native windows keep JSON projections without acquiring those old Flock/IDB replicas.
Disconnect withdraws readiness and a new request generation replaces state on reset.

Observer release revokes callbacks and queued frames immediately. Waiting is bounded;
late SDK unsubscribe remains with the server owner. Closing the isolated native host
settles pending RPCs; failure of that observation cannot skip unrelated legacy cleanup.
The [migration plan](electron-loro-repo-rs-migration.zh.md#9-当前实施边界) owns pilot
selection, binary rollback and remaining SDK/platform acceptance limits.
