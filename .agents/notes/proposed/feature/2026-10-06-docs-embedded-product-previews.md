# Live product previews in the docs

Status: proposed
Translation: current
Language: [中文](2026-10-06-docs-embedded-product-previews.zh.md)

## Abstract

Docs screenshots age faster than the UI they describe. This change first added
site-owned, display-only previews under `components/docs-replica/` for the
Sessions and GitHub pages, then converted every Feature List / reference screenshot
in both locales to registered previews. The previews render from synthetic mock
data, follow the reader's locale and light/dark theme, and are registered in
`components/mdx.tsx`. Their `.lody-app-preview` token scope mirrors the live
Lody Light and Vesper deep-sea palettes after the `@lody/ui` product mapping,
so the static copy matches the app instead of the old Tailwind defaults. Browser
and OS notification chrome are modeled as site-owned visual replicas because they
are not Lody components. The replicas copy app markup rather than import app
components, so they can still drift and must be re-copied when the app's look
changes materially.

## Problem

- Docs images are static and dated. The session-list screenshot had already
  become wrong: it showed multi-line rows with branch and diff inline, while the
  app renders one-line rows and moves that metadata into the session info hover
  card. The GitHub page still showed an old home composer with the pre-update
  heading.
- A screenshot cannot follow the reader's light/dark theme, so a dark image can
  sit inside a light docs page.
- Every UI change needs a fresh capture committed as a raster asset, and a miss
  ships silently.
- The Feature List / reference pages repeated that problem across 19 image usages
  in each locale: conversation diff and files, mentions and slash commands, image
  input/output, Browser preview, Agent config and CLI runtimes, Fast/Goal/Ask
  cards, quota and token usage, plus browser and mobile notification chrome.
- The app components cannot be imported into the site: the standalone replica
  rule and `scripts/app-boundary.mjs` keep app-only modules, providers, and
  packages out of the public build.

## Decision

- Add `components/docs-replica/session-list-preview.tsx` and
  `components/docs-replica/github-repo-picker-preview.tsx`, display-only replicas
  copied from the app's current session-list and composer-selector markup. Each
  takes only `locale`, builds synthetic mock content, and imports no app code.
- Render them inside the existing `.lody-app-preview` token scope so they follow
  the site's light/dark theme. Keep that scope aligned with the app's runtime
  output: the light values are the resolved `lody-light` palette and the dark
  values are the resolved `vesper` deep-sea palette, including the VS Code alias
  and `@lody/ui` product-palette mapping.
- Register them in `components/mdx.tsx` as `SessionListPreview` and
  `GithubRepoPickerPreview`, replace the `<img>` usages on the English and Chinese
  Sessions and GitHub pages, and delete the two now-unused assets.
- Model only the states a static page can hold: the current one-line session row
  with the session info card beside it, and the current repository and branch
  pickers above a composer box. The session card carries repository, worktree
  branch, machine, PR state, CI verdict, and ±line totals; the composer preview
  carries a repository, branch, prompt placeholder, run configuration, and
  permission scope.
- Expand the same pattern to every Feature List / reference screenshot. Add
  `components/docs-replica/conversation-reference-previews.tsx`,
  `command-reference-previews.tsx`, `runtime-reference-previews.tsx`, and
  `settings-reference-previews.tsx`, using the live app component and the
  matching Storybook story as the copy source for each surface.
- Reuse the existing landing replicas where they already match the current
  component (`ReplicaDiffViewer`, `ReplicaChangesList`, composer controls,
  `ReplicaBrowserToolbar`); add only the missing display markup for file trees,
  mention/slash popups, image bubbles, Agent Config, quota, and usage.
- Replace every `_docs-assets` image reference in the English and Chinese
  `(reference)` trees. The image-output preview points at the tracked
  `/_docs-assets/logo-180.png` brand mark as its representative generated image,
  and the browser-permission and iOS-notification previews are explicitly
  site-owned mocks of external chrome, not imports of app components.
- Keep the docs aligned with the unified composer mention menu: the issue/PR
  preview now shows `@` opening the category list where Issues and Pull Requests
  live, the English and Chinese Mentions and GitHub core-concept pages describe
  the `@` flow, and the retired `_docs-assets/mention-issue.png` screenshot is
  deleted.
- Keep the archive and delete screenshots; they still match and are outside the
  Feature List scope.

## Alternatives considered

1. Keep the screenshots and re-capture them. Rejected: the same drift and theme
   mismatch return on the next UI change.
2. Import the real app components with shims, as the landing once did. Rejected:
   that is the coupling the standalone replica note removed;
   `scripts/app-boundary.mjs` fails the build for it, and app hooks or providers
   would blank the docs surface.
3. Render interactive replicas with hover cards and open menus. Rejected for now:
   a static illustration keeps the prerendered HTML deterministic and the
   accessibility surface small. A later docs page can add interaction if it needs
   it.
4. Build a generic preview framework before the second use. Rejected: the second
   preview reuses the same token scope and landing-replica primitives without new
   machinery; extract shared docs-preview scaffolding only at a third surface.
5. Capture the real app components through Storybook/Playwright, or embed a
   static Storybook build. Rejected: captures are still raster snapshots that
   drift, the Storybook server needs the full app provider/toolchain graph, and
   an iframe/static Storybook bundling would make docs content depend on
   JavaScript instead of remaining in the prerendered HTML.

## Verification and limits

- `pnpm --filter @lody/site-docs generate`, `typecheck`, and `test` pass; the
  test run includes `scripts/app-boundary.test.mjs` with three passing subtests.
  `node scripts/docs/main.mjs check` reports 0 errors and the existing 64
  warnings.
- A production build prerenders 257 HTML files. The Feature List English and
  Chinese pages contain the preview markup. The only `_docs-assets` reference
  under either `(reference)` tree is the tracked `/_docs-assets/logo-180.png`
  brand mark used as the image-output preview's representative generated image;
  no captured product screenshot is referenced.
- The new previews were checked visually in the rendered static pages in English
  and Chinese, light and dark themes, at desktop and mobile widths. The
  `.lody-app-preview` palette was refreshed to the current Lody Light/Vesper
  runtime channels and checked again in both themes.
- The full static browser suite reports 309 passing cases and the same two
  baseline mobile `no-js navigation` timeouts before and after the change.
- The replicas copy markup at a point in time; they do not follow app changes.
  Re-copy each one when its surface changes materially, and update the docs copy
  with it.
- The Feature List surfaces are converted, but the browser and iOS notification
  previews necessarily imitate external chrome rather than a Lody component.
  Other docs screenshots outside `(reference)` (changelog, guides, and the
  remaining core-concept surfaces) remain and can be converted one surface at a
  time.
