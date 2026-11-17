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

## Darwin coverage

`macos-product-tests.yml` preserves full Darwin product coverage on hosted ARM64 macOS
for each main SHA. Keep read-only permissions, no production credentials, adapter
preparation before tests, and non-canceling concurrency per SHA. Manual runs cannot
replace main-push evidence.

## Private composition builds

`build-private-composition.yml` runs the private Lody composition's own build on
standard hosted runners. The [decision note](../.agents/notes/implemented/process/2026-11-11-private-composition-public-runners.md)
explains why the build is not reproduced from public configuration.

- It starts only by `workflow_dispatch` on `main`. Its credentials live in the
  `private-build` environment, whose deployment branch policy allows only `main`;
  pull requests and other branches never receive them.
- The source credential is a GitHub App installation token with Contents: read on
  `loro-dev/lody` only. Checkout uses `persist-credentials: false`, and no step
  receives the token afterwards.
- Build steps belong to the private repository's `public-runner-build` action at
  the requested SHA. This workflow validates inputs, checks out, runs that action
  and uploads; do not add build logic, source printing or environment dumps here.
- The build output leaves the runner only encrypted, through the pinned Buildgraph
  `upload` Action with `BUILDGRAPH_ARTIFACT_KEY`. The only plaintext artifact is the
  per-target index of artifact ID, digest and source SHAs. Run logs stay public.
- Signing, notarization, update-feed signing, storage and package-registry
  credentials never enter this repository; the private consumer holds them.
