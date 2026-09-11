# Hide thinking under a finished assistant reply

Status: implemented
Translation: current

[中文](./2026-09-11-thinking-under-finished-reply.zh.md)

## Abstract

After the assistant turn is stamped `finished`, the desktop footer already shows the completion time and duration. Session presence can still be `running` during host finalization, so the activity row kept saying "Thinking" under that finished bubble. The row is now omitted when the last history entry is a finished assistant. Presence is unchanged.

## Decision

- Gate the activity row on the last history bubble, not on clearing session presence.
- Keep showing permission and initializing labels. A later user turn in history restores the thinking row.
- Do not clear presence on `history.finished`; that signal is session-scoped and still covers a new turn, permission wait, and autoPrompt.

## Evidence and limits

A Windows 0.93.3 tester confirmed the sequence on Codex, first conversation: the reply and completion time appear, then the extra "Thinking" under them disappears on its own. No exact overlap duration was recorded. Unit tests cover last-entry finished vs open vs later user turn. Packaged Electron was not retested here.
