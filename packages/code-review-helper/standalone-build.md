# Standalone single-file viewer (`lody review`)

The standalone build produces ONE self-contained HTML file that renders a review
over `file://` with no server. It backs `lody review <file>.review.md` (CLI) and
`review-helper export --format html`.

## Pipeline (`pnpm build:standalone`)

1. `vite build --config vite.standalone.config.ts` bundles `standalone.html` +
   `src/standalone/main.tsx` and inlines all JS/CSS into one HTML via
   `vite-plugin-singlefile` → `dist-standalone/standalone.html` (no review data; it
   has a `<!--LODY_REVIEW_DATA-->` placeholder in `<head>`).
2. `scripts/embed-standalone.mjs` reads `prompts/review-helper-agent.md` and writes
   the plain-string TS module `dist-standalone/embedded-prompt.ts` (`reviewPrompt`).

`dist-standalone/` is gitignored and regenerated. The `build` script runs
`build:standalone`, so `pnpm -r build` (topological) builds it before dependents.

## Style extraction and single-file output

The renderer, Storybook, standalone bundle and Vitest share
[`stylex-options.ts`](stylex-options.ts). Local StyleX blocks read the helper's
own element-local CSS variables; this host does not import product UI or palette
aliases. Its CSS layer order is `theme, base, stylex, components, utilities`.

| Styling contract                 | Owner                                                           | Verification                                                                        |
| -------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Owned layout and semantic values | Renderer-local StyleX blocks and element-local helper variables | Real Storybook and standalone frames, complete computed records and caller controls |
| Public Slot cascade              | Original utility path in local controls                         | Native/Slot and raw exported-selector cases                                         |
| Legacy property registration     | `src/react/styles.css`                                          | Full generated CSS and default/initial/inherit writer states                        |

The literal composer font is stored on its textarea in a private custom property.
A direct StyleX `system-ui` declaration is expanded by the locked Lightning CSS
postprocessor for its Android target, unlike the original Tailwind literal. Keep
this local value independent of the ancestor font variable; changing compiler
targets would affect unrelated styles. Direct writes to the new private property
are outside the component API.

Annotation markers use their own literal font property for the same compiler
reason; numeric feature writers and registrations remain part of the contract.
Inherited typography candidates that change offscreen color or scroll geometry
are rejected even when default frames match. The last-resort fallback is exercised
through an actual React render error and ErrorBoundary, including real reload and
return to a valid review. Its existing unlayered `.crh-shell` owns viewport minimum
height; do not add an ineffectual StyleX duplicate underneath it. Caught errors
are expected in this fixture, not a zero-console-error claim.

When the last consuming utility disappears, Tailwind can prune its `@property`
registration and compatibility initialization. The stylesheet explicitly retains
the original `--tw-space-y-reverse` registration and fallback. Compare full computed
values under default, utility, initial, inherit and vertical-writing states; equal
normal-state PNGs did not detect the rejected pruning regression.

The standalone config keeps StyleX source transforms in the pre phase, then
runs that same plugin instance's `generateBundle` hook in a post companion
immediately before `viteSingleFile()`. Vite emits CSS after pre plugins. Running
extraction there originally left the rules in an unreferenced `stylex.css` after
the inliner had consumed the CSS assets, despite a successful build and correct
Storybook rendering. Keeping the shared plugin closure preserves its injection
state and avoids the unused-sidecar fallback.

Verify the emitted HTML through `file://` with a synthetic review injected by
`injectReviewSnapshot`. Check that migrated rules are inside its actual inline
stylesheet, that no external stylesheet is required, and that painted layout,
reference navigation and findings match the unchanged standalone baseline.
Storybook screenshots alone cannot establish the single-file contract.

## How the viewer reaches the CLI

The ~8 MB `standalone.html` is NOT bundled into `lody`. The sibling package
`lody-code-review-viewer` copies it verbatim and publishes it publicly; `lody review`
downloads it from jsDelivr at the pinned version, sha256-verifies, and caches it (see
`packages/code-review-viewer` + the CLI's `src/lib/review-viewer.ts`). Only the small
agent prompt is embedded in the CLI.

## Why a string module for the prompt (not `?raw`)

The `lody` CLI uses an esbuild bundle in development and a Vite SSR bundle in
production. Neither resolves Vite's `?raw` here, and published `lody` ships only
`dist/` (no access to this package's data files). A plain TS string module imports
cleanly in both; the CLI lazy-imports `@lody/code-review-helper/prompt-text` inside the
command action.

## Highlighting

The viewer selects Highlights when `canUseWASM()` succeeds, otherwise `shiki-js`.
The shared VS Code adapter registers both Zed and TextMate theme formats. WASM is
embedded in the Highlights JavaScript module, so the single-file viewer needs no
network fetch for its lexer. Token boundaries may differ from Shiki. Coq, Lean,
Fish and Nginx lexer compatibility remains unresolved.

## Shiki fallback size control

`@pierre/diffs` loads grammars via `bundledLanguages[lang]()`, and shiki's real
`bundledLanguages` maps ALL 383 grammars (each a `() => import()`), which singlefile
would inline (~12 MB). `vite.standalone.config.ts` has a `resolveId` plugin that
redirects shiki's `dist/langs.mjs` → `src/standalone/curated-shiki-langs.ts` (a
curated ~40-lang map, identical `() => import('@shikijs/langs/<id>')` loaders, plus a
Proxy that returns an empty plaintext grammar for non-curated langs so nothing throws)
and `dist/themes.mjs` → `src/standalone/curated-shiki-themes.ts` (empty: the viewer
registers its own Vesper-derived theme, never a bundled-by-name theme). The Highlights migration build is about 11.3 MB uncompressed. To highlight more languages, add canonical ids (+ their real aliases) to
`curated-shiki-langs.ts`; behavior for a curated id is identical to the full build.

`injectReviewSnapshot` (`src/standalone/inject.ts`) splices the snapshot into the
template ahead of the module script (JSON `<`-escaped so review text can't break out).
`src/standalone/main.tsx` reads `window.__LODY_REVIEW__` and renders `ReviewRenderer`
inside `CodeReviewThemeProvider` — the same wrapper Storybook's preview decorator uses,
so the generated HTML and Storybook stay identical. The Lody mark (icon + "Lody Review"
title) is baked into `ReviewRenderer`'s sidebar, not passed in.
