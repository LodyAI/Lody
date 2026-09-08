# sessions/message-queue — queued turns

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read the parent [sessions AGENTS.md](../AGENTS.md) first. This scope renders the
queued-turn list (`message-queue-display.tsx`, `message-queue-row.tsx`,
`queued-image-preview.tsx`, `use-message-queue-editing.ts`) that
`session-chat-input-area.tsx` mounts. Submission routing into the queue lives in
`../session-message-submit-route.ts` and is described in
[.agents/docs/sessions-live-status.md](../../../../../../.agents/docs/sessions-live-status.md).

A queued item's Steer action uses native acknowledged steering only when the
authoritative ACP capability cache advertises it. Never infer steering support
from built-in/custom config type or agent identity; unsupported and stale cache
entries retain the interrupt-and-send fallback.

The queue intentionally stays OUT of the composer info bar
([.agents/docs/sessions-info-bar.md](../../../../../../.agents/docs/sessions-info-bar.md)).
