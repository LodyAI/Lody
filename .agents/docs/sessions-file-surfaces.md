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
- The Changes sidebar's Types view keeps the filename prominent and shows its
  parent workspace path beneath it, so similarly named files remain identifiable
  without relying on a hover-only title.
- Diffs opened with a precise file focus open only that file by default; the other
  cards start collapsed and remain individually expandable. A base (All Changes)
  diff opened without a focus starts with every card collapsed, while a direct
  conversation/turn diff without a file focus keeps its all-files-open default.
  On mobile, the diff-header action closes the diff sheet before opening the
  file drawer so the diff modal cannot cover the destination viewer.
  `SessionMobileDiffDrawerContent` explicitly portals the diff into the nearest
  session drawer's popup host. The legacy Vaul/Radix modal locks pointer events
  on the body; a Base UI drawer portalled there can pass scrolling through to
  the conversation. Keep this choice local to the mobile diff rather than changing
  the default container of every modal.
- Editor window (Monaco): `session-monaco-text-viewer.tsx` inside
  `session-file-content-view.tsx`.
  The save hook compares the complete editor text with the accepted open/refresh
  snapshot or successful save result. Undo to that baseline clears Unsaved, disables
  Save, enables Refresh and releases leave protection; redo restores pending edits.
  A write in flight keeps protection until it settles, and conflicts invalidate the
  old baseline. File switches and accepted external replacements fence late results;
  provider rebuilds alone preserve the baseline and draft. See the
  [saved-text decision](../notes/implemented/bug-fix/2026-10-05-file-editor-undo-saved-state.md).
- **What a client may DO with a session file is one model, `hooks/use-session-file-actions.ts`,
  and three surfaces render it**: the Files tree's right-click menu, the side
  panel's ⋯ button (left of `+`, and absent unless the active tab is a file),
  and the file-error card. The split it encodes is the invariant, not a detail:
  copying a path is offered ANYWHERE (every platform can write to the
  clipboard), while
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
  Native mobile exports those same complete bytes through the Capacitor cache
  and system share sheet instead of a browser download. The binary notice exposes
  this as Share file alongside Copy file path only when its binary snapshot has
  complete bytes (including zero bytes); error cards do not expose sharing.
  The file menu uses the same action. Only native exports suppress duplicate
  clicks while pending; browser downloads remain independent. Each export uses an isolated
  cache filename. No remote host path is passed to the device OS.
  The path is resolved on the OWNING machine (its Flock `dotlodyPath` /
  local-project root). The owning daemon publishes a real, normalized project
  root even for older registrations through a symbolic link, so the renderer's
  worktree ID matches the directory the daemon created. The file path is built
  ONLY from that workspace root plus a
  genuinely workspace-relative viewer path — `lib/session-local-file-path.ts`
  rejects absolute and `..` paths, so a remote session can never hand this
  machine's shell a path of its choosing. The Files tree and the side-panel ⋯
  menu expose that identity as two copy actions — `Copy relative path` always,
  and `Copy absolute path` only once the workspace root resolves or the path is
  already absolute; an unresolved root leaves the relative copy alone. The
  file-error card and the Markdown-link menu keep one `Copy file path` /
  `Copy Path` action, which copies the absolute path when it resolves and
  otherwise the path as held. `SessionFileErrorState` owns which error kinds
  get the row (`offersFileActions`): only too-large and unsupported, never a
  missing, denied, or offline file where every button would fail. That card has
  NO status glyph and stacks its actions full-width in one column: a 40px icon
  column indented one short paragraph for decoration, and buttons sized by their
  own labels gave three ragged widths on three lines in a side panel, where the
  width difference reads as meaning. The tree passes the menu items down to its
  memoized rows, so they must stay referentially stable, and only FILE rows get
  a menu (`item.children === undefined`; `hasChildren` is false for an empty
  directory too).
- Videos use the static `SessionFileVideoPreview` with native controls and inline
  mobile playback. `video-file-preview.ts` recognizes container candidates, not
  codec guarantees. Provider bytes become typed object URLs; local resource URLs
  go directly to the media element. Deactivation destroys the player and releases
  its blob; document visibility pauses background playback without auto-resuming.
  Media errors preserve the file-action notice. Remote binary limits still apply;
  the player adds neither a transport nor transcoding. The mobile project file
  browser shares the player. Intent: [local file links](../../specs/local-file-link-actions.md).
- Session PDFs use the PDF.js paged viewer. Electron's `lody-resource://` URL is a
  custom scheme; PDF.js's URL loader only enables its network range reader for
  HTTP(S), so passing that URL directly can consume the whole file. Use
  `PDFDataRangeTransport` to request and validate 64 KiB byte ranges instead. The
  local resource service classifies `.pdf` paths as binary `application/pdf` and
  exposes `Accept-Ranges` and `Content-Range` to the cross-origin renderer. Do not
  copy local PDF bytes into a renderer snapshot. PDF.js virtualizes page rendering,
  and the viewer caps each page canvas at 8 megapixels. Remote/provider binary
  limits remain unchanged; parse and read failures return to the existing binary
  notice with its file actions. The viewer starts at fit width and offers page
  thumbnails, direct page entry, quarter-turn rotation, zoom modes and percentages,
  and expandable search. Thumbnail rendering follows the visible sidebar range;
  file actions remain in the existing side-panel menu.
- Markdown file viewers copy the latest complete source text (including unsaved
  editor changes) from the top toolbar. On mobile, source mode uses the native
  text surface instead of Monaco so long-press keeps the OS selection menu;
  rendered Markdown must opt into native selection through
  `data-native-selection-allow`.
- v2 semantics for file tree, All Changes, refresh/save conflicts, and CLI-local
  turn diff RPC: `specs/code-collab-v2.md`.
- DOCX, XLSX, and PPTX enter through the static `SessionFileOfficePreview` shell.
  An active preview schedules a bounded read at idle and then imports only that
  format's renderer and worker-backed engine. The local resource URL is read
  into at most 25 MiB; remote providers must first pass their own binary limit.
  Hiding the panel aborts the read and discards a late import. XLSX uses a
  read-only virtual grid, DOCX requires worker parsing, and PPTX virtualizes its
  slide list. Parse failures return to the file-action notice. Legacy `.doc`,
  `.xls`, and `.ppt` are not parsed.
- CSV and TSV keep the existing text `Source` tab. Their default table preview
  starts a worker only while active, parses at most 50,000 rows, 256 columns,
  and 200,000 cells, and virtualizes rows and columns. Search also stays in the
  worker. Hiding the panel terminates the worker; source editing stays in the
  existing Monaco/native text surface.
- CSV/TSV and XLSX support preview-only resize and rectangular selection copy.
  Clipboard values preserve table structure; XLSX reads from its worker through
  a bounded adapter. See the [decision](../notes/implemented/feature/2026-10-09-spreadsheet-preview-controls.md).
- **Core viewers are intentionally NOT code-split** (file viewer, diff viewer,
  diff panel, inner Monaco/Markdown remain static imports). The old
  `lazy(() => import())` wrappers produced stale-chunk load failures in the
  local Electron bundle and must not return. Office format engines are the
  narrow exception: their WASM/worker cost is deferred until an active file
  actually needs them. The static entry shell handles loading and errors.
