# @lody/code-review-helper

Standalone local code-review renderer and agent prompt package.

## Invariants

- This package is independent from Lody session, Code Collab, workspace runtime,
  Convex, i18n, and `@lody/components` business UI.
- Git state is read only. The CLI may run `git show`, `git diff`, `git rev-parse`,
  and serve a local Vite viewer, but it must not mutate the reviewed repository.
- `.review.md` line references use original merge-base/current source line numbers;
  comments and notes stay anchored to those numbers.
- Rendering shows the WHOLE file diff per `change` file (one view per file per group):
  multiple `changes://<same file>?new=...` blocks in a group are merged into one block
  with their ranges cleared and notes concatenated (`mergeDiffBlocksByPath`). The
  `new=Lx-Ly` ranges on `changes://` blocks no longer crop the diff — they only anchor
  notes. @pierre/diffs collapses unchanged regions with an expand affordance, so
  reviewers can open surrounding context and never miss off-range changes. (Do NOT
  re-introduce per-range hunk cropping: pierre's single-hunk-empty-side path indexes
  line arrays absolutely and crashes on cropped new-file hunks.)
- `context://path?range=Lx-Ly` blocks may reference files that did not change in the
  reviewed range. They are rendered as read-only context snippets (current commit
  version, range plus surrounding lines) and may carry `new://` notes.
- `line_budget` is a soft guideline. Groups should be semantically coherent; they may
  be much smaller or larger than the budget.
- Two note homes: cross-cutting `P0`/`P1`/`P2` conclusions go in the top `## Review`
  section (`document.findings`, path-qualified refs like `new://<path>:Lx-Ly`), rendered
  as chips that jump the diff plus light line markers; single-spot `QUESTION`/`INFO` stay
  as inline notes on the preceding block. Ref colon may be ASCII or fullwidth `：`; parser
  maps legacy `ERROR`→`P0`, `WARNING`→`P1`. Right panel is static (no scroll/dim).
- User comments are local-only in v1 and stored in browser `localStorage`; export is
  copied Markdown, not GitHub submission.
- A standalone single-file HTML viewer (no server, opens over `file://`) backs
  `lody review` and `review-helper export --format html`. Build + the shiki
  size-control trick are documented in [standalone-build.md](standalone-build.md).
  The Lody mark (sidebar icon `src/assets/lody-icon.png` + "Lody Review" title) lives
  inside `ReviewRenderer`, so Storybook and the generated HTML render identically (both
  wrap it in `CodeReviewThemeProvider`). The built `dist-standalone/standalone.html` is NOT embedded in the
  `lody` CLI — it is republished by the sibling `lody-code-review-viewer` package and
  fetched on demand (see that package). Only the agent prompt is embedded via
  `build:prompt-text` + the stable `.d.ts` export `./prompt-text` (do not import
  generated `dist-standalone/*` from source typecheck paths).
- Theming: the renderer now uses the same VSCode-theme adaptation as
  `@lody/components`. `CodeReviewThemeProvider` resolves the bundled Vesper theme and
  applies its CSS variables to `documentElement`; the diff viewer registers a matching
  Vesper-derived TextMate and Zed themes. When embedded in Lody the host already injects the same
  token names, so the provider can be omitted. Token names stay HSL channels and are
  aliased to the components names where they differ (`--sidebar` ->
  `--sidebar-background`, `--github-addition` -> `--status-success`, etc.).
  `ReviewRenderer` still sets `.dark` on its root wrapper, but that class now only
  toggles `color-scheme`; all semantic color tokens come from the active VSCode theme
  so that Vesper's amber primary / neutral surfaces are used end-to-end. Keep the
  palette restrained — semantic color is reserved for diagnostics and over-budget.

## File Responsibilities

Per-file responsibilities live in
[context/file-responsibilities.md](context/file-responsibilities.md). The single-file
viewer build + shiki size-control are in [standalone-build.md](standalone-build.md).
