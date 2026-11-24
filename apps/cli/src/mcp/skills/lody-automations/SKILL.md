---
name: lody-automations
description: Run a command beyond the current turn and resume when it exits, register a background condition that resumes this Session when ready, inspect or cancel waits, and configure quota recovery, idle compaction, archive after merge or Auto delivery of the current pull request.
---

# Lody Automations

Use `lody_automation` for commands that must continue after the current turn ends and resume the Session on exit, or for future behavior the user requested. Ordinary commands, builds and tests stay in the current turn; duration alone is not a reason to use Automation. A registration defaults to this Session. Pass `sessionId` to target another owned Session on the same machine; Lody checks the condition and queues the result in that target conversation. Registration returns immediately.

## Choose the operation

| Need                                                                   | Read next                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Continue a command after this turn ends and resume on exit             | The run section below                                              |
| Wait for data to satisfy a custom condition                            | [Context](references/context.md), then the relevant data reference |
| Recover after quota limits, compact while idle, or archive after merge | [Session settings](references/settings.md); no condition JS needed |
| Hand the current PR's CI fixes, conflicts or merge to Lody             | [Session settings](references/settings.md), Auto delivery          |
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

## Run beyond the current turn

Use `run` only when work must outlive the current turn and its completion needs
to resume the Session. An idle Session may be reclaimed, which ends background
processes the Agent started. Lody owns a `run` process instead: it keeps running, and its exit queues
one continuation in this Session with the exit code or signal, duration, log path
and the last 4 KiB of output.

```json
{ "command": { "type": "run", "command": "pnpm", "args": ["test"], "reason": "Full test suite" } }
```

The command runs without a shell in the Session workdir, or in `cwd` relative to
it. It receives `PATH`, home and temp variables plus any `env` you pass; do not pass
secrets. The full output is in the returned `run.logPath` (16 MiB limit). An
identical unfinished run returns the existing registration. `cancel` with the
returned ID terminates the process. If Lody restarts first, the continuation reports
the run as interrupted; Lody never starts it again.

## Inspect or cancel

All calls use `lody_automation({command: ...})`:

| Command                               | Result/use                                                          |
| ------------------------------------- | ------------------------------------------------------------------- |
| `{ "type": "list" }`                  | This Session's condition waits and runs                             |
| `{ "type": "show", "id": "WAIT_ID" }` | Check state, last error, next check and continuation                |
| `{ "type": "cancel", "id": "ID" }`    | Cancel a wait or an activity, including its pending continuation    |
| `{ "type": "activities" }`            | Delivery, recovery and maintenance activity, with pagination cursor |
| `{ "type": "settings" }`              | Current Session feature settings                                    |

`matched` means the condition finished, not that the Agent finished the resumed work.
Inspect `continuation.state` for delivery. `failed` after repeated check errors needs
diagnosis; `expired` means the wait reached its deadline. Cancellation does not undo
completed work. The daemon must be running to check or deliver; persisted waits
resume after daemon restart.
