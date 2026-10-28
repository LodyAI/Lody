# Session continuation UI: a note, not a panel

Date: 2026-10-27
Status: proposed
Translation: current

[中文](2026-10-27-session-continuation-note-ui.zh.md)

## Abstract

The first UI proposal treated durable Session continuations as a product surface:
a right-side panel, status pills, a settings page and an activity feed. That made a
small trick feel like a control console. The chosen direction is a single quiet note
at the end of the conversation, a compact popover for inspection, and three
per-Session tweaks hidden behind the session menu. The UI must never announce an
unknown delivery as success, and a continuation blocked by Stop is the only state
that escalates to a direct nudge. The desktop reads and manages waits on its local
Host; cross-device and Web access need a separate authorization contract.

## Decision

- One note, not a panel. No new right-side tab, no new navigation item and no
  feature-level status vocabulary. The conversation is the surface.
- The note and tweaks require Developer mode and the default-off Session continuation
  beta switch. This is a UI gate, not automation authorization; switching Developer
  mode off hides the UI without clearing opt-in.
- The note is the Agent's own sentence plus a countdown and one action. Inspection
  details live in a popover; check counts, program source and evidence are not
  primary UI. The popover uses the shared spacing scale and a common icon/text
  grid for its heading, description and detail rows.
- `settled`, `cancelled` and `expired` leave the note. `matched` is not "done":
  queued, running, blocked and unknown delivery each keep their own honest copy.
- A continuation blocked by Stop becomes a nudge with `恢复会话` / `取消等待`; the UI
  never clears Stop on its own. Permission, unavailable and failed states keep the
  same non-success rule.
- The three behaviors are per-Session switches under the session menu, not a
  settings page: quota recovery, archive after merge, and idle compaction. A Host
  may disable a switch with a reason when the current Provider cannot support it.
- The view model is deliberately small: phase, next check, last check, expiry,
  delivery state and block reason. Raw programs, ledger receipts, bindings and
  evidence never cross into the renderer.

## Evidence and limits

- `packages/components/src/components/sessions/session-continuation.ts` owns the
  state collapse; `session-continuation-note.tsx` and
  `session-continuation-tweaks.tsx` are the surfaces. Stories cover waiting,
  queued, blocked-by-Stop, failed, offline, unknown delivery and phone.
- Quota recovery is currently verified for Claude Code and Codex subscription
  accounts only. Claude and Codex advertise `rateLimits.query`; Codex requires a
  ChatGPT profile. Grok has an eligibility branch but its extension is not
  initialized in this checkout, so it remains unverified. Other builtin adapters
  have no `rateLimits.query` capability, and API-key, branded, Magpie and
  credential-override configs are not eligible. The older Claude-only
  `continue` shortcut was retired in the same change; existing reservations stay
  ordinary scheduled messages.
- Local Electron uses a scoped IPC bridge to list and cancel waits and read or
  configure Session policies. While the Session is visible it polls the Host;
  rejected reads show unavailable state and Session switches discard late results.
  Host responses are filtered before reaching the renderer. Remote machines, Web,
  capability discovery and a Stop-specific resume action are not connected.
- This worktree has no installed `node_modules`. The three new suites were run
  with a sibling worktree's installed toolchain: 18 tests passed. A package-wide
  typecheck still reports pre-existing cross-worktree errors, but none in the new
  files; Storybook was not started here. Human visual review is still pending.
- The backend contract and policy remain owned by
  [the continuation coordinator note](../architecture/2026-10-25-session-automation-coordinator.md).
