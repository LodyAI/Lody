# Feature index

The active suite contains 21 scenarios: 4 `@P0` smoke journeys and 17 `@P1` deeper journeys.

| Feature                             | Scope                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `onboarding.feature`                | Real Electron cold start, bundled CLI bootstrap, local catalog, and product entry    |
| `lifecycle.feature`                 | Session Stop, large Review, and Work/Terminal cleanup against a scripted ACP         |
| `agent-role.feature`                | Agent Role creation, accepted execution freeze, later edits, and cleanup             |
| `agent-provider-lifecycle.feature`  | Invalid draft, edit rollback, dual-Provider dispatch, Settings revisit, and deletion |
| `conversation-context-copy.feature` | User/assistant prefixes, streaming export, Stop, UI revisit, and Session isolation   |
| `mcp-catalog-editing.feature`       | MCP catalog field and enabled-state persistence through edit and deletion            |
| `mcp-catalog.feature`               | Workspace MCP creation, explicit Turn selection, dispatch, and deletion              |
| `project-lifecycle.feature`         | Local project add, selection, removal, and original-directory safety                 |
| `project-reopen.feature`            | Cross-surface project switching and duplicate-folder identity preservation           |
| `session-queue.feature`             | Queued follow-up removal and ordered dispatch through a scripted ACP                 |
| `session-management.feature`        | Session metadata plus containment/provenance archive and deletion isolation          |
| `session-read-state.feature`        | Session unread marking, navigation-based read clearing, and permanent deletion       |
| `session-fork.feature`              | Completed Session fork, origin, independent worktree, and deletion isolation         |
| `session-goal.feature`              | Goal capability, Session isolation, update, Pause/Resume/Clear, revisit, and Archive |
| `settings-appearance.feature`       | Theme commit, preview isolation, cancellation, and settings-reopen persistence       |
| `shortcuts.feature`                 | Default bindings, cross-window rebinding, physical keys, and renderer reload         |
| `sidebar-search.feature`            | Three-Session queries, rename reindexing, UI revisit, Archive, and deletion          |
| `text-attachment.feature`           | Picker cancel, multi-turn history, UI revisit, Archive, and Session isolation        |
