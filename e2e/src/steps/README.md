# Step index

| Step file                     | Responsibility                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `onboarding.steps.ts`         | Maps the first-run feature to the onboarding Page Object and runtime assertions |
| `lifecycle.steps.ts`          | Drives deterministic Session, Review, and Work resource lifecycles              |
| `agent-role.steps.ts`         | Creates a Role and proves accepted Session execution remains frozen             |
| `mcp-catalog.steps.ts`        | Carries an explicit MCP selection through catalog, composer, and dispatch       |
| `project-lifecycle.steps.ts`  | Adds, selects, removes, and verifies a synthetic local project                  |
| `session-management.steps.ts` | Exercises metadata, Archive restore, history, and deletion                      |
| `session-fork.steps.ts`       | Forks a completed Session to a worktree and verifies origin and cleanup         |
| `shortcuts.steps.ts`          | Verifies default shortcuts, cross-window rebinding, and renderer reload         |
