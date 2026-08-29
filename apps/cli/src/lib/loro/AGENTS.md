# apps/cli/src/lib/loro — Loro repo/runtime layer

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Mirrors over synced docs tolerate unknown root keys

Every `new Mirror(...)` over a doc that syncs between clients must pass
`ignoreUnknownProperties: true`. Peers on a newer schema write root keys this
build does not declare; without the flag loro-mirror rejects the entire state
with `Unknown property: <key>`, so the older client can never write to that doc
again. Contract test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

## Opening a doc pulls its stream

`LoroDocumentManager.getOrCreateSessionDoc()` is not a cheap read.
`SessionDocument.init()` (`doc.ts`) calls `startDocRoomSync()` immediately: opening
a doc joins its room and starts pulling the stream, and the doc stays in the
manager's `sessions` cache with the room joined until `cleanSessionDoc` tears it
down. Cost per call = one Streams subscription plus the doc's full initial sync.

Rules:

- Renderer metadata reaches the CLI by direct import into the repo's internal
  meta Flock even when local mode has no registered transport. Keep the
  `loro-repo` metadata live monitor enabled from repo initialization; deferring
  it until transport join leaves `getDocMeta` stale and prevents the session
  dispatch watcher from seeing `latestUserMsgId`.
- Never open docs in a loop over `listAliveRoomIds` or any other workspace-wide
  enumeration. A long-lived workspace holds thousands of historical session
  rooms; opening them all stalls startup and floods the Streams backend.
- Bulk/startup/recovery scans must first filter to candidates through indexes
  that do not join rooms: `repo.getDocMeta(roomId)` meta records, the `e/`
  existence index (`lib/loro/repo-existence.ts`), or a purpose-built local index
  (example: `session/session-fork-operation-store.ts`). Open docs only for the
  filtered candidates, under a concurrency bound (`mapWithConcurrency`, 4).
- To drop a doc you opened for inspection, first prove no other holder adopted
  it: `LoroDocumentManager.sessions` is a shared cache with **no refcounting**,
  and `cleanSessionDoc`/`destroy` disposes the mirror out from under every other
  subscriber (the dispatch watcher, for one, unsubscribes before it cleans and
  its `watchedSessions` guard would block a re-subscribe — a destroyed shared
  instance silently kills doc-level signals for that session). When you cannot
  prove sole ownership, leave the doc cached. Never call
  `repo.unloadDoc`/`unloadDocRoom` on a live wrapper directly either (the room
  binding would leak; see `SessionDocument.destroy` in `doc.ts`), and never let
  teardown write status/meta for docs that must stay hidden (e.g. unfinished
  fork targets).

The dispatch watcher learned this the hard way — twice (reconnect-triggered
bootstrap scans fanning out over every owned room). Its current contract,
"session metadata is the activation index", is documented in
`../../session/AGENTS.md` and applies to any new module that enumerates rooms.
