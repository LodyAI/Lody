# Lody desktop verification

This workspace verifies the OSS desktop as one product process tree: Electron
main, preload, renderer, IPC, and the bundled local CLI. It separates repeatable
regression, exploratory resource scouting, and human acceptance so a noisy soak
signal cannot make the merge gate untrustworthy.

| Lane             | Purpose                                            | Trigger                     | Decision owner          |
| ---------------- | -------------------------------------------------- | --------------------------- | ----------------------- |
| Regression smoke | Short `@P0` user journeys against the real desktop | Pull request critical paths | Automated, blocking     |
| Regression full  | `@P0` plus `@P1` user journeys                     | Label, schedule, or manual  | Automated, blocking     |
| Scout soak       | Repeated lifecycle and resource recovery analysis  | Nightly or manual           | Initially informational |
| Acceptance       | Immutable before/after evidence for a delivery     | Explicit local run          | Human reviewer          |

## Architecture

[`src/support/electron-harness.ts`](./src/support/electron-harness.ts) owns the
process boundary and isolation. Cucumber World adapts it to scenarios, Page
Objects own user interaction, and hooks own evidence retention. The harness
launches the built main entry directly with Playwright Electron; it does not
start a normal Chromium browser or an Electron Vite web server.

Each run uses fresh durable directories and a kernel-assigned loopback port.
The test-only port override is accepted only when `LODY_E2E=1`, so Electron and
its bundled CLI cannot attach to the normal local daemon. Teardown first asks
Electron to quit through its production shutdown barrier, then verifies the
port can be rebound before deleting temporary state.

## Commands

```bash
pnpm install
pnpm e2e:check
pnpm e2e:build
pnpm e2e:smoke
pnpm e2e:full
pnpm e2e:scout
pnpm e2e:scout -- --journey review --iterations 50
pnpm e2e:scout:ablation -- --iterations 12
pnpm e2e:acceptance -- --subject desktop-local-bootstrap
pnpm e2e:acceptance -- --subject desktop-session-lifecycle \
  --before before.json --after after.json --retained-path retained-path.txt
pnpm e2e:journey:author -- --prepare-only
pnpm e2e:journey:author
pnpm e2e:journey:validate -- --artifact-dir e2e/artifacts/journey-author/RUN \
  --approve-reviewed
pnpm --filter @lody/e2e journey:candidate -- --json
pnpm --filter @lody/e2e journey:coverage
```

`e2e:build` prepares the renderer and synchronized CLI once. The other commands
never rebuild, which keeps scenario timing about product behavior rather than
toolchain work. `e2e:acceptance` creates a unique round under
`e2e/artifacts/acceptance/`; it never overwrites an earlier round. Supported
subjects are `desktop-local-bootstrap`, `desktop-session-lifecycle`,
`desktop-review-lifecycle`, `desktop-work-lifecycle`, and `desktop-lifecycle`.
Optional before/after JSON and a retained-path summary are copied into the
round, then covered by its checksummed manifest.
Scout operation, classification, and triage are specified in
[the Scout contract](./SCOUT.md).

## Journey registry

[`journeys/registry.json`](./journeys/registry.json) owns both implemented
journeys and evidence-backed product gaps. `COVERAGE.md` is generated from the
registry, while the suite checker proves that every active row and executable
scenario agree on id, priority, runtime, and feature path in both directions.

Candidate selection is deterministic, removes semantic duplicates, skips rows
with a `blockedReason`, and emits at most one result with a complete score
breakdown. It accepts frozen discovery signals without changing the registry:

```bash
pnpm --filter @lody/e2e journey:candidate -- --changed-files changed.txt --json
pnpm --filter @lody/e2e journey:candidate -- --escaped-defects escaped-ids.txt --json
pnpm --filter @lody/e2e journey:candidate -- --scout-summary artifacts/scout/ROUND/summary.json --json
```

Changed files and escaped-defect inputs are newline-delimited. Scout input uses
the existing `summary.json` schema. These signals only rank registered gaps;
they never generate selectors, shell commands, or executable product code.

The local Journey Foundry takes one eligible backlog row at a time under the
[restricted authoring contract](./journeys/AUTHORING.md). It requires a clean
maintainer checkout, Node.js 22+, the pinned pnpm, macOS desktop prerequisites,
and an authenticated Codex CLI. `codex login` may use the maintainer's ChatGPT
account; GitHub receives neither that login nor an API key.

The author command creates an ephemeral detached worktree and invokes Codex
there with a restricted environment, ignored user configuration, an ephemeral
session, and the `workspace-write` sandbox. Trusted local code packages the
allowlisted files into `candidate.patch` plus a readable `review/` tree. It does
not execute or apply generated code. Evidence remains under the ignored
`e2e/artifacts/journey-author/` directory.

After reviewing every generated file, the maintainer runs the validation
command with `--approve-reviewed`. A second ephemeral worktree with a temporary
home receives the candidate, promotes the matching registry row, rejects a
bounded counterfactual, restores exact file hashes, runs three fresh focused
rounds, and runs the full suite. Failure removes that worktree and leaves the
maintainer checkout clean. Success applies the frozen validated patch only when
the checkout is still clean and at the candidate's exact base commit.

`--prepare-only` records the selected task without invoking Codex or changing
the checkout. Neither local command commits, pushes, opens a PR, or merges. The
maintainer publishes the validated patch through the normal contribution flow,
where existing PR checks rerun the deterministic suite. A blocked result
remains local evidence and the next run can skip that id with
`--excluded <path>`.

## Failure model

A failed scenario keeps the evidence described in [the artifact contract](./ARTIFACTS.md).
Evidence capture failures are appended to the scenario log and do not replace
the original product failure. Teardown failures do fail the scenario because a
surviving CLI or occupied endpoint invalidates the next result.

Daily regression additionally records each scenario and retains only failed
WebMs. Its read-only runner uploads the complete artifact; a trusted
default-branch reconciler creates or reopens one Daily failure Issue and appends
every validated recording as its own independently retryable inline player. A
later successful full Daily closes the Issue with the recovery run link; a
successful manually dispatched smoke run cannot clear full-suite failure state.
Pull-request failures follow the same evidence validation in a trusted
default-branch reconciler. It skips stale heads and appends each failed journey
as an independently retryable inline video comment on the matching open PR.

The current active coverage is tracked in [the coverage matrix](./COVERAGE.md).
The suite checker parses Gherkin and enforces IDs, priorities, runtime ownership,
documentation indexes, and P0 matrix entries before any application build.
