# Auto review and merge, and the session status slot

The per-session auto review mode and the priority-ordered connection/machine status slot.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- Auto review and merge (`auto-review-menu-item.tsx`, `auto-review-info.tsx`,
  `auto-review-status.tsx`, `../../hooks/use-auto-review.ts`): a per-session
  checkbox in the "…" menu behind `reviewAgentFeatureEnabledAtom`, plus an
  always-visible status banner above the info bar while a run is active.
  A session may start either review mode only after its machine has a usable
  reviewer row (`agentConfigId` + ACP run config) in the workspace review Flock
  doc. Missing/stale configuration opens the setup explanation and routes to
  General settings; never let the engine discover this only after spending a
  run. The General settings table lists every visible machine and reuses the
  composer run-config dropdowns for Agent/Model/Reasoning/Permission.
  A checkbox, not a button: this is a standing mode that survives restarts and
  must be revocable. Turning it ON confirms first (automatic merge is not
  reversible); turning it OFF does not — stopping an automation must never be the
  harder direction. **The banner is deliberately NOT gated** on the experiment
  atom: a run lives on the machine and keeps going, so hiding it after someone
  switches the experiment off would recreate the exact failure it prevents —
  finding out only when a PR merged itself. The gate is per-device UI; the
  authorization is `SessionMeta.autoReview`, which only a human may write.
  Structural coverage: `tests/review-agent-gate-coverage.test.ts`. Engine and
  invariants: `apps/cli/src/lib/review-automation/AGENTS.md`.
- `session-status-strip.tsx`: ONE priority-ordered status slot for
  connection/machine problems (browser-offline > machine-removed >
  machine-offline); states hand off, never stack. Doc-stream degradation is
  deliberately NOT a status (was removed by product decision — the reconnect
  loop owns recovery and surfacing it read as noise); do not re-add a "may be
  out of date" state. The status renders as the info bar's status chip on
  BOTH platforms via `useSessionStatusPresentation` (the standalone
  `SessionStatusStrip` component no longer renders in production — story
  coverage only). Machine liveness is presence-based
  (`useMachineOnlineStatus`, three-state — 'unknown' must not claim offline).
  `isMachineRemoved` (meta gone, blocks send; gated on `docMetaCacheReadyAtom`)
  is distinct from machine-offline (informational only: sends are written
  durably and run on reconnect — do not block them; neutral tone, not warning).
  The header `SessionSyncingIndicator` only covers active catch-up
  (`isSyncingRoomSyncState`) behind a ~400ms `useDelayedFlag`.
