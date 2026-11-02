# Local GitHub PR observation

Status: draft
Translation: current

[中文](local-github-pr-observation.zh.md)

A local Git project with a GitHub remote can show its conversation's PR and CI
summary using credentials available on its machine. It does not need a Lody
cloud account, GitHub App installation, or product-cloud repository registration.
A remote identifies the repository; only a successful GitHub query establishes
read access. A folder without a GitHub remote still supports local branch display.

## Responsibilities

Creation records the repository identified by the shared Git remote resolver.
Activating or explicitly refreshing an existing local workspace fills a missing
repository identity after observing its runtime branch. This does not replace an
already-recorded repository or change the local project's identity.

The machine's existing PR reconciler handles discovery, status, CI summary,
quotas, retry and polling cadence. It uses the managed credential when available,
otherwise local `gh` authentication for github.com. Local credentials stay on the
machine. Missing credentials are retried, and credential changes are observed
without restarting. Inability to query `/user` does not rule out PR access;
unidentified credentials share a conservative quota bucket.

Successful exact-branch GitHub observations are published into owner session
metadata in both local and hosted workspaces. Hosted webhook association is a
separate effect: rejection or transport failure must not hide a verified PR or
leave Create PR available. Retry association under the existing polling gates;
only successful association and publication commit a discovery success stamp.
The hosted client additionally cools down failed association requests per workspace
and repository across callers. Permission rejection waits 15 minutes; transient
failures back off from one minute up to 15 minutes. This gate neither blocks GitHub
observation/publication nor confirms a skipped association. Before exhaustion, a later eligible call
rechecks access; no timer replays an old request. Six consecutive failures exhaust
the shared workspace/repository budget. Further association calls return unconfirmed
without network I/O, and one actionable error is logged. Success before exhaustion
resets the budget. After exhaustion, fix access in Settings > GitHub and restart
the machine's Lody background agent to recreate the client and retry; re-login alone
does not establish repository linkage. The PR identity error explains this path.
Tracking is bounded to 256 outstanding repository gates, including in-flight calls.
A full tracker refuses new repository requests rather than evicting an exhausted
gate; an existing successful association frees its slot.
An older discovery fingerprint must not suppress this retry after a terminal PR
is published. Successful associations are remembered for the workspace runtime;
after restart, eligible discoveries can idempotently re-establish them.
Missing authentication, inaccessible repositories and failed queries
never invent a PR or erase a previously successful observation. Login and access
changes take effect at a subsequent eligible polling attempt, respecting cooldowns
and exhaustion. GitHub observation remains independent of this hosted linkage budget.

## Association and lifecycle ownership

The owning machine reconciler alone maintains associated PR membership and order.
Hosted association establishes webhook linkage; it MUST NOT replace the session's
association list. Renderers MUST NOT persist lists captured during detail reads.

Lifecycle observations are independent per canonical repository-qualified PR URL
and source. Machine reads and hosted webhooks MUST preserve each other's records.
Readers resolve the greatest GitHub update revision, falling back to the legacy
association status when no observation exists. For equal revisions, a machine
live read wins a webhook tie; ambiguous webhook-only ties converge deterministically.
GitHub's second-resolution timestamp cannot establish ordering within that second.
Later provider revisions supersede either source, including reopening a closed PR.
Receipt time MUST NOT make an older provider revision authoritative.

An observation MUST NOT create an association or revive a deleted session.
Unassociated observations remain invisible. Retention is bounded to source registers
per observed PR for the session's lifetime, not a growing event history.
Machine-offline hosted observations continue to update new clients' summaries.
Old clients read the compatibility array and may wait for the machine to refresh it;
all active clients must upgrade to remove legacy renderer list writers.

The desktop reads the same metadata for local and hosted projects. Without hosted
GitHub integration, PR links open GitHub in the browser; detailed checks, review
and mutation APIs are not enabled by local summary access. In hosted PR views, an unconfirmed association must not block reading a public
repository: successful anonymous GitHub metadata establishes read access, without
granting authenticated access or enabling mutations. A known numeric repository ID
remains binding. Public reads stay separate from authenticated caches and tokens.
When neither hosted nor public detail reads succeed, a recorded PR keeps
a recoverable presentation with its GitHub link rather than a bare failure, and
mutation affordances require both loaded details and confirmed hosted identity. Branch observation is
event-driven; PR discovery and status use bounded background polling, not a new
polling loop per view. Product-cloud requests remain forbidden in local mode.

## Evidence

- [Reconciler boundaries](../apps/cli/src/lib/pr-poller/AGENTS.md)
- [Workspace Git observer](../apps/cli/src/session/workspace-git-service.ts)
- [Decision](../.agents/notes/implemented/feature/2026-09-24-local-github-pr-observation.md)
- [Hosted publication correction](../.agents/notes/proposed/bug-fix/2026-10-01-pr-observation-association.md)
