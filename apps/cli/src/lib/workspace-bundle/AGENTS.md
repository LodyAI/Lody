# Workspace bundles

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Intent and current limits: [Spec](../../../../../specs/workspace-export-import.md).

- Rooms travel only as raw bytes (`Flock.exportFile()`, complete Loro snapshots).
  Never rebuild them through scan/put or JSON, which loses tombstones, clocks and peers.
- Withheld or remapped Flock entries go through `mergeFlockBytes`, keeping each
  entry's clock. Never write a row and then delete it to hide it.
- Import refuses unknown codecs and non-owner/admin roles before writing, and
  `planWorkspaceImport` never writes.
- Writes go bodies, catalogs, Meta, then Roost rewrites. The journal is keyed by bundle
  room id; anything a room needs, such as its import fence, is written in that room's
  unit before its journal line.
- Room kinds and machine scope come from `CODEC_TRAITS`; callers never match codec strings.
- A same-ID body with no shared peer is skipped with its Meta rows. Target deletions are
  not resurrected, and machine records and catalogs never cross workspaces.
- A cross-workspace import never rewrites imported sessions or schedules: it records
  an `importFence` for the target workspace, and dispatch and the schedule engine skip
  exactly that input there. Other workspaces ignore the fence.
- An existing target row changes only under its product rule (`authorize.ts`); one
  violation skips the whole room.
