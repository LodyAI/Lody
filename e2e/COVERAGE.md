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

| Stable id          | Journey                                                                             | Renderer                                                    | Electron / IPC                               | Bundled CLI                           | Durable state                               | External wire                        |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------ |
| `LODY-FORK-001`    | Fork a completed Session into an independent worktree Session                       | Session fork destination and origin                         | Real window and Session RPC                  | Fork operation and recovery markers   | Independent Session history and worktree    | Scripted ACP                         |
| `LODY-MCP-001`     | Create a workspace MCP server and preserve explicit turn selection through dispatch | MCP settings and composer selection                         | Real window and workspace RPC                | Catalog persistence and ACP dispatch  | Workspace catalog plus turn input selection | Synthetic stdio MCP and scripted ACP |
| `LODY-PROJECT-001` | Add, select, and remove a local project without deleting its directory              | Project picker, sidebar selection, and removal confirmation | Real window and local project control bridge | Project catalog add, list, and delete | Workspace project catalog lifecycle         | None                                 |
| `LODY-REVIEW-001`  | Open, hide, and switch a synthetic large diff                                       | Large diff Review lifecycle                                 | Real window and diff RPC                     | Real owned runtime                    | Synthetic project and Session lifecycle     | Scripted ACP                         |
| `LODY-ROLE-001`    | Create an Agent Role and freeze its execution target into a Session                 | Agent Role settings and composer selection                  | Real window and workspace RPC                | Frozen dispatch configuration         | Role catalog plus Session provenance        | Scripted ACP                         |
| `LODY-SESSION-002` | Rename, pin, archive, and restore a local Session                                   | Session metadata and Archive UI                             | Real window and Session RPC                  | Real owned runtime                    | Title, pin, archive, and restore            | None                                 |

## Evidence-backed backlog

| Stable id | Priority | Owner | Freshness | Proposed journey | Estimated minutes | Status | Gap |
| --------- | -------- | ----- | --------: | ---------------- | ----------------: | ------ | --- |

Candidate selection is deterministic and returns at most one backlog row per run.
Scout may provide evidence for a narrow candidate, but it does not maintain a second journey implementation.
