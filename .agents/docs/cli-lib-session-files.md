# Session file attachments in the CLI

How a file or image travels from a client into an agent prompt and, eventually, into
cloud storage. Normative intent: `specs/session-files.md`.
[`apps/cli/src/lib/AGENTS.md`](../../apps/cli/src/lib/AGENTS.md) requires this page to
be read before session file upload, dispatch materialization, or backfill is changed,
because the statements below bind those paths.

## Ingest

`message-handler.ts` has two entry points: `handleSessionFileUpload` (cloud, and MCP
`lody_upload_files`) and `handleSessionFileSendLocal`. Local bytes live in
`session-file-blob-store.ts` under `~/.lody/session-files/<ws>/<sess>/<fileId>` and are
persisted as `transport:'local'`.

## Dispatch

`materializeSessionFileAttachments` copies or downloads the bytes to
`<workspace>/.lody/attachments/...` and sends ACP `resource_link` blocks with `file://`
URIs, so an agent can open the real file rather than a pasted excerpt.

Human image inputs keep their ACP `image` block for visual context and additionally
materialize the same bytes as a `resource_link`, so agents can echo or transform them
through a local file path.

## Backfill to the relay

`session-file-backfill.ts` uploads local blobs through the injected relay, flips
persisted blocks from `local` to `r2`, and rewrites `fileId` to the relay key. It is
triggered by dispatch, by opportunistic handoff, and by startup recovery.

Because the flip rewrites the fileId, a `.r2meta` sidecar recording `relayFileId` is
written BEFORE the flip. Restart recovery uses it to finalize a flip that committed but
was not marked, instead of retrying "not yet persisted" forever.

A blob with no history block, older than the draft retention window, is an abandoned
staged-but-never-sent draft and is reclaimed. Blob-store writes are serialized
process-wide so the quota check sees a consistent total.

Backfill commits (the marker write and the history flip) are gated by an authorization
generation plus an `AbortController` owned by `MessageHandler`. `disableRemoteBackfill`
(offline or revoke) aborts the in-flight relay upload and supersedes started tasks, so a
revoke landing mid-upload can never adopt the uploaded bytes — S5/D10, revocation must
prevent upload. Re-enabling opens a new generation and the pending blob backfills on the
next scan.

## Agent output

Agent-to-human ACP `image`, `resource` and `resource_link` output is materialized by
`acp-agent-attachments.ts` during the `message-handler.ts` ACP flush: upload to the
injected image/file capability, then append `image_group` / `file` history blocks. A
`resource_link file://...` is accepted only when it is contained in the session
workspace.
