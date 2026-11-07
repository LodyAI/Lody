# @lody/code-review-helper — File Responsibilities

(Extracted from `AGENTS.md` to keep it under the 4K budget. Read alongside the
Invariants in `AGENTS.md`.)

- `src/parser.ts` parses frontmatter, the overall-summary preamble (markdown before the
  first `## Group:` or `## Review`), the top-level `## Review` findings section, and the
  constrained Markdown review format. Note lines accept an optional leading
  priority/severity word — `P0` / `P1` / `P2` / `QUESTION` / `INFO` (default), plus legacy
  `ERROR`→`P0` / `WARNING`→`P1` — before the backtick reference; the colon after the ref
  may be ASCII `:` or fullwidth `：`. The `old`/`new` side capture is lowercased (the regex
  is case-insensitive). `## Review` bullets (`- P0:` …) become `document.findings`, each
  with path-qualified refs parsed by the exported `parseReviewRef` (`new://<path>:Lx-Ly`,
  `old://<path>:Lx`, `new://<path>`, or a bare `<path>`). `context://path?range=Lx-Ly`
  blocks are read-only context snippets for unchanged files.
- The review model has TWO note homes: cross-cutting P0/P1/P2 conclusions live in the
  top `## Review` section (multi-location, path-qualified, rendered as clickable chips
  that jump the center diff); single-spot `INFO`/`QUESTION` remarks stay as inline notes
  bound to the preceding block.
- `src/node/git.ts` resolves a parsed review against a local Git repository, including
  commit metadata (`bundle.commits`, keyed by the ref used in the file). It initializes
  `bundle.diagnostics` with `validateParsedReviewDocument(document)` plus git-level
  errors; `collectBundleDiagnostics` (in `validation.ts`) therefore must NOT re-validate
  the document or diagnostics would be duplicated.
- `src/review-checklist.ts` is the pure (React-free) review-checkbox model. The single
  source of truth is a set of reviewed snippet (diff-block) ids; file / folder / group
  check states (checked / unchecked / indeterminate) are all DERIVED from it, and
  checking a file/folder just marks its snippets. Keeps the sidebar file tree, the
  center per-snippet "Viewed" boxes, and group boxes in sync. Cascade logic is unit
  tested in `tests/review-checklist.test.ts` — keep them in lockstep.
- `src/react/ReviewRenderer.tsx` renders the desktop 3-column shell (left sidebar =
  Lody mark + group nav + a checkbox file tree from `review-checklist` · `@pierre/diffs`
  diff or `context://` read-only snippet · review-thread panel). The sidebar header shows
  the Lody icon (`src/assets/lody-icon.png`) + "Lody Review" — baked in (not a prop) so
  Storybook and the generated HTML match. Reviewed state lives here as the shared
  snippet-id set; file headers are sticky below the toolbar and use a TWO-LAYER structure
  (`.crh-block-header` outer = opaque page background · `.crh-block-header-inner` =
  rounded-top + elevated surface), so the rounded corners reveal the page bg instead of
  leaking the scrolling code behind them. A scroll listener tracks which
  files are in the main viewport (`activeFiles`; several can be active at once,
  top-most = primary); the right panel dims inactive files' notes/comments/errors and,
  when the primary file changes, scrolls the panel to align that file's thread with its
  diff block. Agent notes + local comments live in
  the right panel grouped by file (NOT inline in the diff); each commented/noted line
  shows a compact severity marker, and clicking a marker ↔ a panel item cross-focuses
  the other side (markers are highlighted imperatively via `data-anno`/`.crh-anno-focused`
  so memoized blocks don't re-render on focus). P0/P1 notes are summarized in a
  "Needs attention" block at the panel top. P0 (red) / P1 (amber) carry color, P2 a
  faint amber; QUESTION/INFO stay neutral. Draft/comment state is owned by `ReviewRenderer`;
  a diff line-click, the hover `+`, or the per-file header button open the composer in
  the panel. Diffs are lazily mounted near-viewport (placeholders otherwise) and blocks
  are memoized, so large reviews stay responsive. Below `lg` the three regions stack.
  Dark-only (no theme toggle). The `## Review` findings render via `ReviewFindingsSection`
  at the TOP of the RIGHT panel (`CommentPanel`), under a small "Review" divider header
  (no P0/P1/P2 count summary). Each `FindingItem` is a non-collapsing card with a uniform
  neutral border/surface (only the severity badge carries color, via `SEVERITY_MARKER`)
  and is always fully shown — no collapse toggle.
  Finding/summary Markdown rendering lives in `parseLightMarkdownBlocks` +
  `renderLightMarkdownBlock`: paragraphs, headings, `-`/`*` lists, inline
  `**strong**`/code, finding ref chips, and fenced code blocks. `FindingBody` passes the
  finding context so backticked refs become clickable `FindingRefChip`s, while
  `SimpleMarkdown` reuses the same block parser for overview/group prose. Clicking a chip
  calls `jumpToRef` (guarded by `renderablePaths` — a no-op if the file isn't in the
  review) → `navigateToFile` (force-mount + expand + scroll to the line's hidden
  `data-anno` anchor) and sets `highlightedRange`, which the target block turns into a
  `FileDiff` `selectedLines` so @pierre briefly FLASHES the whole referenced range
  (e.g. L18–L22) then clears it (a persistent band would mask the add/delete row colors).
  Only the target block re-renders (others get a stable `null`). IMPORTANT: selecting a
  line @pierre hasn't rendered (out of bounds, or inside a collapsed unchanged region)
  throws `No valid rowRange` deep in its async highlight pipeline — which white-screens
  the app and can't be caught by an Error Boundary. So the block validates the range
  against the file length AND polls the diff's shadow DOM (`div[data-line=N][data-line-type]`,
  setTimeout — rAF pauses on hidden tabs) and only applies the selection once every row is
  actually present, skipping the highlight otherwise. An `ErrorBoundary` wraps each
  `FileDiff` (drops the selection on the sync-path throw) and the whole renderer (full-page
  fallback), so nothing can blank the page. Findings have NO visible
  marker in the diff — `buildLineAnnotations` only emits a 0-size hidden `data-anno`
  anchor (`.crh-finding-anchor`) per finding line so the chip jump can scroll precisely.
  (An earlier gutter-dot marker was removed: @pierre has no gutter API and the gutter is
  its own hover-comment "+" zone, so an injected dot fought that affordance.) The right
  panel is STATIC — no scroll-follow, no dimming, and no separate "Needs attention"
  list (findings are the single attention surface; the old `AttentionList`/`activeFiles`
  logic was removed). `validateParsedReviewDocument` warns (`finding_ref_unresolved`) when
  a finding references a path not shown in any group.
