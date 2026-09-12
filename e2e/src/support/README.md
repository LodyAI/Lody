# Harness map

| Component                                            | Responsibility                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `electron-harness.ts`                                | Isolated Electron/CLI process lifecycle, logs, traces, and teardown       |
| `hooks.ts`                                           | Scenario evidence retention policy                                        |
| `resource-probe.ts`                                  | Structured main, renderer, DOM, CPU, and memory snapshots                 |
| `world.ts`                                           | Cucumber adapter for the shared harness                                   |
| `world-utils.ts`                                     | Stable artifact paths, port reservation, and cleanup assertions           |
| `fixtures/synthetic-review-repository.ts`            | Deterministic large Git diff fixture                                      |
| `pages/onboarding-page.ts`                           | First-run user interaction and local bootstrap contract                   |
| `pages/review-page.ts`                               | Review-panel project setup and observable diff interactions               |
| `pages/session-page.ts`                              | Deterministic ACP conversation and Stop lifecycle                         |
| `pages/work-session-page.ts`                         | Worktree Session, terminal, deletion, and cleanup contract                |
| `pages/agent-role-page.ts`                           | Agent Role settings, accepted invocation evidence, and cleanup            |
| `pages/agent-provider-lifecycle-page.ts`             | Invalid draft, rollback, two-Provider dispatch, reload, and deletion      |
| `pages/context-copy-page.ts`                         | User/assistant prefixes, streaming/cancel export, reload, and isolation   |
| `pages/mcp-catalog-editing-page.ts`                  | MCP catalog editing, state toggles, reopen checks, and deletion           |
| `pages/mcp-catalog-page.ts`                          | MCP settings, Turn selection, ACP startup, and cleanup                    |
| `pages/project-lifecycle-page.ts`                    | Local project picker, sidebar, catalog, and removal lifecycle             |
| `pages/project-reopen-page.ts`                       | Two-project switching and duplicate catalog identity checks               |
| `pages/session-queue-page.ts`                        | Queued follow-up removal and ordered ACP dispatch evidence                |
| `pages/session-management-page.ts`                   | Session metadata, Archive restore, history, and deletion                  |
| `pages/session-relation-lifecycle-page.ts`           | Containment deletion, provenance, worktree, and hydration isolation       |
| `pages/session-read-state-page.ts`                   | Unread state, sidebar navigation, and two-Session cleanup                 |
| `pages/session-fork-page.ts`                         | Native ACP fork, origin, worktree, and source isolation                   |
| `pages/session-goal-page.ts`                         | Goal state machine, Session isolation, reload, Archive, and wire evidence |
| `pages/settings-appearance-page.ts`                  | Theme commit, live preview, cancellation, and persisted state             |
| `pages/shortcut-page.ts`                             | Default shortcuts, cross-window rebinding, and renderer reload            |
| `pages/sidebar-search-page.ts`                       | Query variants, rename reindexing, reload, Archive, and cleanup           |
| `pages/text-attachment-page.ts`                      | Picker cancel, multi-turn history, reload, Archive, and isolation         |
| `fixtures/work-session-fixture.ts`                   | Synthetic Git workspace and scripted ACP evidence                         |
| `fixtures/agent-role-fixture.ts`                     | File-signaled scripted ACP and Role execution evidence                    |
| `fixtures/agent-provider-lifecycle-fixture.ts`       | Invalid command plus two Provider variants and ACP dispatch evidence      |
| `fixtures/agent-provider-lifecycle-scripted-acp.mjs` | Deterministic edited and alternate Agent Provider runtime                 |
| `fixtures/context-copy-fixture.ts`                   | Rich Markdown, explicit stream release, and two-Session boundaries        |
| `fixtures/context-copy-scripted-acp.mjs`             | Deterministic completed, released, and cancelled context-copy turns       |
| `fixtures/mcp-catalog-editing-fixture.ts`            | Synthetic editable MCP catalog values                                     |
| `fixtures/mcp-catalog-fixture.ts`                    | ACP and stdio MCP process evidence                                        |
| `fixtures/project-reopen-fixture.ts`                 | Two isolated Git repositories for duplicate and switching checks          |
| `fixtures/session-management-fixture.ts`             | UI-created Session identity and deterministic ACP command                 |
| `fixtures/session-relation-lifecycle-fixture.ts`     | Synthetic containment, provenance, and cold-cache metadata                |
| `fixtures/session-read-state-fixture.ts`             | Two UI-created Session identities and deterministic ACP command           |
| `fixtures/session-queue-fixture.ts`                  | File-signaled queue ACP event and release evidence                        |
| `fixtures/session-queue-scripted-acp.mjs`            | Deterministic held and completed queue turns                              |
| `fixtures/session-fork-fixture.ts`                   | Synthetic Git repository and shared fork-process evidence                 |
| `fixtures/session-fork-acp.mjs`                      | Fork-capable deterministic ACP provider                                   |
| `fixtures/session-goal-fixture.ts`                   | Two-Session goal capability, controls, prompt metadata, and snapshots     |
| `fixtures/session-goal-scripted-acp.mjs`             | Deterministic goal state machine and Session-isolated ACP evidence        |
| `fixtures/sidebar-search-fixture.ts`                 | Three named UI-created Session identities and scripted ACP command        |
| `fixtures/text-attachment-fixture.ts`                | Two Session identities, local text path, and scripted ACP command         |
| `fixtures/synthetic-text-attachment.txt`             | Synthetic local text attachment payload                                   |

The harness passes only an explicit environment allowlist into Electron. Linux
runs under `xvfb-run`, so both its `DISPLAY` endpoint and generated `XAUTHORITY`
file must cross that isolation boundary.
