# Explicit pull-request links for a Session

Status: implemented
Translation: current

[中文](2026-11-21-session-explicit-pr-links.zh.md)

## Abstract

Lody discovered a Session's PR only by repository plus the Session's runtime
branch. An agent that ran `gh pr create` from a temporary clone on another branch
(LodyAI/Lody #3019) produced a PR the Session never showed, and Create PR stayed
visible. Sessions now hold explicit link records. The managed `gh` shim reports
every PR it creates to the daemon, and users can unlink a PR from the Info Bar list.
The owner chose not to ship a manual link entry, because it would rarely be used. The reconciler stays the only writer of `pullRequests`: it associates
a linked PR only after the provider returns it. The owner approved the design on
2026-11-21.

## Decision

1. **Intent records, not associations.** Each link is its own Session metadata key,
   `prLink:<case-folded canonical URL>` = `{k: l|u, o: s|u|a, t}` (linked/unlinked;
   shim, user, agent; epoch ms). At most 32 per Session. Per-key records let a user's
   unlink and a machine's link of different PRs never overwrite each other, and they
   sync through ordinary metadata in local, hosted, encrypted and Roost workspaces.
2. **Provider verification before association.** A `linked` URL that is not
   associated becomes a status target queried by number, in any repository. A valid
   result is appended to `pullRequests`, then hosted webhook linkage runs as for a
   discovered PR. A missing PR, a forbidden repository or a missing credential writes
   `prLinkCheck:<key>` once per link generation and never invents an association.
3. **Unlink suppression.** `resolveSessionPullRequests` hides unlinked URLs from every
   reader, the reconciler removes them from the list without a provider query, and
   branch discovery skips them. A later `linked` record wins.
4. **Current PR.** The current PR is the most recently associated one. A newly linked
   PR becomes current; an open linked current PR stays current until another PR is
   newly associated. Provider updates to another open PR never move it. Otherwise the
   existing ranking applies (a newer PR on the runtime branch replaces an older one,
   and a terminal PR yields to an open one). An earlier revision ranked linked PRs like
   a branch match; with two open PRs that tie fell through to `updatedAt`, so the
   current PR followed whichever PR received the last comment, push or CI event.
5. **Primary slot.** A single-project Session's primary PR is the last PR of its
   project repository when it holds one there; links in other repositories are listed
   but never take that slot.
6. **Shim report.** After a successful `gh pr create` (REST or native), the shim
   posts the URL to the broker's `/pull-request/report` endpoint within 2 s. The
   daemon resolves the Session only from the host-authored context token (child Tab →
   owner) and writes a `shim` record. Exit code and stdout never change; stderr gets
   one factual line.
7. **Writers.** The renderer writes only the user's unlink records; the daemon writes
   shim and agent records through `apps/cli/src/lib/session-pr-links.ts`, whose
   link/unlink/list operations the `lody_session_manage` `pr_*` actions reuse for the
   calling Session ([action tools](2026-11-21-mcp-action-tools.md)).

## Alternatives

- **Parse PR URLs from agent output or guess by author and time (rejected by the
  owner).** Both associate unrelated PRs and are not provider-neutral.
- **Write `pullRequests` from the shim or the renderer (rejected).** It breaks the
  single-writer rule for membership and order and would associate unverified URLs.
- **A paste-URL field and a session-menu "Link pull request" entry (removed before
  merge by the owner).** They would rarely be used; the shim report and the agent
  action cover linking.
- **One map-valued metadata field (rejected).** A map value is replaced as a whole,
  so a concurrent user unlink and shim link could lose one of them.

## Consequences and limits

- Sessions without the managed shim (local projects using native credentials) and
  PRs created through other paths (GitHub MCP tools, raw API, web) are not linked
  automatically; the agent links them with `lody_session_manage` action `pr_link`
  ([action tools](2026-11-21-mcp-action-tools.md)).
- An unreadable link is retried at the discovery cadence and stays listed with a reason.
- Pending rows show the case-folded URL until the provider returns the PR.
- Auto delivery is unchanged; several PRs still stall it with `multiple_prs`.

## Verification

- `packages/shared/tests/session-pull-requests.test.ts` ("explicit session PR links").
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts` ("explicit PR links"): the
  #3019 sequence, a newly linked PR becoming current, a stable current PR while two
  open PRs alternate provider updates, a terminal linked PR yielding, unlink without a
  query, relink, unreadable once, and that several open PRs of one Session are all polled.
- `apps/cli/tests/gh-shim-script.test.ts`, `apps/cli/src/lib/git-credential-broker.test.ts`,
  `packages/components/tests/session-pr-links.test.tsx`.
- Not verified: a live daemon and GitHub round trip.
