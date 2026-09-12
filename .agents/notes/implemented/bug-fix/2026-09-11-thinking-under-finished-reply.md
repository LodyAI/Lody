# Hide thinking under a finished assistant reply

Status: implemented
Translation: current

[中文](./2026-09-11-thinking-under-finished-reply.zh.md)

## Abstract

After the assistant turn is stamped `finished`, the desktop footer already shows the completion time and duration. Session presence can still be `running` during host finalization, so the activity row kept saying "Thinking" under that finished bubble. The row is omitted when the last history entry is a finished assistant **and** live presence is leftover `running`. Goal resume has no user row; thinking presence is published only after `openAssistantEntry`, so the gap stays on `initializing` and the presence-driven label remains.

## Decision

- Hide leftover Thinking under a finished last assistant while presence is `running` (same-turn finalize tail).
- Do not hide for `initializing` or `requestPermission`. Goal resume stays on initializing until the assistant entry exists.
- Publish `thinking` presence after `openAssistantEntry` on continueSession, not before prompt setup.
- Do not clear presence on `history.finished`.

## Evidence and limits

A Windows 0.93.3 tester confirmed leftover Thinking under a finished first Codex reply, then it disappeared. Unit tests cover last-entry finished vs open vs later user turn, initializing/permission not hidden, and continueSession thinking-after-assistant-entry order. Packaged Electron and a live goal-resume GUI click were not retested here.
