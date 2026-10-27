---
name: lody-automations
description: Register a background condition that resumes this Session when ready, inspect or cancel waits, and configure quota recovery, idle compaction or archive after merge.
---

# Lody Automations

Use `lody_automation` for future behavior the user requested. A registration belongs
to this Session: Lody checks its JavaScript after the Agent finishes and queues the
result back into this same conversation. Registration returns immediately.

## Choose the operation

| Need                                                                   | Read next                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Wait for data to satisfy a custom condition                            | [Context](references/context.md), then the relevant data reference |
| Recover after quota limits, compact while idle, or archive after merge | [Session settings](references/settings.md); no condition JS needed |
| Inspect, cancel, or diagnose existing work                             | The inspection section below                                       |
| Exact command fields, defaults and limits                              | `references/commands.schema.json`, generated from the running API  |

Load only the references needed for the task, relative to this skill's directory.
The skill manifest includes schema files and examples; read those resources only
when their detail is needed.

## Register a condition

Call `lody_automation` with this argument shape:

```json
{
  "command": {
    "type": "register",
    "reason": "Wait for related work to finish",
    "program": "async ({ ctx }) => { const { value: group } = await ctx.read('session.group'); if (group.value !== 'yes') return false; return { resumeText: 'Related work is complete. Continue summarizing the results.' }; }"
  }
}
```

The program is a function expression, without imports or exports. Return `false`
to keep waiting, or `{resumeText, payload?}` to finish. `true`, an absent return,
and empty resume text are invalid. Await every read. Each check starts with fresh
local variables; do not write a polling loop or rely on a previous check's variables.

Use the returned ID to identify this wait. Matching active registrations deduplicate;
check `list` after an uncertain registration response before changing the request.
Once registered, finish the current turn when its other work is done. Do not poll
the automation from the Agent: the daemon owns subsequent checks and delivery.

Each wait completes once. A condition already satisfied at registration can match
immediately. Register again for a later cycle only when the user's task requires it.
Busy Sessions queue continuation; automation does not clear a user's Stop.

## Inspect or cancel

All calls use `lody_automation({command: ...})`:

| Command                               | Result/use                                                          |
| ------------------------------------- | ------------------------------------------------------------------- |
| `{ "type": "list" }`                  | This Session's JS waits                                             |
| `{ "type": "show", "id": "WAIT_ID" }` | Check state, last error, next check and continuation                |
| `{ "type": "cancel", "id": "ID" }`    | Cancel a wait or an activity, including its pending continuation    |
| `{ "type": "activities" }`            | Delivery, recovery and maintenance activity, with pagination cursor |
| `{ "type": "settings" }`              | Current Session feature settings                                    |

`matched` means the condition finished, not that the Agent finished the resumed work.
Inspect `continuation.state` for delivery. `failed` after repeated check errors needs
diagnosis; `expired` means the wait reached its deadline. Cancellation does not undo
completed work. The daemon must be running to check or deliver; persisted waits
resume after daemon restart.
