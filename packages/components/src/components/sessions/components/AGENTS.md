# sessions/components — file tree

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read the parent [sessions AGENTS.md](../AGENTS.md) first. This scope holds
`file-tree-view.tsx` (the `VirtualFileTree` row renderer and its virtualization)
and `file-tree-states.tsx` (empty/loading/error states). Surrounding file-surface
rules: [.agents/docs/sessions-file-surfaces.md](../../../../../../.agents/docs/sessions-file-surfaces.md).

- **File tree: ONE row renderer** (`VirtualFileTree` in `components/file-tree-view.tsx`)
  and ONE virtualization gate, counting VISIBLE rows. A second tree-wide count
  used to swap in Radix `TreeView`, so a lazily growing tree thrashed between two
  row implementations — do not reintroduce either. An empty virtual range renders
  NO rows (never `rows.map`) and keeps the total-size spacer: the ScrollArea
  viewport is an ANCESTOR ref, so it is still null when TanStack reads
  `getScrollElement()`, making the first range always empty — a full-render
  fallback there mounted the whole tree. Re-`measure()` on viewport attach/resize
  (as `shared/option-selector.tsx` does). Rows are `memo`'d against per-frame
  scroll re-renders, which needs `pruneExpandedFileTreeIds` to return its input
  Set on a no-op prune (watcher ticks churn `data`) and icon factories to cache by
  resolved icon name. Coverage: `tests/file-tree-virtual-rows.test.tsx`.
  **Expanded folders + selected row are the user's intent and outlive the
  component.** The side panel shows one tab at a time, so opening a file unmounts
  the tree; component-local state collapsed every folder on the way back. State
  lives in `lib/file-tree-view-state.ts`, keyed per tree (`viewStateKey`,
  `session-files:<sessionId>` from `session-detail.tsx`), memory-only and LRU
  bounded; an unkeyed tree stays ephemeral. `pruneExpandedFileTreeIds` therefore
  applies to the RENDERED set only — pruning the stored set would drop every
  nested folder each time the provider rebuilds the tree, because a lazy
  directory carries no children until it is initialized. Coverage:
  `tests/file-tree-view-state.test.tsx`.
