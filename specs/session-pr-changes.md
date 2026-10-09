# Session PR changes

Status: draft
Translation: current

[中文](session-pr-changes.zh.md)

The hosted Session pull-request tab exposes a Changes view alongside Summary.
When a reviewer selects all commits, one commit, or a contiguous commit range,
the view compares immutable commit SHAs and lists the changed files. File bodies
are fetched only when a file is expanded and are rendered through the shared diff
viewer. Historical selections are read-only; the current pull-request head is the
only full current pull-request diff may later receive review actions.

The view must not make local-only PR metadata behave like hosted PR access. A
local-only session continues to open its PR externally and does not use the hosted
detail, compare, or mutation APIs. Missing, binary, or oversized file bodies show
an explicit unavailable state and keep the GitHub link available.

The first version does not claim a “changes since your last review” selection,
because the client has no durable reviewer checkpoint. That option remains a
separate product decision.

## Evidence

- [Session PR view](../packages/components/src/components/sessions/pr-tab-view.tsx)
- [GitHub API client](../packages/shared/src/github-api.ts)
- [Diff range tests](../packages/components/tests/github-pr-diff.test.ts)
