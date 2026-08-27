# GitHub contribution automation

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- Keep contributor-facing prompts in `PULL_REQUEST_TEMPLATE.md`, policy logic in
  tested modules under `scripts/`, path ownership in `labeler.yml`, and GitHub
  event orchestration in `workflows/`. Do not duplicate the same rule across
  those layers.
- Changes to required PR template headings must update the checker and its
  regression tests in the same commit. Run `pnpm check:github-config` locally.
- External PRs identify exactly one author type. Agent-authored PRs retain the
  complete Agent handoff block and its markers, explicitly ask the author-side
  user about publishing context, and record exactly one consent answer. Never
  infer consent. Declining is allowed but must warn that maintainers may close
  or decline a contribution they cannot safely assess. Human-authored PRs do
  not need Agent context.
- Agent review instructions are a PR-specific handoff from the authoring Agent
  to the organization owners' reviewing Agent. Require concise review focus,
  decisions to challenge, and plausible failures or evidence gaps; fixed generic
  reviewer boilerplate and long review essays are not valid substitutes.
- `labeler.yml` is the source of truth for path-based `scope:*` labels. Overlap
  is intentional when a pull request affects multiple product areas.
- External pull request body enforcement is based on the PR author's
  `author_association`. Only `OWNER`, `MEMBER`, and automated bot accounts are
  exempt; outside collaborators and prior contributors remain subject to it.
- Workflows triggered by `pull_request_target` have a write-capable token. They
  must never check out the pull request head or execute files supplied by the
  pull request. Read scripts and configuration from the base commit only.
