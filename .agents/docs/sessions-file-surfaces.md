# Code Collab file surfaces in the session UI

Diff pages, the Monaco editor window, session file actions, Markdown viewers,
and why the viewers are not code-split. Data chain:
[packages/components/AGENTS.md](../../packages/components/AGENTS.md).

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- Diff page: `session-conversation-diff-panel.tsx`, data from
  `use-session-conversation-diff-data.ts`. Each file title copies the
  workspace-relative path and, when wired, opens a file-preview viewer tab
  through `handleOpenFile` with `pathKind: 'canonical'` (never the markdown
  href parser).
- Editor window (Monaco): `session-monaco-text-viewer.tsx` inside
  `session-file-content-view.tsx`.
- **What a client may DO with a session file is one model, `hooks/use-session-file-actions.ts`,
  and three surfaces render it**: the Files tree's right-click menu, the side
  panel's ⋯ button (left of `+`, and absent unless the active tab is a file),
  and the file-error card. The split it encodes is the invariant, not a detail:
  `Copy file path` is offered ANYWHERE (every platform can write to the
  clipboard, and on another machine the path IS the whole answer), while
  reaching a shell — `Open in default app` / `Open in browser`
  (`app.openLocalPath` → `shell.openPath`), `Reveal in file manager` /
  `Show in Finder` / `Show in File Explorer` (`app.revealLocalPath`, labelled per
  host OS), and `Open in <editor>` (the user's `session-path-launchers`
  preference) — lives in the optional `localHost` half, resolved only for
  Electron + the file's machine being this one. `Download file` is the exact
  complement: offered only where `localHost` is absent, because with the real
  file one keystroke away a copy in ~/Downloads is a decoy. It reads through
  `openFile`, i.e. the preview API's ONE bounded response, so it cannot serve a
  file past those limits — exactly the files whose error card sent the user
  looking. That is a known ceiling, not a silent failure: say so
  (`sessions.fileActions.downloadTooLarge`), because a generic "could not
  download" reads as a glitch worth retrying. Lifting it needs a ranged or
  streamed Machine RPC method behind a negotiated `protocolCapabilities` key,
  never a client-side retry loop. Never promote a
  local-host action to a surface that cannot perform it, and never re-derive
  that decision per surface — `lib/session-file-actions.ts` states it once.
  The path is resolved on the OWNING machine (its Flock `dotlodyPath` /
  local-project root) and is built ONLY from that workspace root plus a
  genuinely workspace-relative viewer path — `lib/session-local-file-path.ts`
  rejects absolute and `..` paths, so a remote session can never hand this
  machine's shell a path of its choosing; an unresolved root degrades the copy
  to the workspace-relative path. `SessionFileErrorState` owns which error kinds
  get the row (`offersFileActions`): only too-large and unsupported, never a
  missing, denied, or offline file where every button would fail. That card has
  NO status glyph and stacks its actions full-width in one column: a 40px icon
  column indented one short paragraph for decoration, and buttons sized by their
  own labels gave three ragged widths on three lines in a side panel, where the
  width difference reads as meaning. The tree passes the menu items down to its
  memoized rows, so they must stay referentially stable, and only FILE rows get
  a menu (`item.children === undefined`; `hasChildren` is false for an empty
  directory too).
- Markdown file viewers copy the latest complete source text (including unsaved
  editor changes) from the top toolbar. On mobile, source mode uses the native
  text surface instead of Monaco so long-press keeps the OS selection menu;
  rendered Markdown must opt into native selection through
  `data-native-selection-allow`.
- v2 semantics for file tree, All Changes, refresh/save conflicts, and CLI-local
  turn diff RPC: `specs/code-collab-v2.md`.
- **Viewers are intentionally NOT code-split** (file viewer, diff viewer, diff
  panel, inner Monaco/Markdown are static imports). Code-splitting only pays off
  over a network; in the local Electron bundle a lazy `import()` adds no benefit
  and a stale/eval-broken chunk surfaced as "Viewer failed to load / the app may have updated".
  Do not reintroduce `lazy(() => import())` for these — there must be no separate
  viewer chunk that can fail to load. The old `*-lazy.tsx` wrappers + stale-asset
  ErrorBoundary fallbacks were removed for this reason.
