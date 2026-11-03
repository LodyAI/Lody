# Tailwind to StyleX migration

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[中文](2026-10-22-tailwind-to-stylex-migration.zh.md)

## Abstract

Lody's shared product UI now uses direct StyleX instead of a Tailwind declaration bridge. The Electron renderer and standalone review helper no longer use the Tailwind build plugin or runtime class-merging dependencies. Component owners compose actual caller styles through narrow typed inputs, preserving effective layout, themes and interaction states. Storybook still compiles unmigrated fixtures separately; real screenshot differences and unvisited states remain open. Successful compilation or a zero literal count does not establish completion.

## Ownership and composition

The [product style layer](../../../../packages/components/src/style/README.md) owns application colors and scales; the [migration guide](../../../../packages/components/src/style/MIGRATION.md) owns the detailed composition and capture contract. Components keep local `stylex.create` declarations and share only repeated area styles in adjacent surfaces. Semantic primitive props remain the normal design API.

Actual callers that need physical overrides use typed `xstyle` or named part inputs. The primitive composes them with its defaults in one StyleX expression and forwards dynamic variables and existing style callbacks. An omitted input preserves the original behavior. Native integration markers, third-party stylesheets and fonts may remain ordinary CSS; they are not a substitute utility engine.

The former declaration bridge, declaration profile, Vite plugin and dedicated tests were removed, together with their Vite, Storybook, Vitest and Electron wiring. They retained Tailwind's ordering engine and were not the migration endpoint. The [bridge decision](2026-10-31-stylex-cascade-compatibility.md) is historical, not permission to restore that architecture.

Product CSS has no Tailwind/Konsta/animation-package imports, compiler directives or private `--tw-*` state. Licensed browser normalization lives in `src/tailwind/reset.css`; ordinary scale defaults and native safe areas live in `theme-defaults.css`. The historical directory/export names do not load a compiler. Only `.storybook/legacy-stories.css` retains fixture compilation. Electron's Tailwind plugin/config/dependencies and component runtime CVA/Konsta/merging dependencies are removed. The review helper's independent pipeline is also retired.

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

The scanner validates AST-discovered candidates against the remaining fixture compiler input. Version 3 also follows class-named status-map properties and parameter defaults. An independent all-string audit remains necessary: earlier zero counts missed actual PR/Goal maps and settings-dialog caps. Counts are lower bounds, not completion percentages or runtime coverage.

The recorded v3 continuation snapshot has 4,103 occurrences across 160 files and 757 unresolved expressions: 4,101 in stories and two `text-modified-file` occurrences backed by an ordinary authored CSS rule. Product and review-helper compiler retirement does not imply all fixtures or states are accepted. Continue fixture conversion, Slot/caller audits, pending production qualification and unresolved visual diagnosis; preserve unrelated working changes.

The inventory is scoped to shared product sources and their fixtures. `site-docs` owns a separate Fumadocs/Tailwind pipeline and requires its own baseline and migration; it is not silently counted as removed. Isolated ACP demo/editor applications remain outside this UI task and require no submodule operations.

Earlier counts, interim decisions and rejected experiments are retained in frozen artifacts and the [prior committed note](https://github.com/LodyAI/Lody/blob/11390b40320b01a8f5807850de65a011253cedda/.agents/notes/implemented/architecture/2026-10-22-tailwind-to-stylex-migration.md). They qualify history; they do not override the current ownership or close old visual failures.
