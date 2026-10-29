# Close E2EE CLI fail-open and cleanup gaps from review

Status: implemented
Translation: current

[中文](2026-10-27-e2ee-cli-review-fixes.zh.md)

## Abstract

A code review of the merged M2 CLI integration found paths where an encrypted
workspace could be handled as plaintext or leak its owner. The local catalog now
never caches a workspace whose content mode this client does not implement, so an
offline daemon restart cannot open it as plaintext. The initial export restriction
has reached its owner-approved milestone: [local export](../../../../apps/cli/README.md#local-export)
now reads the protected replica and writes decrypted files on this device. Schedule documents and their Registry also use the protected CRDT transport. One-shot commands close an opened encrypted workspace when manager creation
fails, and the CLI E2EE cloud port validates history and mailbox replies with Zod
instead of trusting or casting them. Two related findings that depend on the pending
machine-pairing change are handed to that line rather than patched here.

## Decisions

- **Unknown modes fail closed in the catalog.** A cached row without `contentMode`
  means plaintext to every reader, including released v1 readers. Rows are written only
  for absent/`plaintext`/`e2ee` modes; an unknown mode drops the row (and any previous
  row for that id) so offline startup cannot pick it up. Online startup already
  rejects it with `workspace_mode_unsupported`.
- **Export is device-local.** The original refusal prevented an unverified path from
  being enabled prematurely. The current exporter uses the protected workspace manager
  and may write decrypted content to the user-selected
  local directory. Desktop copy/image export also remains local.
- **Sync keeps the protected replica.** Encrypted workspaces sync metadata, session,
  machine and Schedule documents plus the Schedule Registry, using the same encryption,
  signatures and snapshots as the other protected CRDT rooms.
- **Creation failure owns cleanup.** As in `Lody.create`, one-shot manager creation
  failure closes the opened custody/history/refresh owner. The original error is kept;
  a cleanup failure is logged, not substituted.
- **Validate at the boundary.** History pages and mailbox replies are parsed with
  schemas mirroring the Electron cloud client. A schema per mailbox method, indexed by
  the method, returns the typed reply without a cast. Unifying the CLI and Electron
  schemas in `@lody/shared` is deferred until the pending E2EE stack has merged.
- **No non-null assertions in the CLI runtime.** Missing journal/cache rows become typed
  `storage` failures; a missing overlap record is a local evidence conflict.

## Not changed here

- Re-pairing after the machine device original is lost: the credential file is keyed
  by genesis while its AAD binds the signing key, so a replacement key cannot proceed.
  Fixing it changes the custody layout used by the pending machine-pairing PR (#1898)
  and is handed to that line.
- Local pairing rotating a staged but unapproved session on every prepare: same owner.
- Activation on stale state after a failed refresh and concurrent activation with a
  different key are already covered by #1898.

## Verification

Each new test failed with its fix reverted and passed with it: catalog unknown-mode
retention, one-shot cleanup (including a failing close), export/sync on encrypted
workspaces through the real commands, and malformed history/mailbox replies through
the real cloud port. The CLI E2EE runtime suite and full `pnpm check` cover the
assertion removals and formatting fixes. Not verified against a live backend.
