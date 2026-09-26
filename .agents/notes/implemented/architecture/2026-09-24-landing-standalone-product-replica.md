# Landing product demo as a standalone replica

Status: implemented
Translation: current

[中文](2026-09-24-landing-standalone-product-replica.zh.md)

## Abstract

The public landing's product demo rendered the app's real components through an
`@/*` alias into `packages/components`. That made every app change a possible
landing outage: the most recent one (#937) blanked the whole stage because a
composer hook needed the app's authenticated Convex provider. The demo is now a
purpose-built, display-only replica owned by `site-docs`: components take demo
data as props, import nothing from the app, and a test fails if that boundary is
crossed again. The cost is that the landing no longer follows the app
automatically; its look is copied, and must be re-copied when the app's look
moves far enough to misrepresent it.

## Problem

- The landing mounted the real desktop shell, session list, composer, ai-gui
  conversation renderer, diff viewer, mobile home, and usage/PR views. To make
  them run on a public static site it needed about a dozen Vite aliases to
  site-side shims, a `forceSingletonDeps` plugin against React 18/19 dual loads,
  a Loro Wasm build plugin, a hand-written `types/lody-app-components.d.ts`
  (TypeScript's only view of the imports), a jotai store seeded with fake
  runtime/agent/machine atoms, and a private i18n instance.
- Breakages were silent: the preview renders inside `OptionalEnhancement`, so a
  crash removes the stage while everything else stays green. A stale declaration
  once dropped `DesktopSessionDetailLayout`'s top bar and panel with typecheck
  green; #937 was a composer hook that required Convex.
- The coupling also cost bytes. With the stage mounted, the landing downloaded
  about 5.3 MB of JS (uncompressed), a 2.3 MB CRDT Wasm file, a PostHog analytics
  chunk, and a 515 KB shared CSS bundle, because Tailwind scanned all of
  `packages/components/src` for every public page.

## Decision

- `site-docs/components/landing-replica/` holds display-only replicas of exactly
  the states the feature-tab scripts reach. The frame is `inert`, so no menu,
  popover, hover, or unreachable session was carried over. Three scripted
  conversations (font-size plan, roadmap feedback, mobile keyboard) and the
  permission prompt could never be opened and were dropped.
- Each replica copies the app's markup and class strings for the landing's
  render path. Shared primitives (`cn`, `Button`, brand and file glyphs) are
  copied into the folder; `clsx` and `tailwind-merge` are direct dependencies so
  copied class overrides resolve as they do in the app. The diff uses
  `@pierre/diffs` directly, a public npm package the app also uses.
- `landing-app-preview.tsx` keeps the ghost-cursor scripts and their DOM hooks;
  demo copy and conversations moved to `landing-preview-data.ts`. The no-op
  Ken-Burns camera and layout persistence were removed.
- The `use-sync-external-store` aliases survive, moved to `lib/`: Base UI and
  TanStack Router import that CJS shim too, and the dev server cannot serve it as
  ESM. They were never preview-only.
- Removed: `app-preview-shims/`, the `@/*` alias and shim aliases,
  `forceSingletonDeps`, the Loro browser plugin, `types/lody-app-components.d.ts`,
  the `@source` scan of `packages/components`, preview-only CSS (Radix portal
  palettes, focus-camera variables), and the `@lody/components`, `@lody/shared`,
  jotai, i18next, and react-i18next dependencies.
- `scripts/app-boundary.mjs`, run by the site's `test`, fails on `@/*`,
  `@lody/components`, or `@lody/shared` imports, on a build input that points at
  `packages/components/src`, and on those dependencies in `package.json`.

## Alternatives

- **Copy the dependency closure verbatim.** The landing's transitive graph was
  771 `packages/components` modules (about 99k lines) plus 110 `@lody/shared`
  modules. A fork that size would still need the shims and providers, would
  drift immediately, and would carry the same crash surface. Rejected.
- **Screen recordings.** Robust against app changes, but the stage must follow
  the site's light/dark theme and locale, the ghost scripts react to layout, and
  video would add weight and lose crisp text. Rejected.
- **Keep reusing app components with better shims.** That is what #937 did; it
  fixes one hook at a time and leaves the landing one app refactor away from the
  next blank stage. Kept only as the stop-gap that #937 shipped.

## Evidence

- Screenshots before and after (1600×1000, 1280×800, and 390×844 viewports; en
  and zh; light and dark; timed moments of all four demos, their reduced-motion
  end states, and the power section) differ only in scroll offsets and the
  intended fixes below. Pixel-difference ratios per shot stayed under 5%, mostly
  from the animated WebGL background.
- Intended visible changes: strings the old demo i18n lacked are now translated
  (for example zh "已完成工作", "搜索", "可合并"); the composer shows real placeholder
  copy instead of the untranslated `composer.promptPlaceholder.compact` key; the
  run-config chip shows the Codex mark instead of a fallback Bot icon; merged PR
  glyphs are purple as in the app; selected local-project rows use the app's
  selection colour; the mobile sheet prompt wraps instead of clipping.
- Production static build, Chrome at 1600×1000, uncompressed bytes fetched from
  the local static host. Landing with the stage mounted: JS 5.26 MB → 2.16 MB,
  CSS 544 KB → 299 KB, Wasm 2.26 MB → none. A docs page: JS 1.22 MB → 1.20 MB,
  CSS 538 KB → 299 KB (the shared sheet no longer carries the app's utilities).
  `/price/`: JS 1.18 MB → 1.16 MB, CSS 538 KB → 299 KB.
- `test:static` passes all 282 cases, including `landing app preview mounts` on
  `/` and `/zh`; `app-boundary.test.mjs` detects each forbidden import form in a
  fixture tree.

## Limits

- The replica is a copy. It will not show future app changes until someone
  copies them, and nothing detects that drift; the recorded shape lives in
  `.agents/docs/site-landing-and-marketing.md`.
- The power usage frame is interactive (manual scroll, range tabs, day
  breakdown); its charts are hand-drawn SVG approximations of the app's Recharts
  output, and their hover tooltips are not reproduced.
- `scripts/generate-landing-agents.mjs` still reads the app's agent icon assets
  at generation time; the output is a committed, site-owned file.

Related: [#937 stop-gap](../bug-fix/2026-09-24-landing-app-preview-mention-expansion.md).
