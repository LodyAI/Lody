# One read model for session pull requests

Status: implemented
Translation: current

[中文](2026-11-02-session-pr-read-model.zh.md)

## Abstract

In hosted sessions the Info Bar's PR status (open/closed/merged) and CI
summary lagged visibly behind the sidebar and could disagree with it. The
sidebar read session metadata, while the Info Bar overrode that metadata with
its own GitHub detail fetch, and that fetch could be answered from the browser
HTTP cache. The rule that picks the "current PR" also existed in four copies,
so in a multi-repository session two surfaces could show different PRs. Session
metadata is now the only source of PR summaries, read through one pure
`@lody/shared` function that returns views of every associated PR. Opening a
session gets faster through the machine reconciler's existing "viewed" high
lane. The same function is the single merge point for explicit PR
subscribe/unsubscribe later. Worst-case hosted CI latency moves from the
client's 15 s poll to the reconciler's 20 s high lane; this is not measured.

## Problem and evidence

- The Info Bar status came from `derivePrStatusFromDetails(activePrData)`
  whenever live details existed. Live check runs replaced metadata `s` in the
  context chip, and in action gating (`liveCiFailed`). None of these overrides
  took part in the provider-revision comparison that metadata readers use.
- Invalidation-driven and mount rereads in `use-github-pr-details.ts` used the
  default fetch cache mode. GitHub answers
  `Cache-Control: private, max-age=60`, so a reread could return the stale
  response. It was still recorded as a fresh read, so that server version bump
  never refetched; only the 15 s fallback poll bypassed the cache.
- Current-PR selection lived in `session-list-rows.ts`,
  `session-tasklist-mapping.ts`, `session-github-state.ts` and
  `archive-view.tsx`. Only `session-github-state.ts` restricted Project groups
  to the Member's repository.
- Metadata already models several PRs. `pullRequests` is the reconciler-owned
  association list; the current PR is the last item per repository. Lifecycle
  registers resolve status by provider revision (see
  [independent association and lifecycle ownership](../bug-fix/2026-10-25-multi-repository-pr-panel-loss.md)).
  CI and merge state live in `pullRequestState[url]`.

## Decision

1. **One source.** Summaries of PR status, CI, merge state and readiness come
   only from session metadata. Client GitHub fetches feed only the PR tab and
   the CI run list. They neither override summaries nor enter action gating.
2. **One reader.** `resolveSessionPullRequestViews(meta)` in
   `packages/shared/src/session-pull-requests.ts` returns every associated PR
   in association order. Each view carries URL, repository, number, resolved
   status, `ci`, `merge`, `readiness`, and `current` (the last PR of its
   repository). `selectPrimarySessionPullRequest(views, repository?)` keeps
   the existing rules: with no repository, the newest legacy `reportedAt`,
   else the last association; with a name, only that repository's PRs; with
   `null`, none. `resolveSessionPrimaryPullRequest(meta, activeRepository?)`
   applies the Info Bar's repository rule. Sidebar, task list, home, chat
   landing, archive and Project Member rows, and `getSessionGitHubState`, all
   use these functions.
3. **Multi-repository agreement.** A Project-group session's sidebar row shows
   its legacy repository's PR (the `project` repository, else
   `repoFullName`). This is the PR its Info Bar shows when no Member is selected.
4. **Subscription seam.** Explicit subscribe/unsubscribe records will join
   `SessionPullRequestViewSource`, and will be merged with the discovered list
   only inside `resolveSessionPullRequestViews`. No field, storage or
   subscription behavior exists yet.
5. **The Info Bar shows only the primary PR**; listing several is follow-up
   work.
6. **CI pill.** The pill's verdict and the popover header use the metadata CI
   code (`s` passed; `f`/`e` failed; `p`/`x` running), the same code the
   sidebar icon and the Fix CI gate read. Live runs only list the checks; with
   no metadata code the pill gives no verdict.
7. **Speed.** Opening a session publishes viewing presence. The reconciler
   moves the session to the high lane: a due target is polled after the ~1 s
   viewer debounce, then every 20 s. Hosted webhooks write lifecycle registers
   almost immediately. Neither the lanes nor the reconciler configuration
   changed.
8. **Fetch hook.** Every slice read passes `{ cache: 'reload' }`; the hook has
   no cache-mode option, so a reload read can never join a cached in-flight
   read and record a stale body as fresh.
9. **Agreement after actions.** `mergePullRequest` and `markReadyForReview`
   resolve `true` only when GitHub merged the PR or the ready transition
   landed. Only then does `use-awaited-pr-status.ts` keep the button pending
   until the metadata status reaches its target, for at most 15 s. A different
   PR never inherits the wait.
10. **Identity.** A view's repository and number come from its URL; the
    deprecated `repository`/`number` fields apply only when the URL does not
    parse. Currency, primary selection and Member rows use that same key.

## Alternatives

- **Client observation store merged with metadata by freshness (rejected).**
  Live fetch results would go into an in-memory store, merged with metadata by
  revision, and the sidebar would read it too. Lifecycle has comparable
  provider revisions, but CI `t` is the machine-side time of the last change,
  not a provider revision, so freshness becomes a guess from observation time.
  Agreement would hold only within one window, and with several PRs the client
  would have to fetch each one.
- **Renderer writes live observations back to metadata (rejected).** This
  needs a third lifecycle source and a Spec change, adds sync cost, and
  conflicts with the rule that renderers do not persist what detail reads
  capture.

## Consequences and limits

- Agreement holds by construction: every summary reads the same synced data.
- While the machine is offline, the client no longer supplements the CI
  summary or the Fix CI action. Main-path-first puts this out of scope.
- The PR tab's state line still uses live details and may briefly lead the
  summary.
- If metadata has not caught up when the 15 s action timeout ends, the button
  re-enables while the status mark still shows the old state.

## Verification

- `packages/shared/tests/session-pull-requests.test.ts` ("session PR views"):
  multiple repositories, legacy `reportedAt` ordering, the lifecycle register
  winning, missing `pullRequestState`, the Project-group primary.
- `packages/components/tests/session-list-rows.test.ts`: sidebar row, task
  list and `getSessionGitHubState` name the same Project-group PR.
- `packages/components/tests/session-info-context-actions.test.tsx`: the chip
  renders the metadata CI verdict even when a live run fails, gives none
  without metadata, and labels the PR with its URL number.
- `packages/components/tests/session-project-members.test.ts` and the shared
  view test: a stale legacy `repository`/`number` never moves a PR.
- `packages/components/tests/use-github-pr-details.test.ts`: mount,
  invalidation and mergeability-poll reads use `cache: 'reload'`; merge and
  ready report completion only when it happened.
- `packages/components/tests/use-awaited-pr-status.test.tsx` (fake clock):
  the wait ends when status agrees or after the timeout, and never crosses PRs.
- Not verified: the running hosted app, real webhook and poller latency, and
  archive rows (no render test; they call the tested selector).
