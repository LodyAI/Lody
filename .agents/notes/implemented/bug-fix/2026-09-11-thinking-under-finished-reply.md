# Hide thinking under a finished assistant reply

Status: implemented
Translation: current

[中文](./2026-09-11-thinking-under-finished-reply.zh.md)

## Abstract

After the assistant turn is stamped `finished`, the desktop footer already shows the completion time and duration. Session presence stays `running` until the turn scope releases, so the activity row kept saying "Thinking" under that finished bubble. Host and viewer deliver presence and history on separate planes, so a finished last bubble cannot prove the live turn has stopped. The execution owner now publishes an optional `running.phase = finalizing` at the shared prompt/autoPrompt exit; the UI hides Thinking from that phase only.

## Decision

- Add optional `phase: 'finalizing'` on `{ type: 'running' }`. Do not add `activity: 'finalizing'`; old `ActiveSessionStatusSchema` would reject the enum and drop the whole presence entry.
- `markPromptWorkingEnded` reports `finalizing` without clearing presence. `markPromptWorkingStarted` already restores `thinking`, including autoPrompt restart.
- Codex image begin/end update presence activity only (`thinking` ↔ `image_generation`). They do not write durable `SessionMeta.status`, so an in-flight `setStatus` cannot undo `finalizing` or idle.
- UI hides the activity row only when live presence is `running` with `phase === 'finalizing'`. Do not hide from last-history `finished`.
- Keep the original continueSession thinking order. An earlier `openAssistantEntry` already ran before initializing; moving thinking after the inner open cannot fence lagged viewer history.
- Old clients strip unknown `phase` and keep `running`. Mixed old hosts without `phase` still show leftover Thinking.

## Evidence and limits

A Windows 0.93.3 tester confirmed leftover Thinking under a finished first Codex reply, then it disappeared. Independent review reproduced a goal resume where presence was `running` and prompt was in flight while the viewer's history still ended on the previous finished assistant. Unit tests cover presence-only hide, old running parsers keeping the session, goal resume with lagged history, usage-flush finalization, autoPrompt start/end, and permission remaining a distinct status. Packaged Electron click-through of the fix was not retested here.
