# sessions/message-queue — queued turns

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read the parent [sessions AGENTS.md](../AGENTS.md) first. This scope renders the
queued-turn list (`message-queue-display.tsx`, `message-queue-row.tsx`,
`queued-image-preview.tsx`, `use-message-queue-editing.ts`) that
`session-chat-input-area.tsx` mounts. Submission routing into the queue lives in
`../session-message-submit-route.ts` and is described in
[.agents/docs/sessions-live-status.md](../../../../../../.agents/docs/sessions-live-status.md).

Every queued row offers Steer while an active turn can accept it. Steer sends the
selected `$cid` and expected active turn to the owning daemon; it never reorders,
removes, or materializes a queue row in the renderer. A rejected or missing identity
must leave the active turn running. A row's number and message body are one drag
activator; its Steer, edit, and remove controls stay outside that activator.

The queue intentionally stays OUT of the composer info bar
([.agents/docs/sessions-info-bar.md](../../../../../../.agents/docs/sessions-info-bar.md)).
