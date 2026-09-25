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

Hosted association is required before publication only when the hosted port is
present. Local mode publishes successful observations directly into owner session
metadata. Missing authentication, inaccessible repositories and failed queries
never invent a PR or erase a previously successful observation. Login and access
changes take effect at a subsequent eligible polling attempt, respecting cooldowns.

The desktop reads the same metadata for local and hosted projects. Without hosted
GitHub integration, PR links open GitHub in the browser; detailed checks, review
and mutation APIs are not enabled by local summary access. Branch observation is
event-driven; PR discovery and status use bounded background polling, not a new
polling loop per view. Product-cloud requests remain forbidden in local mode.

## Evidence

- [Reconciler boundaries](../apps/cli/src/lib/pr-poller/AGENTS.md)
- [Workspace Git observer](../apps/cli/src/session/workspace-git-service.ts)
- [Decision](../.agents/notes/implemented/feature/2026-09-24-local-github-pr-observation.md)
