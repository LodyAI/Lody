# Release compilation inputs

`build-release-artifacts.yml` runs heavy CLI and Electron compilation in this
repository. It produces compiled inputs, not a release authorization or signed
installer. Default local build commands remain unchanged. No deployment presets,
private source, signing keys, npm identity or storage credentials enter this builder.

Dispatch the workflow on `main` with a canonical request JSON and matching request
ID. `contract.mjs` bounds and validates the complete request. It fixes source SHA,
Desktop profile, embedded CLI version, standalone CLI version, time, explicit
public environment values, renderer policy additions and target set. Source must
be an ancestor of public main. Workflow SHA and checked-out source SHA are recorded
separately. PR runs use synthetic endpoints and cannot qualify for promotion.

Desktop requests build `mac`, `win`, `linux`, and `linux-arm64`; standalone CLI
requests build only `cli`, independently of Desktop success. macOS uses the hosted
ARM64 runner and preserves the existing private packaging stage's two-architecture
contract. This phase moves source compilation; native staging, Sparkle addon
rebuild, installer creation, signing, notarization and publication remain with the
consumer. It does not introduce an update protocol or change installed runtime code.

The artifact contains `request.json`, `receipt.json`, CLI `dist/`, the viewer's
`dist/` and generated `standalone.html`, and (for Desktop) Electron `out/`.
Inventory includes path, SHA-256, size and executable mode. Linked/special files,
unsafe paths and case-folding collisions are refused. The consumer restores modes
after download. No application-bundle symlinks are handed off in this phase.

The publishing controller must independently verify the GitHub repository,
workflow, event, approved workflow revision, run/attempt, complete requested target
set and GitHub artifact ZIP digests before checking receipt/request and every
payload byte. Receipt self-reporting is insufficient. A PR run or arbitrary
successful workflow is never eligible. Retrying cannot combine different attempts.

From the repository root, use the locked package manager and initialize public
submodules before installation. Run the owning tests with:

    node --test scripts/release-build/*.test.mjs

For a local compilation dry run, write a canonical synthetic request using
`fixtureRequest` from `fixture.mjs`, set its source SHA to the checkout, and run:

    GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 GITHUB_WORKFLOW_SHA=<checkout-sha> \
      node scripts/release-build/build.mjs /absolute/request.json linux release-output

These local IDs are fixtures, not real GitHub provenance. Keep the output untracked.
The target must match the build host. Do not publish fixture endpoints or promote
synthetic artifacts. The build runs existing adapter/viewer/CLI processes, then the
dedicated Electron config; it uses 2 GiB for CLI and 8 GiB for the renderer build.

## Darwin test contract

`macos-product-tests.yml` also runs existing public product tests on hosted ARM64
macOS for each main SHA, preserving Darwin-only coverage formerly repeated by a
private Mac. Consumers may reuse public tests only with successful Linux code CI
and macOS product-test evidence for their exact source. Manual and PR runs cannot
replace those main-push proofs. No test assertions or default local checks change.

Keep read-only permissions, no production credentials, and non-canceling concurrency
per source SHA: a newer main commit must not cancel an older source proof. Prepare
ACP adapters after a clean install before executing the full product suite.
