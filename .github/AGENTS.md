# GitHub contribution automation

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- Keep contributor-facing prompts in `PULL_REQUEST_TEMPLATE.md`, policy logic in
  tested modules under `scripts/`, path ownership in `labeler.yml`, and GitHub
  event orchestration in `workflows/`. Do not duplicate the same rule across
  those layers.
- Changes to required PR template headings must update the checker in the same
  commit and validate representative complete and rejected bodies locally.
- Every external PR links a full Lody issue URL and retains the complete Context
  handoff block and its markers. Each Authoring context field is a concise public
  summary; `N/A` and redacted values are not accepted because maintainers need
  enough provenance, scope, and risk information to assess the contribution.
- Review instructions are a PR-specific handoff to the organization owners'
  reviewing Agent. Require concise review focus, decisions to challenge, and
  plausible failures or evidence gaps; fixed generic reviewer boilerplate and
  long review essays are not valid substitutes.
- `labeler.yml` is the source of truth for path-based `scope:*` labels. Overlap
  is intentional when a pull request affects multiple product areas.
- Issue forms cover only components present in the public repository. Keep Bug
  and Feature title prefixes, issue types, and existing labels aligned; route
  product support and security reports out of public issues, and request only
  diagnostics that contributors have checked and redacted.
- External pull request body enforcement is based on the PR author's
  `author_association`. Only `OWNER`, `MEMBER`, and automated bot accounts are
  exempt; outside collaborators and prior contributors remain subject to it.
- Workflows triggered by `pull_request_target` have a write-capable token. They
  must never check out the pull request head or execute files supplied by the
  pull request. Read scripts and configuration from the base commit only.
- Code CI runs on `pull_request` with read-only repository permissions, checks
  out all public submodules recursively, and keeps the stable `Static checks`
  and `Tests` jobs aligned with the root validation scripts so they can be used
  as required status checks.
- `scripts/pr-body-policy.mjs` owns PR-body status labels, comment markers, and
  the seven-day grace period. An invalid external PR keeps its original timer
  across edits and pushes; only a valid body clears the state. Before closing,
  the scheduled workflow must re-read and revalidate the latest body.
- External PR size enforcement counts additions plus deletions. A change over
  200 lines without a full Lody issue URL is labeled `status:pr-too-large` and
  closed; reopening it closes it again, so contribution continues through a new
  PR after issue discussion. Automation does not infer maintainer agreement.
- PR-body comments require pull-request write permission. Immediate comment and
  label updates are best-effort feedback; the checker result alone decides the
  event-driven enforcement job. Expired PRs keep `status:pr-body-expired` and
  are closed again when reopened, so a contributor must submit a new PR.
