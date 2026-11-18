# Session status slot

The priority-ordered connection and machine status slot.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- `session-status-strip.tsx`: ONE priority-ordered status slot for
  connection/machine problems (browser-offline > machine-removed >
  machine-offline); states hand off, never stack. This slot remains separate
  from the conversation's sync details. The status chip uses
  `useSessionStatusPresentation`; machine liveness is presence-based
  (`useMachineOnlineStatus`; an unknown machine cannot be shown as offline).
  `isMachineRemoved` blocks send after metadata has loaded. Machine-offline
  is informational because sends are written durably and run on reconnect.
  The [sync details in the info bar](sessions-info-bar.md) explain which
  receive path is caught up, waiting or interrupted without changing dispatch.
  The transcript retains cached history. Its cold skeleton and first-catch-up
  state remain independent of a later connection interruption.
