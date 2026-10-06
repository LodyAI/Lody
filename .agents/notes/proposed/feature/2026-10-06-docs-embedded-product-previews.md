# Live product previews in the docs

Status: proposed
Translation: current
Language: [中文](2026-10-06-docs-embedded-product-previews.zh.md)

## Abstract

Docs screenshots age faster than the UI they describe: the Sessions page still
showed the old multi-line session list, and the GitHub page showed an old home
composer, long after both surfaces changed. This change adds site-owned,
display-only previews under `components/docs-replica/`, renders them from
synthetic mock data in both locales and themes, registers `SessionListPreview`
and `GithubRepoPickerPreview` in the docs MDX components, and replaces the stale
screenshots; the archive and delete screenshots stay because they still match.
The replicas copy app markup rather than import app components, so they can still
drift and must be re-copied when the app's look changes materially.

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
- The app components cannot be imported into the site: the standalone replica
  rule and `scripts/app-boundary.mjs` keep app-only modules, providers, and
  packages out of the public build.

## Decision

- Add `components/docs-replica/session-list-preview.tsx` and
  `components/docs-replica/github-repo-picker-preview.tsx`, display-only replicas
  copied from the app's current session-list and composer-selector markup. Each
  takes only `locale`, builds synthetic mock content, and imports no app code.
- Render them inside the existing `.lody-app-preview` token scope so they follow
  the site's light/dark theme.
- Register them in `components/mdx.tsx` as `SessionListPreview` and
  `GithubRepoPickerPreview`, replace the `<img>` usages on the English and Chinese
  Sessions and GitHub pages, and delete the two now-unused assets.
- Model only the states a static page can hold: the current one-line session row
  with the session info card beside it, and the current repository and branch
  pickers above a composer box. The session card carries repository, worktree
  branch, machine, PR state, CI verdict, and ±line totals; the composer preview
  carries a repository, branch, prompt placeholder, run configuration, and
  permission scope.
- Keep the archive and delete screenshots; they still match and are out of scope.

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

## Verification and limits

- `pnpm --filter @lody/site-docs generate`, `typecheck`, and `test` pass,
  including `scripts/app-boundary.mjs`.
- A production build prerenders every published page. The preview markup is
  present in the prerendered English and Chinese Sessions and GitHub pages, and
  both removed screenshot assets are gone.
- Both previews were checked visually in English and Chinese, light and dark, at
  desktop and mobile widths.
- The full static browser suite reports 307 passing cases (309 before the two
  removed VS Code themes pages) and the same two baseline mobile
  `no-js navigation` timeouts before and after the change.
- The replicas copy markup at a point in time; they do not follow app changes.
  Re-copy each one when its surface changes materially, and update the docs copy
  with it.
- Two surfaces were converted. Other docs screenshots (archive, delete, agent
  config, diff, and so on) remain and can be converted one surface at a time.
