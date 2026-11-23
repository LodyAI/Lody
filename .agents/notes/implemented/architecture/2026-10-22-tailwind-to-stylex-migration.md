# Tailwind to StyleX migration

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)

[中文](2026-10-22-tailwind-to-stylex-migration.zh.md)

## Abstract

Shared product UI uses local StyleX and typed primitive composition. The Electron renderer and review helper no longer depend on the Tailwind compiler. The public documentation site is outside this migration. Compilation alone does not establish visual compatibility.

The subsequent [design-system convergence](2026-11-07-design-system-convergence.md) intentionally replaces preserved legacy opacity and material overrides; its new appearance checks are separate from migration equivalence.

## Ownership and composition

The [product style layer](../../../../packages/components/src/style/README.md) owns application colors and scales; the [migration guide](../../../../packages/components/src/style/MIGRATION.md) owns the detailed composition and compatibility contract. Components keep local `stylex.create` declarations and share only repeated area styles in adjacent surfaces. Semantic primitive props remain the normal design API.

Actual callers that need physical overrides use typed `xstyle` or named part inputs. The primitive composes them with its defaults in one StyleX expression and forwards dynamic variables and existing style callbacks. An omitted input preserves the original behavior. Native integration markers, third-party stylesheets and fonts may remain ordinary CSS; they are not a substitute utility engine.

The former declaration bridge, declaration profile, Vite plugin and dedicated tests were removed, together with their Vite, Storybook, Vitest and Electron wiring. They retained Tailwind's ordering engine and were not the migration endpoint. The [bridge decision](2026-10-31-stylex-cascade-compatibility.md) is historical, not permission to restore that architecture.

Product CSS has no Tailwind/Konsta/animation-package imports, compiler directives or private `--tw-*` state. Licensed browser normalization lives in `src/tailwind/reset.css`; ordinary scale defaults and native safe areas live in `theme-defaults.css`. The historical directory/export names do not load a compiler. Storybook's temporary fixture stylesheet and compiler plugin are removed, together with the unused shared preset and compiler-backed inventory tool. Electron's Tailwind plugin/config/dependencies and component runtime CVA/Konsta/merging dependencies are removed. The review helper's independent pipeline is also retired.
