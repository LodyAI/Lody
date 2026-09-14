# sessions/message-queue — queued turns

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read the parent [sessions AGENTS.md](../AGENTS.md) first. This scope renders the
queued-turn list (`message-queue-display.tsx`, `message-queue-row.tsx`,
`queued-image-preview.tsx`, `use-message-queue-editing.ts`) that
`session-chat-input-area.tsx` mounts. Submission routing into the queue lives in
`../session-message-submit-route.ts` and is described in
[.agents/docs/sessions-live-status.md](../../../../../../.agents/docs/sessions-live-status.md).

Exact-item Steer requires the negotiated `queueItemSteer` daemon protocol; missing means
unsupported. The daemon chooses acknowledged native Steer or exact cancel-and-dispatch.
For older daemons, an authoritative `acknowledgedSteer` capability must retain the legacy
native path; otherwise only queue-head interrupt stays enabled. Never reorder a later row
to emulate Steer. A missing, stale, or actively edited exact target must leave the current
turn running. A row's number and message body are one drag activator; its actions stay out.

The queue intentionally stays OUT of the composer info bar
([.agents/docs/sessions-info-bar.md](../../../../../../.agents/docs/sessions-info-bar.md)).
