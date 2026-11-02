# One read model for session pull requests

Status: proposed
Translation: current

[中文](2026-11-02-session-pr-read-model.zh.md)

## Abstract

In hosted sessions the Info Bar's PR status (open/closed/merged) and CI summary
lag visibly behind the sidebar and can disagree with it. The sidebar reads
session metadata, while the Info Bar unconditionally overrides that metadata
with its own GitHub detail fetch. That fetch takes no part in the existing
provider-revision comparison, and its invalidation-driven rereads can hit the
browser HTTP cache (GitHub answers `max-age=60`). Separately, the rule that
picks the "current PR" exists in three copies, so in a multi-repository session
the two surfaces can show different PRs. This proposal makes session metadata
the only source of PR summaries. Every surface would read it through one pure
`@lody/shared` function that returns views of all the session's PRs. Opening a
session gets faster through the machine reconciler's existing "viewed" high
lane. That function is also the single merge point reserved for explicit PR
subscribe/unsubscribe later. Unverified: worst-case hosted CI latency would
move from the client's 15 s poll to the reconciler's 20 s high lane.

## Problem and evidence

- In `session-chat-interface.tsx`, `effectivePrStatus` takes
  `derivePrStatusFromDetails` whenever `activePrData` exists. In
  `session-info-chips.tsx`, live check runs replace metadata `s`. Action gating
  mixes both sources too (`liveCiFailed`).
- In `use-github-pr-details.ts`, the `serverVersions` invalidation reread and
  the mount reread call `fetchSlice(slice)` without `cache: 'reload'`. After a
  cached response they still record `*FetchedAt` as now, so that invalidation
  never refetches. Only the 15 s fallback poll bypasses the cache; public reads
  poll every 300 s.
- The current-PR selection is implemented separately in `session-list-rows.ts`,
  `session-tasklist-mapping.ts` and `session-github-state.ts`. Only the last
  one filters by the multi-repository Member's repository.
- Metadata already models several PRs. `pullRequests` is the association list,
  written only by the reconciler; the current PR is the last item per
  repository. `resolveSessionPullRequests` resolves status from the machine and
  webhook lifecycle registers by provider revision (see
  [independent association and lifecycle ownership](../../implemented/bug-fix/2026-10-25-multi-repository-pr-panel-loss.md)).
  CI and merge state live in `pullRequestState[url]`.

## Decision

1. **One source.** Summaries of PR status, CI, merge state and readiness come
   only from session metadata. Client GitHub fetches feed only the PR tab and
   the CI run list. They neither override summaries nor enter action gating.
2. **One reader.** Add `resolveSessionPullRequestViews(meta)` to
   `packages/shared/src/session-pull-requests.ts`. It returns the full list in
   association order. Each view carries URL, repository, number, resolved
   status, `ci`, `merge`, `readiness`, and whether it is its repository's
   current PR. A primary selector takes an optional repository. With one, it
   returns that repository's current PR. Without one, it keeps today's rule:
   order by legacy `reportedAt` when present, otherwise take the last item.
   Delete the three copies. The sidebar, task list, mobile rows, Info Bar and
   its action state all use the new reader.
3. **Multi-repository agreement.** For multi-repository sessions the sidebar
   uses the same default Member repository the Info Bar shows when nothing is
   selected.
4. **Subscription seam.** The signature leaves room for a later
   "discovered ∪ subscribed − unsubscribed" input. This change adds no fields,
   no storage and no subscription behavior.
5. **The Info Bar still shows only the primary PR.** Showing several PRs is
   follow-up work.
6. **CI popover.** Its header verdict comes from metadata; the run rows below
   come from the live fetch.
7. **Speed.** Opening a session publishes viewing presence. The reconciler then
   moves the session to the high lane: a due target is polled after the ~1 s
   viewer debounce, then every 20 s. Hosted webhooks write lifecycle registers
   almost immediately. No new lane and no reconciler configuration change.
8. **Fetch hook fix.** Invalidation-driven and mount rereads bypass the HTTP
   cache, so the PR tab and run rows are equally timely.
9. **Agreement after actions.** After a successful merge, ready-for-review or
   close, the button stays pending until the shared view shows the target
   status or 15 s pass. The button and the status mark therefore never
   contradict each other.

## Alternatives

- **Client observation store merged with metadata by freshness (rejected).**
  Live fetch results would go into an in-memory store, merged with metadata by
  revision, and the sidebar would read it too. Lifecycle has comparable
  provider revisions, but CI `t` is the machine-side time of the last change,
  not a provider revision, so freshness becomes a guess from observation time.
  Agreement would also hold only within one window, and with several PRs the
  client would have to fetch each one.
- **Renderer writes live observations back to metadata (rejected).** This
  needs a third lifecycle source and a Spec change, and adds sync cost. It also
  conflicts with the existing rule that renderers do not persist what detail
  reads capture.

## Consequences and limits

- Agreement holds by construction: every summary reads the same synced data.
- Worst-case hosted CI latency moves from the client's 15 s poll to the 20 s
  high lane; status changes delivered by webhook are essentially unchanged.
- While the machine is offline, the client no longer supplements the CI
  summary. Main-path-first puts this out of scope.
- The PR tab's state line still uses live details and may briefly lead the
  summary.

## Verification plan

- Unit tests for the shared function: multiple repositories, legacy
  `reportedAt` ordering, the lifecycle register winning, missing
  `pullRequestState`.
- Component tests that the Info Bar and sidebar render the same status and CI
  from the same metadata, including when live details contradict it.
- A `use-github-pr-details` test: invalidation rereads use `cache: 'reload'`
  (fake fetch; assert request options and resulting state).
- A fake-clock test: an action stays pending until the view updates or the
  timeout passes.