- `src/file-icons/` holds per-extension file-type icons (`files/*.svg` + `mappings.ts`
  - `FileIcon`), copied from `@lody/components` (MIT vscode-symbols) so the package
    stays standalone. `FileIcon` resolves an SVG via `new URL('./files/<name>.svg',
import.meta.url)`; folders use a plain lucide icon. Re-sync `mappings.ts` and the
    `files/` set together if updated upstream.
- `src/react/styles.css` owns ordinary CSS defaults, base resets and theme variables, the
  three-column resizer styling (`.crh-resizer`), plus the small `@pierre/diffs`
  integration overrides. The 3 columns are drag-resizable on desktop (widths persisted
  to `localStorage`; the center stays `minmax(0,1fr)`).
- `src/ui/` contains package-local Radix controls with StyleX. Do not import `@lody/components`
  here; this renderer must stay embeddable outside Lody.
- `src/stories/` contains Storybook-only fixed review fixtures and thin wrappers around
  `ReviewRenderer`; keep sample `.review.md` files there when adding visual scenarios.
- `src/cli.ts` owns `validate`, `view`, and `export` commands. `export` resolves a
  `.review.md` against a Git repo and writes a versioned `ReviewBundleSnapshot`
  (`.review.json`, optionally gzip/brotli) — or, with `--format html`, a
  self-contained `.review.html` (reads `dist-standalone/standalone.html` via fs).
- `src/snapshot.ts` defines the `ReviewBundleSnapshot` wrapper (`version`,
  `renderedAt`, `source`, `bundle`) and helpers to create/unwrap/detect it.
  `ReviewRenderer` accepts either a raw `ReviewBundle` or a snapshot.
- `src/standalone/` is the single-file viewer: `main.tsx` (entry; reads
  `window.__LODY_REVIEW__`), `inject.ts` (`injectReviewSnapshot`, exported via
  `./standalone`), `curated-shiki-langs.ts` / `curated-shiki-themes.ts` (build-time
  shiki trimming). `vite.standalone.config.ts` + `scripts/embed-standalone.mjs` build
  it — see [../standalone-build.md](../standalone-build.md). The built viewer is
  republished by the sibling `lody-code-review-viewer` package and fetched on demand by
  `lody review`.
- `prompts/review-helper-agent.md` is the prompt handed to arbitrary agents.
