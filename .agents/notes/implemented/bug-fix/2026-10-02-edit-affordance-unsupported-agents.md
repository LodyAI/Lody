# Edit affordance gated to supported sessions

Status: implemented
Translation: current
Issue: [#1216](https://github.com/LodyAI/Lody/issues/1216)
PR: [#1219](https://github.com/LodyAI/Lody/pull/1219)

[中文](2026-10-02-edit-affordance-unsupported-agents.zh.md)

## Abstract

Sessions whose agent does not support edit-and-resend — anything but builtin
Codex/Claude Code, for example builtin Kimi Code — still rendered the pencil
"Edit message" action on the last user message, and saving the edit silently did
nothing: the editor stayed open, the message was unchanged, and no
`session/edit-and-resend` request ever reached the daemon. The conversation
stream handed every last user row an always-defined local wrapper, so the
session-level eligibility gate never reached the row. The stream now forwards
its edit handler to a row only when the session interface actually provided one,
pinned by a new render test. The daemon's `UNSUPPORTED_AGENT` rejection is
unchanged and remains the enforcing boundary.

## Evidence and decision

The product gate lives in two places that must agree: the session screen's
`editableLastUserMessageId` memo
(`packages/components/src/components/sessions/session-chat-interface.tsx`)
returns `null` for non-Codex/Claude agents, archived sessions, active goals,
pending-apply messages, and non-authoritative capability caches, and the daemon
rejects other agents with `UNSUPPORTED_AGENT`
(`apps/cli/src/session/session-edit-and-resend-service.ts`). But
`ai-gui/index.tsx` passed each last user row its local `handleEditLastUser`
wrapper unconditionally; the wrapper's `if (!onEditLastUser) return false`
guard then swallowed the save, and the row view treats a `false` return as
"keep the editor open" with no error surface. A reproduction on a builtin Kimi
Code session showed zero edit RPCs in the daemon log.

The alternative — surfacing a toast on the false return — was rejected for this
fix: an affordance that can never succeed should not render at all, and the row
layer cannot distinguish "unsupported session" from a transient eligibility
change, which the session screen already owns. The guard inside the wrapper
stays as defense in depth. This builds on the edit-and-resend editor from
[mentions in edit-and-resend](../feature/2026-09-28-edit-resend-mentions.md).

## Verification and limits

`packages/components/tests/user-message-edit-affordance.test.tsx` renders the
connected stream with real row wiring (only the viewport windowing hook is
stubbed): without the session-level handler no edit button renders; with it,
exactly one button renders on the last user row and opens the editor prefilled
with that message. Verified on the components suite. Not verified: the same
silent-false path in `handleEditLastUser` when eligibility flips between
opening the editor and saving — that race still returns `false` without a
toast and is left for a follow-up.
