# Lody Automations

A Session registers a condition in CodeMode’s supported JavaScript subset. The local Host rechecks it after the
Agent exits and across daemon restarts. `false` keeps waiting;
`{ resumeText, payload? }` completes the wait and queues one continuation in the
registering Session. Workspace identifies the daemon/storage owner; it does not
replace the Session as the continuation target.

| Boundary            | Owner                                                                                                                                               | Responsibility                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Public API          | [condition contracts](../../../../packages/shared/src/automations/conditions.ts), [control](../../../../packages/shared/src/automations/control.ts) | Registration, result, inspection, cancellation and Session feature settings                   |
| Agent guidance      | [MCP skill](../mcp/skills/lody-automations/SKILL.md)                                                                                                | Progressive workflow, data references, runnable example and generated API schemas             |
| Persistence         | [ledger](storage/ledger.ts)                                                                                                                         | Waits, results, fixed continuation identities, source observations and native unfinished work |
| Scheduling          | [runtime](runtime/engine.ts)                                                                                                                        | Reevaluation, expiry, submission fencing, reconciliation and cancellation                     |
| JavaScript          | [programs](programs/codemode.ts)                                                                                                                     | CodeMode interpreter and scoped read capability                                              |
| Product policy      | [Session policies](policies/session.ts)                                                                                                             | Fixed merge/archive, quota/recovery and idle/compact behavior                                 |
| Resource effects    | [Session adapter](actions/session-actions-legacy.ts)                                                                                                | Existing queue, permissions, native continuation and compaction                               |
| Composition         | [workspace](workspace-legacy.ts)                                                                                                                    | Fleet lifetime, local control and existing source owners                                      |
| Execution authority | [Session authority](../session/session-automation-authority.ts)                                                                                     | Admission barriers, release proof, group settlement and exact-input cancellation              |

Automations currently run in plaintext workspaces. Encrypted workspaces remain unsupported
under the shared workspace content policy; Fleet creates no automation runtime there.

## Register a condition

The bundled [Automations skill](../mcp/skills/lody-automations/SKILL.md) documents
`lody_automation`, `ctx` resources and Session settings. The MCP server publishes it
at `skill://lody-automations/SKILL.md`. The Agent's MCP host owns discovery and activation; see [the delivery path](../mcp/README.md#skills-over-mcp).

```js
async ({ ctx }) => {
  const { value } = await ctx.read('github.workflowRuns');
  if (value.status !== 'observed') return false;
  const failed = value.pullRequests.flatMap((pr) =>
    pr.runs.filter((run) => run.status === 'completed' && run.conclusion === 'failure')
  );
  if (!failed.length) return false;
  return { resumeText: 'CI failed; inspect the result and continue fixing.', payload: failed };
};
```

Save the function as `condition.js`, then register it:

```sh
lody automation register --file condition.js --reason 'Waiting for the result'
lody automation list
lody automation show AUTOMATION_ID
lody automation cancel AUTOMATION_ID
```

Managed sessions supply `LODY_SESSION_ID` and `LODY_WORKSPACE_ID`. Outside a Session,
pass `--session SESSION_ID --workspace WORKSPACE_ID`. MCP `lody_automation` accepts
`{command: {type: "register", program: "async ({ctx}) => ..."}}` and binds the
current Session automatically. Its caller cannot redirect the result to another
Session. CLI and MCP share the same local control endpoint. The Electron Session
UI uses that endpoint for local-machine waits and settings, and the remote machine
control bridge for eligible remote Sessions. Encrypted workspaces and Web remain unsupported.
The [general availability decision](../../../../.agents/notes/implemented/feature/2026-10-30-session-continuation-general-availability.md) explains the UI gate removal; the [UI design](../../../../.agents/notes/proposed/feature/2026-10-27-session-continuation-note-ui.md) records its presentation trade-offs.

