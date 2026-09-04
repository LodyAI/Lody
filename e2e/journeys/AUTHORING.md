# Restricted journey authoring

This contract governs an automated author that proposes one deterministic
desktop journey at a time. The author prepares a reviewable candidate; it does
not own the active coverage matrix, the harness, CI, or product code.

## One-run contract

One authoring run selects exactly one uncovered user outcome and adds exactly
one Gherkin `Scenario`. A `Scenario Outline`, multiple scenarios, opportunistic
cleanup, or a second coverage gap belongs in a later run.

Every candidate starts as `@P1`. Promotion to `@P0` is a human decision because
P0 changes the merge-blocking contract. The scenario must otherwise satisfy the
repository contract: `@lody`, `@essence`, one stable `@LODY-AREA-NNN` id, and
one supported `@runtime-*` owner.

The author emits structured output that validates against
[`author-result.schema.json`](./author-result.schema.json). A ready result names
one bounded assertion replacement for the validation lane to execute. A blocked
result classifies why the journey cannot be completed without weakening it.

## Write boundary

The author may add or edit only these paths:

```text
e2e/src/features/**/*.feature
e2e/src/steps/**/*.steps.ts
e2e/src/support/pages/**/*.ts
e2e/src/support/fixtures/**/*.ts
e2e/src/support/fixtures/**/*.mjs
e2e/src/support/fixtures/**/*.json
e2e/src/support/fixtures/**/*.txt
e2e/src/features/README.md
e2e/src/steps/README.md
e2e/src/support/README.md
```

The three README files may change only to index the new Feature, step file, or
Page Object and to keep checker-owned counts accurate. Fixture contents must be
synthetic.

Everything else is read-only. In particular, the author must not change:

- `e2e/COVERAGE.md`, `e2e/AGENTS.md`, `e2e/README.md`, package manifests, lockfiles,
  Cucumber configuration, suite-checking scripts, Scout, or Acceptance;
- Electron, CLI, shared packages, production selectors, or product behavior;
- GitHub workflows, permissions, labels, branch protection, or issue state;
- the Electron harness, World, hooks, resource probes, or process lifecycle.

If a journey needs a new IPC capability, harness hook, selector, product change,
or a file outside the allowlist, stop with `test-capability` and name the missing
infrastructure in the summary. Do not work around the boundary and do not weaken
an existing assertion.

## Safety boundary

- Do not add `@skip`, `@wip`, conditional skips, retries, quarantine behavior,
  or catches that convert a failed assertion into a pass.
- Do not use live network services. The owned loopback Electron/CLI connection
  is part of the harness; every external model/provider response must use the
  existing deterministic scripted simulator.
- Do not read or capture a developer's Lody data, home directory, credentials,
  browser profile, environment secrets, or real conversation transcripts.
  Test identities, repositories, prompts, diffs, and responses must be synthetic.
- Do not introduce or execute arbitrary shell. Test code must not add
  `child_process`, `shell: true`, command strings, or dynamically constructed
  executables. Reuse only reviewed harness and fixture APIs already in the suite.
- Do not use real sleeps, wall-clock races, live model calls, external downloads,
  generated CSS selectors, or machine-load thresholds.
- Do not push, merge, approve, label, close, or open an Issue. A separate trusted
  workflow may publish the validated patch as a reviewable pull request.

The automated author runs in a Linux workspace with no repository write token.
It may use read-only inspection commands, but it does not execute generated test
code. A separate no-secret macOS job owns these verification commands:

```bash
pnpm e2e:build
pnpm e2e:check
pnpm --filter @lody/e2e exec cucumber-js --config cucumber.mjs --tags '@LODY-AREA-NNN'
pnpm e2e:full
git diff --check
git diff --name-only
git status --short
```

The stable-id placeholder in the targeted command is replaced with the single
candidate id. No pipes, redirects, command substitution, background processes,
extra Cucumber flags, or shell operators may be appended.

## Required implementation shape

1. Read the active scenarios and coverage material without editing them.
2. Select one user-visible outcome that is valuable, deterministic, and possible
   with the current harness. Record the gap evidence and why P1 is appropriate.
3. Reuse existing steps and Page Objects before adding narrow new ones. Steps
   express intent; Page Objects own selectors and interaction policy.
4. Use a stable accessible role or product-owned test id. Missing stable access
   is an infrastructure gap, not permission to edit the product.
5. Assert the completed user outcome and cleanup, not merely that a control was
   clicked or a mock was called.
6. Keep the external wire deterministic and preserve the real Electron main,
   preload, renderer, IPC, bundled CLI, persistence, and shutdown boundary.

## Discrimination experiment

A green scenario is insufficient: its key checkpoint must distinguish correct
behavior from an intentionally wrong state. The author declares exactly one
assertion ablation: a temporary replacement of the key outcome expectation in a
changed step or Page Object, without weakening the interaction or cleanup path.

The replacement targets one unique quoted expectation in a changed candidate
file and uses the exact per-candidate sentinel requested by the task. It must
make the focused scenario fail. The validator then restores the checksummed
candidate file before continuing. A counterfactual that passes proves the check
has no discrimination and is a `test-capability` failure.

Do not mutate product code, the harness, persisted developer state, or an
external service to manufacture the fault. Do not use a real defect as the
counterfactual: if the unmodified product fails the intended outcome, classify
that independently as `product-defect`.

## Validation gate

A candidate is published as a Draft PR only after the independent validator
records all of the following on the same candidate and built desktop:

1. `pnpm e2e:check`.
2. One counterfactual discrimination experiment that fails at the key
   checkpoint, followed by exact restoration of the candidate patch.
3. The targeted stable-id command in a fresh process three consecutive times.
   Record all three attempts separately; a failed attempt cannot be erased by a
   later pass.
4. `pnpm e2e:full` once after the three targeted passes.
5. `git diff --check` and an allowlist comparison over every changed path.

Each target run must launch a fresh harness and therefore own fresh user data,
Lody data, workspace, endpoint, processes, and artifacts. Reusing one live app
for three assertions does not satisfy the gate.

Classify a failed candidate as exactly one of:

- `product-defect`: the intended journey exposes incorrect product behavior;
- `test-capability`: the current selectors, fixture controls, or assertions
  cannot prove the outcome deterministically, including a passing ablation;
- `infra`: build, launch, runner, operating-system, or owned service failure.

Only `ready` with `failureClass: none` may be published. Every blocked candidate
retains its failure class and evidence without weakening the suite. A later run
may advance to another eligible registry row; one blocked row never stops the
whole queue.

The trusted publisher accepts only the checksummed author task, final candidate,
and validation attestation produced by the expected default-branch workflow run.
It never checks out or executes candidate code. Before creating a Draft PR it
revalidates provenance, base SHA, file paths, sizes, hashes, scenario id, and the
complete validation result. It never merges or promotes a candidate to P0.
