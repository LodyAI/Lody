# Why file identity and IPC typing need explicit boundaries

The binding rules for UI file helpers and their callers live in
[components/src/lib/AGENTS.md](../../packages/components/src/lib/AGENTS.md).
This page preserves the rationale and previously recorded gaps that accompanied
those rules; the instruction reorganization did not revalidate runtime behavior.

## Source types without a runtime cycle

Electron renders `@lody/components`, and the UI's IPC client imports the main
registration's service type. Type erasure prevents a runtime cycle, but the type
checker still reads main-process declarations. That explains the components
project's decorator setting and Node type dependency; neither grants shared UI
access to Node at runtime.

A handwritten invoke map previously drifted from `@IpcMethod()` registration and
the preload policy. Deriving signatures from the service classes and constructor
list avoids maintaining a second copy. Push events and one-way sends have a
separate, platform-neutral owner.

## Two path origins and two cache keys

A tree or LSP target is already a machine-indexed path. A Markdown link is text
that may encode spaces, line positions, or an absolute host root. Treating both
as links changes valid filenames: `report%20v2.md` becomes a different path,
`2024:30.txt` loses its tail, and `fixtures/worktrees/<uuid>/case.txt` gets rerooted.

The machine can also resolve a different case or Unicode spelling than requested.
The returned spelling becomes the save identity, while a viewer keeps requesting
its original spelling because the file index never learns that resolution.
Without both cache keys, either saving says the file was not opened or change
checks/reopens miss their cached entry. Refreshing only one key after save leaves
the other holding the old digest and makes the next check report our own write as
an external edit.

## Known gaps

These are existing inspection notes, not newly reproduced findings:

- `ai-gui/view.tsx` sends ACP `locations[].path` through `onFilePathClick` and the
  href parser. A third provenance kind would let filesystem paths strip roots
  without URL decoding. This is a proposed repair, not implemented behavior.
- `codeCollabFileTreeValueToSessionFileEntry` maps all `kind: 'skipped'` entries to
  `unsupported-special`. A transient EBUSY/EMFILE or disappearance can therefore
  leave a row unclickable until another full scan. Directory failures use the
  same reasons, and `openFile` retains index `readonly`, so simply allowing more
  skipped reasons can exchange an unopenable file for an uneditable one. The
  binding repair constraints remain in the helper rules.

## Error messages describe different boundaries

The machine's coarse `permission_denied` code covers both a preview policy
rejection ("outside the workspace") and an owner-identity startup race ("owner
session mismatch"). Mapping the code alone would blame filesystem permissions
for both; the message-specific presentation distinguishes policy from a retryable
race.