Optional `reason`, `intervalMs` (default 30 seconds, minimum 1 second) and
`expiresAt` (absolute epoch milliseconds) describe the wait. CLI exposes
`--interval` and `--expires-at` (ISO time or epoch milliseconds). Checks begin at
registration; already-ready conditions do not require a later source transition.
Intervals are minimum delays after a check, subject to bounded concurrency and Host
availability. Expired waits cannot create a continuation. Matching active
registrations in the same Session deduplicate; a terminal wait may be registered again.

Each evaluation receives `{ctx}` with `sessionId`, `workspaceId`, `now` and
`read(resource, parameters?)`. Reads return `{value, observedAt}`; the Host checks
Session ownership and active registration for every call. CodeMode combines these
observations into predicates using its supported JavaScript subset. Resources describe available data, not a
catalog of business conditions.

| Resource              | Observation                                                                         |
| --------------------- | ----------------------------------------------------------------------------------- |
| `session`             | Bound Session's input identifiers and stopped/archived flags                        |
| `session.group`       | Authoritative group settlement (`yes`, `no` or `unknown`), excluding this wait      |
| `github.pullRequests` | Associated PR lifecycle and timestamped poll observations                           |
| `github.workflowRuns` | Current PR HEAD's trusted Run/Attempt observations, or `status: "unknown"`          |
| `provider.capacity`   | Current binding's sanitized quota windows and eligibility; no active provider query |
| `events`              | Bound Session's persisted facts; optional `since` timestamp and `limit` (1–100)     |

All other resources/parameters are rejected. A new resource adapter belongs beside
its existing owner and must define its scope, freshness and admission evidence.
Programs cannot select another Session or access Node, shell, filesystem, arbitrary
network endpoints or the daemon environment. Credentials stay with existing source
owners. The [external checks proposal](../../../../.agents/notes/proposed/architecture/2026-10-28-automation-external-checks.md) explores broader host capabilities, and the [interpreter decision](../../../../.agents/notes/proposed/architecture/2026-10-28-codemode-automation-interpreter.md) records the CodeMode trade-offs. Await every read. See [CI](examples/wait-for-ci.js) and
[event composition](examples/wait-for-event.js); an event example requires an
installed source that publishes that fact.

Each check has a 30-second deadline, at most 32 reads, four concurrent read calls
and a 128-KiB bound per observation. Cancellation interrupts the interpreter and
joins in-flight owner reads. Five consecutive check errors
end the wait as `failed`; successful checks reset the error count. `show` retains
the error, check count, next check time and continuation state. Host restart retries
interrupted checks. Checks are read-only and may repeat.

CI reads request observations through the existing PR poller, using its credential,
quota and cooldown owners. Active demand shortens the observation interval under
existing attempt floors and fairness gates. Only the current associated PR per repository is used;
queries filter by HEAD. Fork/missing/stale or truncated evidence remains unknown.
Run attempt and source revision are captured by the Host, separately from the
program's result. Accepted continuations keep observation demand alive. A changed
HEAD or rerun supersedes old evidence; dispatch checks it again, and CI continuations also verify the referenced checkouts immediately before the native
prompt, resolving Project members through their existing scoped worktree paths.

## Completion and cancellation

The Host commits the matched result, captured evidence and stable continuation identity atomically.
The matched result is final: its JS program does not run again. The original result
is delivered after current source, permission and Session admission checks pass. The [match decision](../../../../.agents/notes/implemented/bug-fix/2026-10-30-automation-match-is-final.md) explains why a committed event is not reevaluated.
JavaScript cannot choose actions, grants, targets or dispatch policies. Resume text
becomes the Session input; optional JSON payload is included as reference data.
Existing Session/Inbox owners retain queueing, transport, permissions and Stop.
Busy sessions enqueue the result. Unavailable or stopped targets remain inspectably
blocked; automation never clears Stop or silently creates a replacement Session.
Stop leaves authorized condition checks active. A match retains its original
continuation as `blocked` with reason `target_stopped`, without increasing the
condition error count. The local note offers explicit restoration through the
existing collaboration control; admission then rechecks permissions, the Session and
captured source evidence before submitting the same continuation. Cancel revokes that intent. The [Stop and observation decision](../../../../.agents/notes/implemented/bug-fix/2026-10-30-automation-pending-observations-and-stop.md) explains this admission boundary.

