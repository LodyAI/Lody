# Session finalization status

Status: draft
Translation: current

[中文](session-finalization-status.zh.md)

After an agent prompt returns, the host may still be finishing history, usage,
and workspace bookkeeping. The conversation displays **Finalizing…** during
explicit live `running + phase: finalizing` presence, instead of hiding the
activity row or claiming the agent is still thinking.

Finalization remains busy. This label does not release execution ownership,
change Stop behavior, or bypass the existing queue/guide submission rules.
When presence clears, the activity row disappears; a new running prompt resumes
its normal activity label. Initialization and permission labels retain priority.
Completed history alone is not evidence of finalization. Older hosts without the
optional phase retain their existing activity display.

## Evidence

- `apps/cli/src/session/session-execution-service.ts` publishes the phase.
- `packages/components/src/components/sessions/session-chat-interface.tsx` displays it.
- [Decision](../.agents/notes/implemented/bug-fix/2026-10-06-finalizing-status-label.md).
