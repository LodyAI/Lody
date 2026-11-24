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
  Nothing is written while a composition is open, so disposing a binding writes what it still held:
  leaving a node mid-composition must never drop the preedit.
- A day of 200+ visible rows is virtualized; the row being edited always stays mounted. Rows take only their
  own node and state as props, never the visible array, and the page model's snapshot stays incremental
  (`Today/Stress` is the benchmark): a change that walks every node per keystroke is a regression.
- Node actions live in the selection bar, which never takes focus (the surface keeps the selection's keys);
  a to-do state changes only through `TodayOutline.cycleTodo`/`setTodo` inside `undo.structural`.
- Viewing a day never creates it remotely: a page joins its room only once registered.
  A failed registration or join retries with backoff (capped at 5 minutes) while the page is open,
  and typing never cuts a join's backoff short. Never leave a page with local content unregistered,
  and keep a joined subscription even if its first sync failed.
- A conversation mention is one U+FFFC carrying the `mention` mark. Node text is read and
  written only through `readTodayText`/`insertTodayRich` (never `toString()` slices), so
  marks survive split, merge, paste and the binding ([why](../../../../../.agents/notes/implemented/architecture/2026-11-20-today-inline-mentions.md)).
- Mentions read status from the sidebar's signals and `statusViewTier`, and the status
  menu writes through `useSessionActions`; Today never derives or writes status its own way.
- A mention is one caret position everywhere: static rows and editor decorators render the
  same `TodayMention`, and caret geometry counts `[data-today-mention]` as one character.
- Folds go through `TodayOutline.setCollapsed` (a `sys:` commit, never an undo step); a peer's fold
  change never refolds an open page's view (`viewFolds` in the outline).
- `TodayToolbar` takes `surface: 'page' | 'pinned' | 'standalone'`: `'page'` and `'standalone'`
  headers carry window drag chrome and exempt every control; `'pinned'` is not window chrome; and
  only main-window surfaces (`'page'` / `'pinned'`) show `SidebarHistoryControls` while the sidebar
  is hidden. Main pages read `mainPageAtWindowEdgeAtom` (not raw sidebar visibility) for those
  controls and traffic-light clearance.
- Import `../../providers/*` relatively: the Electron web build maps `@/providers` elsewhere.
- The desktop Today window route stays outside the `_auth` workspace layout and its runtime passes
  `backgroundWork: false`: it must not mount the sidebar, notifiers, badges or window-ownership election,
  nor start eager-sync. Its mentions open conversations in the primary window through main.
