# Visual acceptance

Use real browser captures to verify rendered styles and interactions. The static-build
gate records reproducibility and Before/After differences; the Electron smoke checks
the built desktop separately. Neither establishes unvisited product coverage.

| Entry                                                                                                                                                                                                                                                        | Purpose                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`accept.mjs`](accept.mjs), [`accept.test.mjs`](accept.test.mjs)                                                                                                                                                                                             | Baseline/verify CLI and its real-browser positive and negative controls.                                |
| [`profiles/components.mjs`](profiles/components.mjs), [`profiles/docs.mjs`](profiles/docs.mjs)                                                                                                                                                               | Product stories and docs pages across themes, viewports and interaction states.                         |
| [`profiles/design-system-core.mjs`](profiles/design-system-core.mjs), [`profiles/design-system-rich-inputs.mjs`](profiles/design-system-rich-inputs.mjs), [`profiles/design-system-context.mjs`](profiles/design-system-context.mjs)                         | Compare intentional material, typography and context changes without treating them as pixel-equivalent. |
| [`profiles/design-system-browser-annotations.mjs`](profiles/design-system-browser-annotations.mjs), [`profiles/design-system-pr-emoji.mjs`](profiles/design-system-pr-emoji.mjs), [`profiles/design-system-command.mjs`](profiles/design-system-command.mjs) | Browser/annotation controls, merge actions, Emoji and Command interaction states.                       |
| [`profiles/design-system-contracts.mjs`](profiles/design-system-contracts.mjs), [`profiles/design-system-context-contracts.mjs`](profiles/design-system-context-contracts.mjs)                                                                               | After-only token, material, effective disabled opacity, focus and context-action contracts.             |
| [`electron-smoke.mts`](electron-smoke.mts)                                                                                                                                                                                                                   | Actual OSS Electron startup, onboarding and local chat through the isolated E2E harness.                |

## Run the static-build gate

Use the repository's supported Node and pnpm versions and an installed Chromium.
From `packages/components`, build each source version into a different directory:

```sh
pnpm exec storybook build --output-dir /tmp/lody-ui-before
```

Capture that unchanged build before editing the owned surface:

```sh
node tests/visual/accept.mjs baseline \
  --build /tmp/lody-ui-before \
  --profile tests/visual/profiles/components.mjs \
  --out artifacts/visual/ui-before --browser /path/to/chromium
```

After implementation and the owning behavior tests, build and verify the same profile:

```sh
pnpm exec storybook build --output-dir /tmp/lody-ui-after
node tests/visual/accept.mjs verify \
  --build /tmp/lody-ui-after --baseline artifacts/visual/ui-before \
  --profile tests/visual/profiles/components.mjs \
  --out artifacts/visual/ui-after --browser /path/to/chromium
```

`pnpm run test:visual` invokes the same CLI. `pnpm run test:visual:harness` exercises
its real-browser success and failure paths with synthetic harness fixtures; those
images are not product acceptance evidence. `--browser` overrides
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and Playwright's default executable.

Both modes refuse an existing output directory. Verification requires a successful
baseline with the same runner, profile, browser executable/version, Playwright, OS,
Node and policy fingerprints. It never updates the baseline. Changing any of those
inputs requires a new baseline and a new output directory. Keep static builds and
profile inputs unchanged throughout capture; the runner rechecks their hashes.

Open `report.html` in the output directory. It embeds the original PNGs and records
failures alongside successful cases. `manifest.json`, PNG hashes, layout snapshots,
raw difference images and cleanup results remain available beside it. Output belongs
under ignored `artifacts/visual/`; generated reports, captures, inventories and
one-run target manifests are not source files to commit.

## What a pass establishes

Each scenario runs twice in independent browser contexts. A baseline must reproduce
itself. Verification must reproduce itself and match the baseline with zero raw RGBA
pixel differences and equal recorded geometry/content. Computed CSS differences are
recorded separately. There are no tolerance thresholds, image masks or automatic
baseline updates. A nonzero raw difference remains open even when another comparator
would round it down to zero.

The runner fixes locale, timezone, clock, random seed, DPR, color profile and reduced
motion. It finishes finite animations, pauses infinite animations and SVG SMIL at
zero, and hides the caret. This compares declared endpoints; it does not verify
continuous motion or native iOS/WebKit rendering. A narrow Chromium viewport also
does not establish a mobile UA-dependent branch.

Profiles own real readiness and actions. They wait for the actual story/page, effective
theme and intended visible state. The runner also waits for fonts, images and stable
geometry and checks that the recorded DOM/layout does not change during the screenshot.
Stable geometry alone is insufficient when a popup is still transparent, a label is
clipped or a request has not completed. Add an observable readiness condition instead
of a delay, mask or replacement screenshot.

Full-page screenshots include portals; `root` scopes the geometry snapshot. External
requests are aborted. Undeclared external requests, failed assets, application page
errors and unexpected workers fail capture; explicitly blocked nonvisual requests
remain recorded. Sandbox frames retain their native restrictions, and theme storage
initialization is limited to the top-level document. The runner owns the static server
and browser it starts. Cleanup failure also fails the command, with bounded shutdown
and resource results retained in the manifest.

## Design-system checks

Use the design-system comparison profiles with the same baseline/verify commands.
An intentional appearance change still fails strict old/new equivalence. Review its
raw images and geometry against the agreed design-system decision; do not change the
gate to relabel that difference as a pass.

Run the contract profiles against the final build to check rendered family tokens,
single focus ownership, effective disabled opacity and real actions. A baseline of
that final build checks the contracts and independent repeatability; verification
against the same build checks repeatability again. This is After-only evidence and
cannot establish equivalence to the old design. Scope and exceptions belong to the
[design-system decision](../../../../.agents/notes/implemented/architecture/2026-11-07-design-system-convergence.md).

When extending coverage, add a maintained scenario to the relevant profile. Render
production components with synthetic data, exercise actual pointer/keyboard actions,
and include the relevant rest, hover, focus, disabled, pending, error and responsive
states. Keep expected data branches and unavailable fixtures explicit. A matching
fallback does not qualify a loaded-avatar branch, and an unvisited branch remains
unverified.

Retain failed runs and their original source/build/profile fingerprints in ignored
artifacts. A corrected run gets a new directory. Later successful subsets do not close
unexplained earlier pixel differences, invalid readiness, incomplete cleanup or missing
application baselines. Keep the current open issues in the acceptance report and its
owning decision; this README is the workflow reference, not a batch-results ledger.

## Real desktop smoke

From the repository root, build the desktop and run the existing harness:

```sh
pnpm --dir apps/electron build
pnpm --dir e2e exec tsx --tsconfig ../apps/cli/tsconfig.json \
  ../packages/components/tests/visual/electron-smoke.mts
```

The smoke uses the actual main/preload/renderer graph with isolated application data.
It records build hashes, screenshots, logs and shutdown results under
`packages/components/artifacts/visual/`. It reaches an editable local chat through
onboarding and checks that the workspace fills its viewport. Set
`LODY_STYLE_MIGRATION_SCHEDULES=1` to additionally exercise the local schedule editor.
A single run is After-only evidence, not a full-app Before/After comparison or proof
of every backend/native interaction.

Behavior tests remain separate from screenshot acceptance. From `packages/components`,
use the owning suites with jsdom's storage on Node 26:

```sh
NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm exec vitest run --maxWorkers=2
```

For style ownership and caller composition, see the
[StyleX migration guide](../../src/style/MIGRATION.md).
