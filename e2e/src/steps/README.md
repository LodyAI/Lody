# Step index

| Step file                            | Responsibility                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `onboarding.steps.ts`                | Maps the first-run feature to the onboarding Page Object and runtime assertions                  |
| `lifecycle.steps.ts`                 | Drives deterministic Session, Review, and Work resource lifecycles                               |
| `agent-role.steps.ts`                | Creates a Role and proves accepted Session execution remains frozen                              |
| `agent-provider-lifecycle.steps.ts`  | Rejects invalid drafts and drives two Providers through rollback, revisit, dispatch, and cleanup |
| `conversation-context-copy.steps.ts` | Drives user/assistant prefixes, user-stopped streaming, completed follow-up, and isolation       |
| `desktop-windows.steps.ts`           | Verifies auxiliary Workspace connection and persistent cache namespace isolation                 |
| `mcp-catalog-editing.steps.ts`       | Exercises MCP catalog edits, enabled-state persistence, and deletion                             |
| `mcp-catalog.steps.ts`               | Carries an explicit MCP selection through catalog, composer, and dispatch                        |
| `project-lifecycle.steps.ts`         | Adds, selects, removes, and verifies a synthetic local project                                   |
| `project-reopen.steps.ts`            | Switches between two projects and rejects a duplicate folder registration                        |
| `session-queue.steps.ts`             | Removes one queued follow-up and proves only the retained message dispatches                     |
| `session-management.steps.ts`        | Exercises metadata, Archive restore, history, and deletion                                       |
| `session-read-state.steps.ts`        | Exercises unread marking, navigation-based clearing, and UI cleanup                              |
| `session-fork.steps.ts`              | Forks a completed Session to a worktree and verifies origin and cleanup                          |
| `session-goal.steps.ts`              | Drives isolated goal update, Pause, Resume, Clear, UI revisit, Archive, and cleanup              |
| `settings-appearance.steps.ts`       | Commits, previews, cancels, and reopens a desktop theme selection                                |
| `shortcuts.steps.ts`                 | Verifies default shortcuts, cross-window rebinding, and renderer reload                          |
| `sidebar-search.steps.ts`            | Drives three Sessions through query variants, rename, UI revisit, Archive, and cleanup           |
| `text-attachment.steps.ts`           | Drives picker cancel, attachment and plain turns, UI revisit, isolation, and cleanup             |
