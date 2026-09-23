# Workflow security guidelines

Binding constraints for `workflows/`. Root and `.github/AGENTS.md` instructions
apply; read this file before changing a workflow.

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
- Code CI runs on `pull_request` with read-only repository permissions and
  checks out all public submodules recursively.
- Desktop journey authoring runs on a maintainer machine. GitHub workflows never
  receive Codex credentials or publish author output; an ordinary PR exposes the
  reviewed patch to the existing read-only code checks.
