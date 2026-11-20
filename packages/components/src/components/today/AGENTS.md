# Today outline surface

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Behavior: [Today Spec](../../../../../specs/today-outline.md). Files: [README.md](README.md).

- Every Today surface mounts only while `todayFeatureEnabledAtom` is on; turning it off must
  unmount the entry, page, pinned column and their subscriptions. Data keeps syncing.
- One Lexical editor serves a whole Today surface and is mounted on the node being edited;
  other nodes render static text with identical metrics. Do not mount an editor per node.
- Text reaches LoroText only through `bindLoroText` and the page undo (`editText`);
  structural edits go through `TodayOutline` inside `undo.structural`. Lexical history stays off.
- Outline keys are guarded against IME composition (`isComposing`, keyCode 229, `Process`).
- Viewing a day never creates it remotely: a page joins its room only once registered.
  A failed registration or join retries with backoff while the page is open; never leave a
  page with local content unregistered, and keep a joined subscription even if its first sync failed.
- A conversation mention is one U+FFFC carrying the `mention` mark. Node text is read and
  written only through `readTodayText`/`insertTodayRich` (never `toString()` slices), so
  marks survive split, merge, paste and the binding ([why](../../../../../.agents/notes/implemented/architecture/2026-11-20-today-inline-mentions.md)).
- Mentions read status from the sidebar's signals and `sidebarStatusGroup`, and the status
  menu writes through `useSessionActions`; Today never derives or writes status its own way.
- A mention is one caret position everywhere: static rows and editor decorators render the
  same `TodayMention`, and caret geometry counts `[data-today-mention]` as one character.
- Import `../../providers/*` relatively: the Electron web build maps `@/providers` elsewhere.
