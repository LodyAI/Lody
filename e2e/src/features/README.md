# Feature index

The active suite contains 17 scenarios: 5 `@P0` smoke journeys and 12 `@P1` deeper journeys.

| Feature                       | Scope                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `onboarding.feature`          | Real Electron cold start, bundled CLI bootstrap, local catalog, and product entry |
| `lifecycle.feature`           | Session Stop, large Review, and Work/Terminal cleanup against a scripted ACP      |
| `agent-role.feature`          | Agent Role creation, accepted execution freeze, later edits, and cleanup          |
| `desktop-windows.feature`     | Auxiliary Workspace readiness and per-renderer persistent sync-cache isolation    |
| `mcp-catalog-editing.feature` | MCP catalog field and enabled-state persistence through edit and deletion         |
| `mcp-catalog.feature`         | Workspace MCP creation, explicit Turn selection, dispatch, and deletion           |
| `project-lifecycle.feature`   | Local project add, selection, removal, and original-directory safety              |
| `project-reopen.feature`      | Cross-surface project switching and duplicate-folder identity preservation        |
| `session-queue.feature`       | Queued follow-up removal and ordered dispatch through a scripted ACP              |
| `session-management.feature`  | Session metadata plus containment/provenance archive and deletion isolation       |
| `session-read-state.feature`  | Session unread marking, navigation-based read clearing, and permanent deletion    |
| `session-fork.feature`        | Completed Session fork, origin, independent worktree, and deletion isolation      |
| `settings-appearance.feature` | Theme commit, preview isolation, cancellation, and settings-reopen persistence    |
| `shortcuts.feature`           | Default bindings, cross-window rebinding, physical keys, and renderer reload      |
