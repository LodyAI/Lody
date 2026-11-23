# Grok scheduled task lifecycle

Status: draft
Translation: current

[中文](grok-scheduled-task-lifecycle.zh.md)

When Grok creates a scheduled task inside a conversation, Lody should receive its
lifecycle through the existing ACP Extension Core schema. Grok owns scheduling
and execution; the adapter translates native events. This does not create a
machine-owned Lody Schedule or promise execution after Grok stops.

The adapter advertises `tasks: { version: 1, scheduled: true }`. Standard ACP
tool updates carry `_meta.lody.task` with `kind: "scheduled"` and a stable ID
separate from subagent execution IDs. Creation is pending; firing is in progress;
removal completes the schedule lifecycle, without asserting that a fired
subagent succeeded. Shutdown cleanup must not terminate the persisted task.
Replay retains its replay marker and task identity, including during restoration.
Only owned sessions and explicitly requested load/resume sessions are translated.

Native canonical scheduler tool identities map to Core's `CronCreate`,
`CronDelete`, and `CronList`. Native inputs, outputs and failures retain their
meaning. Interval schedules are not rewritten into cron expressions. No new Core
fields or RPCs are introduced. Countdown/next-fire display and schedule controls
are outside this change; lifecycle support alone does not make the existing
cron-based panel understand intervals.

## Evidence

- Adapter: `packages/acp-extension-grok/src/proxy.js` and its protocol tests.
- Core: `packages/acp-extension-core/src/session.ts` and `src/capabilities.ts`.
- [Implementation decision](../.agents/notes/implemented/feature/2026-09-29-grok-scheduled-task-lifecycle.md).
- Native wire shapes inspected at grok-build `f0e3be1`; authenticated execution
  with the pinned Grok 1.0.40 runtime remains unverified.
