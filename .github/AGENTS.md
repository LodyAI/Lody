# GitHub contribution automation

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Ownership

| Area                | Source of truth                                                | Contract                                                                         |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Contributor prompts | `PULL_REQUEST_TEMPLATE.md`, Issue Forms                        | Ask only for public, actionable contribution context.                            |
| PR validation       | `scripts/check-pr-body.mjs`                                    | Validate the rendered template contract without GitHub mutations.                |
| PR reconciliation   | `scripts/pr-policy.mjs`                                        | Own disposition, findings, labels, comments, grace period, cleanup, and expiry.  |
| Issue linking       | `scripts/pr-issue-link.mjs`                                    | Parse and normalize only `## Related issue`.                                     |
| Event orchestration | `workflows/pr-policy.yml`, `workflows/pr-policy-reconcile.yml` | Route every PR event and audit through one concurrency group and one reconciler. |
| Scope labels        | `labeler.yml`, `workflows/pr-scope.yml`                        | Derive configured `scope:*` labels from changed paths.                           |
| Code checks         | `workflows/ci.yml`                                             | Preserve the stable `Static checks` and `Tests` jobs used as required checks.    |
| Codex review        | root `AGENTS.md` `## Code Review Rules`, `codex-review.md`     | Report only P0/P1, security first; 👍 when the linked Issue is solved.           |

Do not duplicate a rule across these layers. Changes to required PR template
headings must update the checker in the same commit and validate representative
complete and rejected bodies locally.

## Contribution contract

- `gh pr create --body` silently skips `PULL_REQUEST_TEMPLATE.md`. Draft the PR
  body from the template and validate it with
  `node .github/scripts/check-pr-body.mjs --body-file <file>`.
- Every fork-based PR references a Lody Issue and retains the complete Context
  handoff block and its markers. Use `Closes #123` when merging the PR should
  close the Issue and `Refs #123` only when it must stay open. A bare `#123` or
  full Lody Issue URL in `## Related issue` defaults to `Closes #123`.
- Every Authoring context field is a concise public summary. `N/A` and redacted
  values are not accepted because maintainers need enough provenance, scope,
  and risk information to assess the contribution.
- Review instructions are a PR-specific handoff to the organization owners'
  reviewing Agent. Require concise review focus, decisions to challenge, and
  plausible failures or evidence gaps; generic checklists and review essays are
  not valid substitutes.
- An Agent preparing a fork-based contribution explains that the Context handoff
  is public and an invalid PR closes after the seven-day correction period.
- Same-repository branches do not create or require an Issue solely for intake,
  and their bodies are not subject to the external contribution template.

## PR policy

`pullRequestDisposition` classifies each current PR before any mutation:

| Disposition | Condition                                     | Behavior                                                                                |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `bot`       | Author login ends in `[bot]`                  | Do not normalize or enforce; clear prior managed state when present.                    |
| `bypass`    | `status:pr-policy-bypass` is present          | Do not normalize or enforce; clear prior managed state when present.                    |
| `internal`  | Numeric `head.repo.id` equals `base.repo.id`  | Normalize an explicit Issue reference; do not enforce the external template.            |
| `external`  | Repository ids differ or either id is missing | Normalize an explicit Issue reference, then enforce the complete contribution contract. |

`author_association` never classifies a PR. A fork remains external when its
author is an owner or member. The bypass label is an explicit maintainer action
whose authorization comes from GitHub's label permissions; the workflow does
not infer identity from PR text. Removing the label immediately resumes normal
classification and enforcement.

Issue normalization is a stateless, idempotent body edit on human PRs targeting
the default branch. It operates only on exact references in
`## Related issue`; never infer an Issue from a title, branch name, another body
section, or a diff. Explicit `Refs` and native closing keywords remain
authoritative. A failed normalization is warning-only and must not hide the
validation result.

External validation has one persistent state flow:

```text
valid <-> status:needs-pr-attention (invalid-since) -> status:pr-policy-expired + closed
```

All template and size findings share the same comment, label, timestamp, and
seven-day correction period. A change over 200 additions plus deletions without
its prior Issue reference adds a size-specific finding; it does not create a
second status. A valid edit or a skipped disposition clears managed enforcement
state. An expired external PR is closed again when reopened; bypass or internal
classification clears the expired state instead. Before closing an overdue PR,
the audit must re-read and revalidate the latest PR.

Issue-link normalization and cleanup after a valid or skipped disposition are
best-effort feedback. The current validation result alone decides whether an
event-driven external PR check passes. Creating invalid state and completing
expiry are required reconciliation writes; scheduled and manual audits surface
their failures and perform expiry.

## Workflow security

- `workflows/pr-policy.yml` is the only PR policy event entry point.
  `workflows/pr-policy-reconcile.yml` is callable only through `workflow_call`.
- Workflows that pass signing or update keys to a third-party Action must pin that
  Action to a reviewed full commit SHA. Scope signing secrets to the exact trusted
  preparation, packaging, or signing step that consumes them; never place them in a
  job-level environment inherited by unrelated actions and dependency scripts.
- `pull_request_target` provides a write-capable token. For PR events, checkout
  policy from trusted `github.sha`; scheduled and manual audits use
  `github.event.repository.default_branch`. Never checkout or execute the PR
  head, and never use the possibly stale `pull_request.base.sha`.
- Re-read PR details through the API before classification. Body, labels,
  repository ids, changed-line totals, and open state must come from the same
  current response.
- Code CI runs on `pull_request` with read-only repository permissions and
  checks out all public submodules recursively.
- Desktop journey authoring runs on a maintainer machine. GitHub workflows never
  receive Codex credentials or publish author output; an ordinary PR exposes the
  reviewed patch to the existing read-only code checks.

## Other automation

- Issue Forms cover only components present in the public repository. Keep Bug
  and Feature title prefixes, issue types, and existing labels aligned; route
  product support and security reports out of public issues, and request only
  diagnostics contributors have checked and redacted.
- `scripts/check-issue-body.mjs` mirrors required rendered headings and
  confirmations in both Issue Forms. Non-owner, non-bot issues that bypass or
  remove them receive warning-only `status:needs-issue-body`; regular
  organization members are not exempt. A valid edit clears bot-owned state.
- `labeler.yml` is the source of truth for path-based `scope:*` labels. Overlap
  is intentional when a PR affects multiple product areas.
