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
`LocalLoroDataPlaneServer` engines (`@lody/shared`, owned by `LoroDocumentManager`).
Every message carries `workspaceId` + `peerId` (a per-adapter uuid), and the server
keys sync state per PEER (`lastSentVV`, flock bundle hash), so multiple windows
multiplexed over the one relay socket sync independently and a sender's own ops are
never echoed back to it.

Doc rooms sync via version-vector deltas in both directions; flock rooms sync via full
bundles on change. Broadcast passes are coalesced by a queued-pass latch that bounds a
change burst to one running plus one queued full `exportJson` — never an unbounded
chain — while still giving a change that lands mid-broadcast its own follow-up pass.

All workspace engines share the process-level `local-loro-data-plane-scheduler`
created in `loro/doc.ts`. Presence and CRDT materialization run through `setImmediate`
with globally one task/frame quantum per turn, because running the bulk writer inline
from a CRDT callback, or per workspace, starves the socket.

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
(`specs/local-first-two-plane.md`). There is no polling and no request/response HTTP
path.

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
