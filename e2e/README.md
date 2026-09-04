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

## Failure model

A failed scenario keeps the evidence described in [the artifact contract](./ARTIFACTS.md).
Evidence capture failures are appended to the scenario log and do not replace
the original product failure. Teardown failures do fail the scenario because a
surviving CLI or occupied endpoint invalidates the next result.

The current active coverage is tracked in [the coverage matrix](./COVERAGE.md).
The suite checker parses Gherkin and enforces IDs, priorities, runtime ownership,
documentation indexes, and P0 matrix entries before any application build.
