# Tailwind to StyleX migration

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-10-22-tailwind-to-stylex-migration.zh.md)

## Abstract

Lody's shared product UI now uses direct StyleX instead of a Tailwind declaration bridge. The Electron renderer and standalone review helper no longer use the Tailwind build plugin or runtime class-merging dependencies. Component owners compose actual caller styles through narrow typed inputs, preserving effective layout, themes and interaction states. Storybook fixtures are also migrated, and their temporary compiler input, shared preset and remaining component compiler dependencies are removed. Real screenshot differences and unvisited states remain open. Successful compilation or a zero literal count does not establish completion.

## Ownership and composition

The [product style layer](../../../../packages/components/src/style/README.md) owns application colors and scales; the [migration guide](../../../../packages/components/src/style/MIGRATION.md) owns the detailed composition and capture contract. Components keep local `stylex.create` declarations and share only repeated area styles in adjacent surfaces. Semantic primitive props remain the normal design API.

Actual callers that need physical overrides use typed `xstyle` or named part inputs. The primitive composes them with its defaults in one StyleX expression and forwards dynamic variables and existing style callbacks. An omitted input preserves the original behavior. Native integration markers, third-party stylesheets and fonts may remain ordinary CSS; they are not a substitute utility engine.

The former declaration bridge, declaration profile, Vite plugin and dedicated tests were removed, together with their Vite, Storybook, Vitest and Electron wiring. They retained Tailwind's ordering engine and were not the migration endpoint. The [bridge decision](2026-10-31-stylex-cascade-compatibility.md) is historical, not permission to restore that architecture.

Product CSS has no Tailwind/Konsta/animation-package imports, compiler directives or private `--tw-*` state. Licensed browser normalization lives in `src/tailwind/reset.css`; ordinary scale defaults and native safe areas live in `theme-defaults.css`. The historical directory/export names do not load a compiler. Storybook's temporary fixture stylesheet and compiler plugin are removed, together with the unused shared preset and compiler-backed inventory tool. Electron's Tailwind plugin/config/dependencies and component runtime CVA/Konsta/merging dependencies are removed. The review helper's independent pipeline is also retired.

## Decisions supported by browser evidence

- Preserve the effective original cascade. A formerly dead Mermaid `!my-5` became effective after direct conversion and changed 16px margins to 20px; removing the dead override restored the actual layout. Merged PR ink and Goal status maps require explicit StyleX styles, not inherited color or runtime utility strings.
- A conditional `default: null` can erase a primitive's resting property. Real checks exposed lost well shadows, placeholder colors, secondary fills, padding and pointer states. Keep the complete required state inside its owner rather than adding specificity patches.
- The locked compiler supports scoped descendant selectors. Markdown owns its tables, math and file-link rules directly; actual callers use part styles and the `flush` presentation option. Do not retain utilities merely because earlier notes said descendants were unsupported.
- Preserve logical margins and the block/child-margin model of `space-y`; changing it to flex/gap changes layout. The earlier full-build private-writer ordering failure was real, even when a standalone Babel probe passed. Direct styles now remove that private substrate rather than patching its compiler.
- Colors retain their actual HSL/color-mix expressions and subtree readers. Font family includes ligature behavior. Theme aliases resolve where declared: local palette/spacing overrides need the actual scope, not an assumed root alias. Partial `createTheme` can install unrelated defaults; the [theme/font decision](2026-11-03-stylex-font-writer-pair.md) and migration guide preserve the observed limits.
- A native JSX element may be a Slot or `render` child of a primitive. Moving its utilities to opaque StyleX classes can lose the old caller precedence. Migrate the actual parent composition boundary and inspect disabled, selected, hover and normal states. One-time source conversion tools must reject these boundaries until the real caller is resolved; per-declaration equality alone is insufficient.
- Hidden labels also have an effective box. A remaining Storybook `sr-only` class cleared the migrated label's inherited padding and changed 4×12 to 1×1. Its caller must use typed styles without introducing the originally ineffective zero-padding declaration.

The first renderer smoke completed navigation but failed visual acceptance: the root's `h-svh` marker had only an old-browser fallback, so modern Electron collapsed to content height. The root now owns `100svh` in StyleX. A semantic `workspace-viewport` hook serves the native fallback and devbar, and the real smoke collector checks viewport geometry. The rejected screenshot remains separate from the corrected seven-page/state capture.

## Validation and evidence limits

The current immutable Storybook checkpoint records an actual build exit zero and 2,302 unchanged source hashes. Its main product matrix contains 180 pairs: 176 PNG-exact and four OPEN. One OPEN is 1,482 raw pixels / 12 above the recorded threshold on two external story buttons; the others are 1/2/1 raw pixels. These are not collectively described as antialiasing. Three bounded control-readiness supplement pairs are exact but do not prove the cause of the original frames.

