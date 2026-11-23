# Cold starts continue the boot shell instead of "Switching workspace"

Status: implemented
Translation: current

[中文](2026-10-16-cold-start-workspace-wait.zh.md)

## Abstract

iOS users reported that the app often said "Switching workspace", went blank,
and reloaded, losing the text they were typing and the page they were reading.
Nothing switched: the web code never reloads on its own, so the blank page is
the WebView being reloaded, and every reload is a cold start whose workspace data
scope is not ready yet. That wait always mounted the workspace layout around a
pane titled "Switching workspace". A cold start now continues the boot shell
until the scope is ready; only a page that already had a different workspace
open says it is switching. This removes the misleading screen, not the reload or
the lost input: why the iOS WebView reloads is not established here.

## Problem

`routes/$workspaceName/_auth.tsx` renders one placeholder whenever
`useResolvedWorkspaceScope()` has no workspace id on the optimistic (cached-token)
path. The scope stays unready until the runtime exists for the route's slug and
its first doc-metadata scan resolves (`lib/workspace-data-scope.ts`), which is
true of every launch. So every launch with a cached token passed through
"Switching workspace / Finalizing workspace access and permissions" inside the
mounted layout, even though nothing had been open before.

Evidence for the reload itself: the only automatic `location.reload()` in the
renderer is the user-confirmed cache clear (`lib/clear-local-cache.ts`), and
error boundaries never reset themselves. A blank screen followed by a fresh page
therefore comes from the host, most plausibly the iOS WebContent process being
terminated and the native shell reloading it. The native shell is outside this
repository, and this was not confirmed on a device.

Checked and excluded: `docMetaSubscriptionAtom` calls `get` from asynchronous
watch callbacks (`hasCachedDocMeta`). With jotai-effect 2.2.3 that does not
re-run the effect when the metadata caches change, so ordinary metadata traffic
does not reset the scope.

## Decision

`components/workspace-data-wait.tsx` remembers which workspace last had a ready
data scope under the mounted authed layout, and for which account. It forgets
that workspace when the layout unmounts, for example on sign-out: there is then
no layout to keep. The `_auth` wait uses it:

| Situation                                                                          | Wait                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Nothing ready yet under this layout and account (launch, host reload, new sign-in) | boot shell with "Loading workspace"; the layout chunk preloads meanwhile    |
| The same workspace became unready again                                            | pane placeholder "Loading workspace" inside the mounted layout              |
| A different workspace was ready before                                             | pane placeholder "Switching workspace" inside the mounted layout, as before |

Real switches keep `MainLayout` mounted, so the sidebar and workspace identity
stay stable. A cold start has no layout to keep, and the boot shell already
reserves the sidebar column, so continuing it is visually continuous with the
first frame. Every variant is still a `BlockingWaitPlaceholder` with gate
`workspace_data`, so the 30-second recovery page and the stuck report are unchanged.

## Alternatives

- **Change the copy only.** Calling the cold wait "Loading workspace" inside the
  layout still shows a second loading screen after the splash.
- **Render workspace content before the scope is ready.** Workspace-scoped
  consumers fail closed and return empty projections until the scope is ready,
  so the content would render a blank or "not found" state instead of a wait.

## Trade-offs and limits

- On a desktop cold launch, the real sidebar now appears when data is ready
  rather than with the pane placeholder. Before that, its scoped rows were empty
  anyway.
- The wait itself is unchanged: it still lasts until the runtime opens and the
  first metadata scan finishes.
- Unsent composer text is still lost when the host reloads the WebView. Saving
  it, and finding why the iOS WebView reloads, are separate work.

## Verification

`tests/blocking-wait-placeholder.test.tsx` covers six cases:

- a cold start renders the boot shell without "Switching workspace";
- a switch after another workspace was ready says "Switching workspace" in the pane;
- a same-workspace wait stays in the pane without claiming a switch;
- a workspace that another account had open counts as a cold start;
- a wait after the authed layout unmounted (sign-out) counts as a cold start;
- a cold start that never becomes ready still reaches the recovery page. None of this was run on an iOS device.