A lost submission acknowledgement triggers reconciliation of the same turn, not
another prompt. `matched` means the condition finished; the nested `continuation`
reports whether delivery is queued, running, blocked or settled. Cancel first
revokes future admission, interrupts an active check and joins cleanup. If a result
already created work, it cancels that exact input through its owner. Completed work
is not undone. `activities --limit 50` also exposes native maintenance/recovery
receipts; pass the returned `nextCursor` as JSON to `--before` for the next page.
Private launch snapshots and credential-derived fingerprints stay in local storage.

## Built-in Session behavior

`lody automation configure --file settings.json` changes ordinary Session settings;
`settings` reads them. All features default off. Event-to-action mapping is native
Lody code and is not a caller-authored rule graph.

```json
{
  "recoverCapacity": true,
  "archiveAfterMerge": true,
  "compactWhenIdle": {
    "contextTokens": 300000,
    "cacheTtlMs": 600000,
    "leadTimeMs": 60000
  }
}
```

Settings apply to future observations. Enabling capacity recovery also admits the current Session’s confirmed, still-current capacity failure when its work was recorded before the setting was enabled. Set a boolean feature or `compactWhenIdle`
to `false` to prevent new submissions. Use `cancel` for an already accepted input.

- **Capacity recovery:** structured quota or Codex model-overload failure, the original native conversation,
  launch binding, input and tool boundary are retained before execution release.
  All reported quota windows participate. A reset estimate only schedules a recheck;
  missing or stale evidence never becomes an availability fact. Enabling recovery
  permits bounded normal continuation attempts after the retry time when readonly
  confirmation is unavailable. Confirmed exhaustion still blocks them. Unconfirmed
  release or tool effects block recovery; new input supersedes older recovery work.
  Model overload uses up to three retries with increasing minimum delays of 5, 10,
  and 20 seconds; the Host persists the work and applies the same admission checks.
  New Claude scheduled continuations identify the failed Turn and share Session
  admission with this policy. Unassociated unprepared old shortcuts are skipped;
  prepared or dispatched legacy work retains its Schedule owner. The [overload design](../../../../.agents/notes/proposed/feature/2026-10-27-codex-overload-automation.md) and [legacy overlap analysis](../../../../.agents/notes/proposed/bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.md) record recovery trade-offs. The Claude failure banner enables this Session policy rather than creating a Schedule; the [shortcut history](../../../../.agents/notes/implemented/feature/2026-10-30-restore-quota-continue-shortcut.md) records the earlier decision.
- **Merge archive:** the existing PR poller records transitions and durable merged
  evidence. Archive waits for the entire Session group, including children, queues,
  Goals and native/automation work, then rechecks under existing admission barriers
  and commits the root last.
- **Idle compact:** context occupancy must reach the configured threshold. The same
  idle turn must still be current and the native adapter must advertise `/compact`.
  New input or the deadline invalidates maintenance. `cacheTtlMs` is an operator
  estimate, not provider cache evidence or a guaranteed discount.

Action deadlines remain in the accepted receipt across restart. Becoming due writes
a deduplicated `timer.due` fact; it does not create a second invocation or establish
provider capacity. Wait reevaluation deadlines are persisted with the wait itself.
Staged turn outcomes remain in a durable pending table until observation succeeds.
Each pass reads up to 100 due rows; unconfirmed release or failed reads retain a
15-second retry deadline. Fresh release evidence makes its row due immediately.
Hashes only deduplicate identities: recovery uses no scan cursor, so later facts
and earlier unfinished rows stay eligible independently. The ledger upgrades
existing rows in place with an initially due deadline.

Existing recurring Schedules retain timezone, overlap, misfire and run-ledger
semantics. They do not need another DSL or a replacement scheduler. The
[decision note](../../../../.agents/notes/proposed/architecture/2026-10-25-session-automation-coordinator.md)
records alternatives and verification limits. Synthetic tests exercise local
storage and execution boundaries without accessing provider accounts.
