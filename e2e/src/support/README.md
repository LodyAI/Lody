# Harness map

| Component                                 | Responsibility                                                      |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `electron-harness.ts`                     | Isolated Electron/CLI process lifecycle, logs, traces, and teardown |
| `hooks.ts`                                | Scenario evidence retention policy                                  |
| `resource-probe.ts`                       | Structured main, renderer, DOM, CPU, and memory snapshots           |
| `world.ts`                                | Cucumber adapter for the shared harness                             |
| `world-utils.ts`                          | Stable artifact paths, port reservation, and cleanup assertions     |
| `fixtures/synthetic-review-repository.ts` | Deterministic large Git diff fixture                                |
| `pages/onboarding-page.ts`                | First-run user interaction and local bootstrap contract             |
| `pages/review-page.ts`                    | Review-panel project setup and observable diff interactions         |
| `pages/session-page.ts`                   | Deterministic ACP conversation and Stop lifecycle                   |
| `pages/work-session-page.ts`              | Worktree Session, terminal, deletion, and cleanup contract          |
| `fixtures/work-session-fixture.ts`        | Synthetic Git workspace and scripted ACP evidence                   |
