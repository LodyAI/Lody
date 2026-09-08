# Desktop journey coverage

This file is generated from [`journeys/registry.json`](./journeys/registry.json).
Run `pnpm --filter @lody/e2e journey:coverage` after changing the registry.

The active matrix records product boundaries exercised by implemented scenarios.
Backlog rows are evidence-backed gaps, not executable or promised scenarios.

## Active P0 journeys

| Stable id             | Journey                                                             | Renderer              | Electron / IPC                 | Bundled CLI        | Durable state                                   | External wire |
| --------------------- | ------------------------------------------------------------------- | --------------------- | ------------------------------ | ------------------ | ----------------------------------------------- | ------------- |
| `LODY-ONBOARDING-001` | New user enters an isolated local workspace through the bundled CLI | Intro and local entry | Real window and invoke bridge  | Real owned runtime | Isolated workspace catalog and onboarding state | None          |
| `LODY-SESSION-001`    | Stop and permanently delete a running ACP Session                   | Session lifecycle     | Real window and invoke bridge  | Real owned runtime | Create, stop, archive, and permanent delete     | Scripted ACP  |
| `LODY-WORK-001`       | Delete a worktree Session with ACP and Terminal resources           | Work lifecycle        | Real window, IPC, and Terminal | Real owned runtime | Session, worktree, and terminal cleanup         | Scripted ACP  |

## Active P1 journeys

| Stable id         | Journey                                       | Renderer                    | Electron / IPC           | Bundled CLI        | Durable state                           | External wire |
| ----------------- | --------------------------------------------- | --------------------------- | ------------------------ | ------------------ | --------------------------------------- | ------------- |
| `LODY-REVIEW-001` | Open, hide, and switch a synthetic large diff | Large diff Review lifecycle | Real window and diff RPC | Real owned runtime | Synthetic project and Session lifecycle | Scripted ACP  |

## Evidence-backed backlog

| Stable id          | Priority | Owner             | Freshness | Proposed journey                                                                    | Estimated minutes | Status                                                                                                               | Gap                                                                                                                                           |
| ------------------ | -------- | ----------------- | --------: | ----------------------------------------------------------------------------------- | ----------------: | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `LODY-FORK-001`    | P1       | session-lifecycle |       4/5 | Fork a completed Session into an independent worktree Session                       |                 8 | Eligible                                                                                                             | Fork durability and compensation have Node coverage but no real desktop journey across renderer, IPC, CLI, Git, and persisted history.        |
| `LODY-MCP-001`     | P1       | workspace-catalog |       4/5 | Create a workspace MCP server and preserve explicit turn selection through dispatch |                 6 | Eligible                                                                                                             | No desktop journey proves that an explicit MCP selection survives the renderer, IPC, durable turn input, and bundled CLI dispatch boundaries. |
| `LODY-ROLE-001`    | P1       | workspace-catalog |       4/5 | Create an Agent Role and freeze its execution target into a Session                 |                 7 | Blocked: A deterministic Agent Role revision fixture and stable Settings Page Object actions are not registered yet. | No desktop journey spans Agent Role creation, composer selection, accepted-operation freezing, and Session provenance.                        |
| `LODY-SESSION-002` | P1       | session-lifecycle |       3/5 | Rename, pin, archive, and restore a local Session                                   |                 4 | Eligible                                                                                                             | The current lifecycle deletes an archived Session but never verifies common metadata edits or restoration from Archive.                       |

Candidate selection is deterministic and returns at most one backlog row per run.
Scout may provide evidence for a narrow candidate, but it does not maintain a second journey implementation.
