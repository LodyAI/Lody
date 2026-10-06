# Live product previews in the docs

Status: proposed
Translation: current
Language: [中文](2026-10-06-docs-embedded-product-previews.zh.md)

## Abstract

Docs screenshots age faster than the UI they describe: the Sessions page still
showed the old multi-line session list with inline branch and diff metadata long
after the app moved that metadata into a hover card. This change adds a
site-owned, display-only preview under `components/docs-replica/`, renders it
from synthetic mock data in both locales and themes, registers it as
`SessionListPreview`, and replaces the stale session-list screenshot; the archive
and delete screenshots stay because they still match. The replica is copied
markup, not the app components, so it can still drift and must be re-copied when
the app's look changes materially.

## Problem

- Docs images are static and dated. The session-list screenshot had already
  become wrong: it showed multi-line rows with branch and diff inline, while the
  app renders one-line rows and moves that metadata into the session info hover
  card.
- A screenshot cannot follow the reader's light/dark theme, so a dark image can
  sit inside a light docs page.
- Every UI change needs a fresh capture committed as a raster asset, and a miss
  ships silently.
- The app components cannot be imported into the site: the standalone replica
  rule and `scripts/app-boundary.mjs` keep app-only modules, providers, and
  packages out of the public build.

## Decision

- Add `components/docs-replica/session-list-preview.tsx`, a display-only replica
  copied from the app's current `session-list.tsx` markup and classes. It takes
  only `locale`, builds synthetic rows, and imports no app code.
- Render it inside the existing `.lody-app-preview` token scope so it follows the
  site's light/dark theme.
- Register it in `components/mdx.tsx` as `SessionListPreview`, replace the
  `<img src="/_docs-assets/session-list.png" />` usages in the English and Chinese
  Sessions pages, and delete the now-unused asset.
- Model the current one-line session row and show the session info card as an
  in-place panel beside the list, because a static docs page cannot reproduce the
  app's hover behavior. The card carries the repository, worktree branch,
  machine, PR state, CI verdict, and ±line totals the surrounding copy promises.
- Keep the archive and delete screenshots; they still match and are out of scope.

## Alternatives considered

1. Keep the screenshot and re-capture it. Rejected: the same drift and theme
   mismatch return on the next UI change.
2. Import the real app components with shims, as the landing once did. Rejected:
   that is the coupling the standalone replica note removed;
   `scripts/app-boundary.mjs` fails the build for it, and app hooks or providers
   would blank the docs surface.
3. Render an interactive replica with hover behavior. Rejected for now: a static
   illustration keeps the prerendered HTML deterministic and the accessibility
   surface small. A later docs page can add interaction if it needs it.
4. Build a generic preview framework before the second use. Rejected: one
   component plus the shared token scope proves the pattern; extract shared
   machinery only when a second preview exists.

## Verification and limits

- `pnpm --filter @lody/site-docs generate`, `typecheck`, and `test` pass (28
  tests), including `scripts/app-boundary.mjs`.
- A production build prerenders 257 HTML pages. The preview markup is present in
  the prerendered English and Chinese Sessions pages, and the removed paragraph
  text and asset are gone.
- The preview was checked visually in English and Chinese, light and dark, at
  desktop and mobile widths.
- The full static browser suite reports 309 passing cases and the same two
  baseline mobile `no-js navigation` timeouts before and after the change.
- The replica copies markup at a point in time; it does not follow app changes.
  Re-copy it when the session list changes materially, and update the docs copy
  with it.
- Only the session-list image was replaced. Other docs screenshots (archive,
  delete, agent config, diff, and so on) remain and can be converted one surface
  at a time.
