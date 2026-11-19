# Workspace bundles

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Intent: [workspace export/import Spec](../../../../../specs/workspace-export-import.md).
Overview and current limits: [README.md](README.md).

- Rooms travel only as raw SDK bytes: `Flock.exportFile()` and complete Loro
  snapshots. Never rebuild Flock through scan/put or Loro through JSON; that loses
  deletion records, clocks, peers and unknown fields.
- Withheld or remapped Flock entries go through `mergeFlockBytes`, which keeps each
  entry's original clock. Never write a row and then delete it to hide it.
- Import refuses unknown codecs and non-owner/admin roles before writing. Plans are
  computed on detached copies; `planWorkspaceImport` never writes.
- Write order is bodies, catalogs, Meta, then Roost rewrites. The append-only journal
  is keyed by bundle room id and makes a rerun with the same bundle continue; anything
  a room needs (such as its import fence) is written in that room's unit, before its
  journal line.
- Room kinds, counting and machine scope come from `CODEC_TRAITS` in `codecs.ts`; the
  planner puts them on each room so the CLI and desktop never match codec strings.
- A same-ID body with no shared peer is skipped together with its Meta rows. Target
  deletions are not resurrected. Machine records and machine catalogs never cross
  workspaces.
- A cross-workspace import never rewrites imported sessions or schedules. It records
  an `importFence` naming the target workspace, covering every user turn and queued
  item in the imported document; dispatch and the schedule engine skip exactly that
  input and activation there, and every other workspace ignores it.
- An existing target row may change only under its product rule
  (`authorize.ts`); one violation skips the whole room.
- New domains add a codec in `codecs.ts`, an export path and an import path, with a
  real-repo test. Do not add a second migration framework.
