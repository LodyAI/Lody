# Desktop journey coverage

The matrix records product boundaries exercised by active scenarios. It is not
a count of component tests or a promise that unlisted journeys are implemented.

## P0 state-fusion matrix

| Stable id             | Renderer              | Electron / IPC                 | Bundled CLI        | Durable state                                   | External wire |
| --------------------- | --------------------- | ------------------------------ | ------------------ | ----------------------------------------------- | ------------- |
| `LODY-ONBOARDING-001` | Intro and local entry | Real window and invoke bridge  | Real owned runtime | Isolated workspace catalog and onboarding state | None          |
| `LODY-SESSION-001`    | Session lifecycle     | Real window and invoke bridge  | Real owned runtime | Create, stop, archive, and permanent delete     | Scripted ACP  |
| `LODY-WORK-001`       | Work lifecycle        | Real window, IPC, and Terminal | Real owned runtime | Session, worktree, and terminal cleanup         | Scripted ACP  |

## P1 lifecycle matrix

| Stable id         | Journey                                       | Deterministic boundary                  |
| ----------------- | --------------------------------------------- | --------------------------------------- |
| `LODY-REVIEW-001` | Open, hide, and switch a synthetic large diff | Seeded Git repository and real diff RPC |

Scout repeats these Page Object journeys; it does not maintain a second
implementation of the workflow.
