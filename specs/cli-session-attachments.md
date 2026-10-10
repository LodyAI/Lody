# CLI and MCP session input attachments

Status: draft
Translation: current

[中文](cli-session-attachments.zh.md)

A caller on one machine can start or continue a conversation on another machine
with local files. The receiving agent must receive the complete input, and the
conversation must show those attachments in the same user turn as its text.

## Input and ownership

CLI `session create` and `session chat` accept repeatable `--attach <path>`.
Relative paths use the calling process's working directory. `--prompt-file`
still reads text; it does not attach a file. Attachment-only input is valid.

Single MCP `lody_session_create` and `lody_session_chat` accept an optional
`attachments: string[]`. Paths belong to the calling Session's machine and
workspace, never the target. Canonical containment and no-follow opens enforce
the existing agent upload boundary. These inputs require a durable `operationId`;
the legacy wait adapter and batch tools do not gain attachment support.

At most eight attachments are accepted per input, each non-empty and at most
100 MiB. Directories are rejected. Supported images up to the existing image
limit become image blocks on the relay; larger images become file blocks.
The local-only transport retains the existing file/resource-link representation.

## Preparation and commit

Preparation checks and snapshots every source into private bounded temporary
files before transfer. All transfers must succeed before any target user turn is
written or activated. Partial input is never submitted. Snapshots are removed
after preparation. A failed local batch removes its prepared blobs; abandoned
relay objects use the existing retention lifecycle.

Cloud commands upload through the existing authenticated relay. Local-only MCP
copies bytes into the existing local blob store on the same machine and performs
no cloud I/O. Transport returns references only; it never writes conversation
history. The message writer owns text, attachment order, execution configuration,
history and activation. Existing materialization and backfill owners are unchanged.

## Recovery

MCP acceptance atomically freezes attachment references alongside fixed target
Session/Turn IDs in the machine-local Operation store. The canonical command
identifies the original source paths, while recovery uses only the frozen
references. Retrying an accepted operation does not reread source files. Concurrent
acceptance retains the winning operation's references and target IDs.

The calling daemon must advertise `sessionInputAttachments: 1` before an attached
MCP operation is accepted. Do not downgrade that daemon while such operations
remain active. Existing text-only Operations retain their prior storage shape.

Turn retries compare complete authored content and normalized input configuration.
The same Turn ID cannot be reused with different attachments. A committed
dispatch is never rolled back after an uncertain transport acknowledgement.

Standalone CLI sends retain their existing one-shot receipt semantics. A command
rerun is a new send, not a durable retry token; scripts needing recoverable
submission should use the MCP Operation API.

## Evidence

- CLI: `apps/cli/src/commands/session.ts`.
- Preparation: `apps/cli/src/lib/session-input-attachments.ts`.
- Transfer: `apps/cli/src/lib/session-attachment-transfer.ts`.
- Recovery: `apps/cli/src/orchestration/operation-store.ts`.
- Existing draft behavior: [session-files](session-files.md).
