# Archive page

Parent `src/components/AGENTS.md` also applies. `CLAUDE.md` is a symlink; edit `AGENTS.md` only.

- The archive page list virtualizes **visible** group headers and session rows
  with `@tanstack/react-virtual`. Flatten first (`lib/archive-list-virtualization.ts`);
  do not mount a virtualizer per group, and do not use Virtua.
- `ArchiveListWindow` owns the scrollport. `WebArchiveScreen` and
  `MobileArchiveScreen` are chrome only (`overflow-hidden`). Below
  `ARCHIVE_LIST_VIRTUALIZE_THRESHOLD` visible rows, keep the static renderer.
- Virtualized keyboard navigation walks the flattened index (`scrollToIndex`
  then focus). Do not rely on `useListKeyboardNavigation`'s DOM query on that
  path.
- Rows do not draw a `:focus-within` ring around focused children. The title,
  checkbox, and actions each show their own keyboard focus; the row keeps its
  separator while one is focused. [Decision](../../../../../.agents/notes/implemented/bug-fix/2026-09-26-single-focus-edge-for-nested-editors.md).
