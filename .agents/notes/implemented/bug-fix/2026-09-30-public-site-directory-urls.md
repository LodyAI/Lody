# Public page URLs use the static host's directory form

Status: implemented
Translation: current

[中文](2026-09-30-public-site-directory-urls.zh.md)

## Abstract

Versioned changelog slugs contain dots, so the old extension heuristic emitted
slashless sitemap, canonical, and language-alternate URLs even though the static
host redirects those pages to directory URLs. Ordinary internal links also emitted
slashless page paths. Page metadata and sitemap generation now explicitly handle
page URLs, while native anchors and the Fumadocs adapter normalize site-owned page
navigation consistently with the router. Assets, app paths, query strings, fragments,
and external destinations retain their existing meaning; no deployment is required
for the local regression checks, and live behavior changes only after publication.

## Decision and evidence

- `lib/site-url.mjs` shares URL handling between browser code and Node generators.
  `absolutePageUrl` operates on a URL already known to be a page, so a version or
  dotted title never becomes a file-extension guess. Metadata images use ordinary
  absolute URL resolution rather than page normalization.
- Mixed navigation uses `siteHref`: only public-site route families are normalized,
  and recognizable files remain files. The explicit site/app boundary in
  [the earlier navigation note](2026-09-14-docs-web-app-links-leave-the-spa.md) remains.
  A transparent `SiteAnchor` preserves native anchor behavior, handlers, and download
  attributes. Fumadocs continues client navigation for site pages, with native links
  for files and other destinations.
- TanStack Router uses `trailingSlash: 'always'`, so hydrated navigation does not
  strip the slash that canonical metadata and static links now expose.
- The defect is reproducible from published source: the two old URL helpers used
  `/\.[^/]+$/` to distinguish assets, misclassifying changelog slugs such as
  `20260929-0.102.0`. Sitemap generation previously retained this slashless URL.

Changing only the sitemap would leave contradictory canonical and alternate tags.
Rewriting only prerendered HTML would diverge from hydrated link rendering. Sharing
the render-time URL policy fixes both without changing content, hosting redirects,
or the existing static-content and performance architecture.

## Verification

Behavioral tests cover both changelog locales, canonical/alternate/Open Graph
agreement, asset images (including extensionless images), query/fragment preservation,
external/app/file links, idempotent normalization, and the complete generated sitemap.
The existing production browser scan additionally checks page and alternate URLs,
all internal page anchors, and real desktop/mobile navigation against the static output.

A site-only frozen install omits `tw-animate-css`, which the existing stylesheet
imports from the wider workspace. Local build verification therefore supplies its
locked version 1.4.0 without changing a manifest or the lockfile. Repository-wide
application checks require the unrelated workspace/submodule installation; these
are separate from the public-site checks.

Local results: all 54 site tests, site TypeScript checking, and production build
passed. An independent HTML scan passed for 246 sitemap URLs (20 dotted releases),
249 directory pages, and 8,594 internal anchors. Interactive Chromium verification
could not start because the execution environment disallows its local socket.
The repository document check reports only 62 links into uninitialized ACP
submodules; the root aggregate check stops in unrelated packages without their
workspace dependencies. These checks are not reported as passing.
