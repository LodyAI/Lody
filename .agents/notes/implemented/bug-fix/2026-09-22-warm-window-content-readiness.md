# Warm-window adoption and content readiness

Status: implemented
Translation: current
PR: [#885](https://github.com/LodyAI/Lody/pull/885)

[中文](2026-09-22-warm-window-content-readiness.zh.md)

## Abstract

Claimed warm windows could expose Loading or transient Session Not Found, remain
classified as disposable spares, and recover to the neutral warm route after a
crash. Adoption now clears the spare identity and persists the real reload target
before navigation. Reveal requires the matching target surface, and absence waits
only for that Session's metadata projection. The five-second recovery fallback
remains. Local-only windows now bootstrap from peer metadata and already loaded
Session snapshots, and readable history no longer waits for authoritative sync.

## Decision and evidence

This corrects adoption and reveal following the
[window prewarming decision](../feature/2026-09-18-desktop-window-prewarming.md).
The [desktop window Spec](../../../../specs/desktop-windows.md) describes the result.
The renderer's former `innerText` check accepted Loading, sidebar text, and missing
Session messages. It now waits for two frames containing the matching Session or
workspace marker. A visible conversation emits its marker after its document is
ready with readable history, or synced when empty; confirmed absence is also a valid terminal surface. Workspace
landing emits its marker when mounted. Recovery still becomes accessible after
five seconds, including when navigation fails.

`window-target.ts` adopts a spare before sending its navigation event: it clears
main's warm marker and updates the recovery destination using the same path builder
as cold windows. `window-state.ts` owns registration and close cleanup, so an adopted
window can become the main fallback and survives closing the previous main window.
Only the current spare's close callback clears its readiness timer; a previously
claimed window cannot cancel its replacement's timeout.

`doc-meta.ts` keeps bootstrap readiness separate from per-Session projection
settlement. Queued events, the latest full metadata read, and unresolved/failed
reads block absence only for their own Session. Later events can retry reads;
deletion clears unresolved work and stops waiting for obsolete reads. Runtime
disposal clears pending markers and fences late completions. A workspace-global
settlement gate was rejected because an unrelated failed or empty metadata read
could leave a missing Session loading forever. Existing Sessions do not subscribe
to pending-state churn; workspace chrome still uses bootstrap readiness.

`local-window-bootstrap.ts` uses a workspace-scoped BroadcastChannel only in local
mode. Each runtime responds with CRDT metadata and documents it already owns;
requests never create stores, Mirrors, or extra daemon subscriptions. Metadata
responses merge asynchronously through the Repo's normal Flock projection. A
150 ms response window allows multiple peers to contribute metadata without
blocking runtime creation. Session acquisition races peer state against the
existing eager-sync disk cache; a miss cannot beat usable data. Snapshot payloads
are capped at 16 MiB. Documents merge into the receiver's existing replica, so
unsent edits survive; persistence and Streams cursors remain per renderer.
Runtime disposal closes the channel and resolves pending requests. Missing,
oversized, corrupt, or unavailable peer state falls back to normal synchronization.

The neutral shell still costs a renderer, and this is not a guarantee of instant
opening: it does not share React stores, preinitialize the target runtime, or
remove layout and history projection costs. Cloud and dual-mode runtimes do not
participate in peer sharing. Empty conversations still wait for sync before reveal.

## Verification and limits

Deterministic tests exercise closing the original/adopted windows, recovery targets,
replacement timeouts, queued/delayed metadata, target deletion during a read,
unrelated failed/missing metadata, runtime replacement, target-specific reveal,
consecutive frames, and the recovery deadline. Peer tests additionally verify metadata projection, history reuse, unsent-edit
merging, workspace isolation, close/miss fallback, and racing a slow disk cache.
All 37 tests in seven focused suites
passed, as did components and Electron main/renderer typechecks. Changed-source
lint has no errors (pre-existing warnings in the runtime and conversation component).
Real Electron visual acceptance remains unverified. E2E still disables the warm
pool. This worktree reuses locally available dependencies; `pnpm check` stops at
missing dependencies in `packages/ignore`. `docs check` reports 34 existing links
into absent ACP submodules, none in the changed documents.
