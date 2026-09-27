# Reporting workspaces stuck before their data is ready

Status: implemented
Translation: current

[中文](2026-09-26-workspace-sync-stuck-telemetry.zh.md)

## Abstract

Users sometimes sit on "Syncing workspace…" indefinitely, and nothing told us: the
state is a derived readiness gate, not a failure, and its most likely cause, a
rejected first doc-metadata scan, was swallowed without a trace. The workspace
readiness check now names the condition holding it back, the scan failure is kept
on the scope, and an always-mounted reporter sends one `workspace/sync_stuck` event
after 30 seconds, a `WorkspaceSyncStuckError` to error tracking when the connection
itself is online, and a `workspace/sync_stuck_resolved` event with the total wait.
This is observation only: nothing retries the failed scan yet, so a failed workspace
stays stuck until its runtime is replaced, but it is now counted and explained.

## Problem

The sidebar's "Syncing workspace…" pill and the content pane's "Switching
workspace" placeholder both mean `resolveWorkspaceDataScope` returned `switching`.
That happens while the connection is online, so the existing stuck-connection hint
(`use-stuck-connection.ts`, `loading` only) never covered it, and no telemetry did
either. `resolveWorkspaceDataScope` returned the same value for five different
causes, so even a log could not say which one held.

The first doc-metadata scan was started as `void buildDocMetaCache(...).then(...)`
with no rejection handler. A rejected scan left `docMetaCacheScopeAtom.ready` false
forever and reported nothing, which is exactly an endless "Syncing workspace…".

## Decisions

- **Name the blocker.** `WorkspaceDataScopeState` in the `switching` state carries
  `blocker`: `runtime_missing`, `runtime_other_workspace`, `doc_meta_scan_pending`,
  `doc_meta_scan_failed`, `workspace_not_in_organizations`, or
  `workspace_id_mismatch`, in check order. Product code still reads only `status`.
- **Keep the scan failure.** A rejected first scan sets
  `scanFailure: { errorType }` on the scope and logs a warning. The error message is
  not stored: it can carry stream URLs.
- **Report from a leaf, not the sidebar.** `WorkspaceSyncStuckReporter` renders
  nothing and is mounted beside `LodyLiveActivityHost` in both workspace layouts.
  The sidebar is not always mounted (compact and mobile layouts drop it while
  closed), while the user is stuck behind the content placeholder either way. The
  leaf uses the route's readiness inputs (`currentWorkspaceIdAtom` as the
  organization signal, as `useResolvedWorkspaceScope` does) so it never starts a
  second organization query with its own retry timers.
- **One report per wait.** After 30 seconds not ready, the hook sends
  `workspace/sync_stuck` once, with the blocker at report time, the wait so far, the
  control-connection and UI connection states, browser online, organization
  readiness, the scan error type, and the page visibility. When the wait ends it
  sends `workspace/sync_stuck_resolved` with `resolution`: `ready`,
  `target_changed`, or `unmounted`.
- **Error tracking only when online.** `WorkspaceSyncStuckError` is captured only
  when the connection UI state is `online`. Offline and reconnecting already explain
  a wait to the user and are not bugs; they still produce the analytics event, so
  dashboards can split on `connection_ui_state`. The error message embeds the
  blocker, so error tracking groups one issue per blocker.
- **Local traces too.** Each report and resolution also writes a console line and a
  line in the session render trace, so a crash report copied during or after a stuck
  wait shows it. This is the only signal local open-source builds get: they create
  no PostHog client, and the calls go into the deferred client that never
  initializes there.

## Alternatives not taken

- **Hosting the hook in `LoroAppSidebar`.** It owns the pill, but misses every
  stuck wait while the sidebar is unmounted.
- **Calling `useOrganization` in the leaf.** It would match the pill's organization
  signal exactly, but every instance runs its own retry timers and workspace-context
  writes. The two signals agree for the scan and runtime blockers, which are the
  likely ones.
- **Retrying the failed scan.** That is a recovery change with its own risks, such
  as retry storms against a failing repository. It stays a follow-up; the new
  `doc_meta_scan_failed` count says whether it is needed.

## Analysis

Events are `workspace/sync_stuck` (tier A, never sampled) and
`workspace/sync_stuck_resolved`. Useful cuts: count of stuck events by `blocker` and
`connection_ui_state`; the `stuck_ms` distribution of resolved events by
`resolution`; the share of stuck waits never resolved (a stuck event with no
resolved event in the same session usually means the user quit or reloaded).
Error tracking lists `WorkspaceSyncStuckError` by blocker.

## Verification

- `tests/use-workspace-sync-stuck-report.test.tsx` uses fake timers and a captured
  PostHog client: no report before the threshold, one report per wait, the blocker
  and connection at report time, no exception while offline, and each resolution.
- `tests/workspace-data-scope.test.ts` asserts every blocker.
- `tests/doc-meta-subscription.test.ts` asserts that a rejected scan is recorded on
  the scope.
- Not verified against a real stuck user: the threshold of 30 seconds is a
  judgement, and the first production data should confirm or move it.