Twelve fixed-SMIL attachment pairs contain six exact and six OPEN frames; fixing SMIL time did not close the residual differences. Sixteen mention frames have identical pixels but a real hidden-label geometry failure in that checkpoint; the later caller correction is a separate qualification. The 24-pair / 1,932-node foundation comparison is a development CSS-isolation check, not a second production build. Zero-sized or transparent shadow-carrier removal is recorded as a raw CSS difference even when the PNG is identical.

The corrected actual OSS Electron renderer records 1,516 unchanged inputs and emits CSS without Tailwind private state or generator markers. Real isolated Electron captures cover onboarding, agent configuration, explore, local chat, and daily/weekly/monthly schedule interactions. Workspace dimensions match the 1284×786 viewport. These are after-only application captures, not an original whole-application baseline.

Component regression: 619 files / 6,197 tests passed. The UI checkpoint passed 25 files / 320 tests; the subsequent Select styling input has its owning behavior suite and type check. Typed UI lint and public-boundary checks pass. Root `pnpm check` remains blocked in the existing Codex ACP SDK export-resolution build before downstream checks; this migration does not modify or synchronize that subsystem. Test results remain tied to their source checkpoints.

Comparison provenance is part of acceptance. An independent audit found two earlier controls summaries reading Before-relative paths on both sides; their 36 pair references are INVALID. Original images and invalid summaries remain, and corrected comparisons read each side's own manifest, PNG and browser record. Source-provenance checks do not turn a differing image into a pass. The current self-contained `direct-stylex-acceptance.html` and `direct-*` records live under `packages/components/artifacts/visual/`; historical reports remain unchanged, including their OPEN failures.

## Remaining work

The final product v3 compiler snapshot scans 1,795 source files and finds zero recognized utilities, with 744 unresolved expressions. Its scanner, tests and compiler dependency were retired; exact inputs and JSON remain in ignored artifacts. The website's separate locked compiler snapshot finds zero utilities in 149 first-party files (70 components, 47 route/page files and 32 library files), with 39 component expressions unresolved. Producer review traced all 39 expressions to StyleX output, ordinary CSS states or semantic hooks, with no in-repository dynamic Tailwind found. These remain static lower bounds, not visual or arbitrary external runtime-string coverage.

Website first-party primitives and their actual callers now compose local StyleX. Runtime Tailwind merging and the animation utility dependency are removed. The legacy semantic stylesheet's 111 `@apply` clauses are ordinary declarations under their original selectors. Explicit data hooks preserve first-paint body layout, preview scroll locks, frame insets and heatmap dots. Automatic source scanning is off; static theme defaults preserve CSS variables read by StyleX.

The site owns its plugin configuration without importing product UI. Its SSR development document explicitly loads the official virtual CSS/runtime because it bypasses Vite HTML transforms. Production creates independent plugin instances per Vite environment and targets the shared index CSS: a shared SSR/client instance had left stale asset references, and that output remains rejected. Site StyleX follows utilities because CSSOM confirmed Fumadocs prose defaults also occupy that layer. Real owners and their callers migrate together; arbitrary opaque caller priority is not promised.

| Remaining boundary | Location | Required next step |
| --- | --- | --- |
| Fumadocs skin and typography compiler | `site-docs/app/global.css`, the two Tailwind build dependencies in `site-docs/package.json` | Upstream `fumadocs-ui/css/preset.css` declares explicit safelists and a typography plugin. Migrate that third-party skin separately or consume upstream precompiled styles; deleting its compiler breaks docs UI. Do not copy a global utility bank and call it StyleX. |
| Unqualified visual states | `direct-stylex-acceptance.html`, `site-stylex-migration.html` and their source records in ignored artifacts | Keep source checkpoints, failed candidates and OPEN differences inspectable. Successful subsets never close unrelated failures. |

The integrated site build produces 272 static HTML documents with valid CSS references; types and nine existing static navigation cases pass. The original mobile test selected a hidden navigation link; its failure remains, and the corrected locator selects actual blog content. The site report embeds 21 screenshot pairs by checkpoint. Three earlier development 404 pairs match pixels and recorded layout; Legal has only an After check. Missing CSS, list spacing, external borders, language-open, Spinner timing and asynchronous Diff frames remain recorded; their status is not replaced by source completion.

This is not a claim that the monorepo has no Tailwind dependency or that every migrated state passed visual acceptance. Isolated ACP demo/editor applications remain outside this UI task and require no submodule operations. Earlier counts and rejected experiments remain in frozen artifacts and the [prior committed note](https://github.com/LodyAI/Lody/blob/11390b40320b01a8f5807850de65a011253cedda/.agents/notes/implemented/architecture/2026-10-22-tailwind-to-stylex-migration.md).
