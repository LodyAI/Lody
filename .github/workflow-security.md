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
replace main-push evidence. This workflow does not run on pull requests; Darwin-only
failures are detected after merge by the full product suite, which includes CLI
and Electron release/packaging tests. Main-push coverage remains non-canceling.

## Merge admission

Repository rules, rather than agent instructions, enforce merge admission. The
recommended default-branch rules require `Static checks` and `Tests` from GitHub
Actions, with the branch up to date before merging and no routine bypass. A new required check is
activated only after its workflow has reported on a PR; otherwise existing PRs
can wait forever for a check that their workflow never emits.

Require a pull request and block force pushes/deletion. Do not use `Restrict
updates` as a CI gate: without bypass actors it blocks all branch updates,
including PR merges. Auto-merge can wait for required checks once enabled by an
owner. A merge queue is a later option for busy branches; CI workflows must first
handle `merge_group` events and validate the queued combination.

These workflow files do not configure repository rules or enable auto-merge.
Main-only native and macOS product coverage remain independent from the required
`Tests` check. When removing a PR job, remove its required-check entry from
repository settings so PRs do not wait for a check that no longer runs.

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
- This legacy cross-repository build receives no signing, notarization, update-feed,
  storage or registry credentials. New cloud release workflows use the isolated
  environments described below.

## Cloud client releases

- Client release entry points run only on trusted `main` or `release`, never on PR
  events or `pull_request_target`. Every remote Action is pinned to a full commit SHA.
- `CLIENT_RELEASES_ENABLED` must equal `true` before any release admission proceeds.
  Keep it disabled until Track A/B integration and owner cutover are complete.
- Cloud Nightly uses `cloud-nightly` on `main`; Next uses `cloud-staging` on `main`;
  stable uses `cloud-production` on `release`, with owner-configured required reviewers.
  Manual production recovery also dispatches from `release` and pins its full SHA.
- Signing, notarization and storage credentials belong only to consuming steps;
  workspace installation precedes signing-material creation. npm uses OIDC without
  a static token. Do not print environment dumps or secret values.
- Preserve non-canceling release locks, same-run immutable retry artifacts, reserved
  Nightly versions, immutable-object conflict checks and assets-before-feed ordering.
  Every client publisher waits for public SEA installation checks for its exact version.
- Private and public publishers must never write the same channel concurrently.
  Cutover disables the private writer first; rollback disables the public writer first.

The [migration guide](client-releases.md) records entry points, A/B script contracts,
configuration and validation limits.
