# Preserve public content when client initialization fails

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/677

[中文](2026-09-13-public-site-static-hydration.zh.md)

## Abstract

Public landing, blog, and documentation pages already ship prerendered HTML, but
failed route imports could replace it with a framework error screen. Client
startup now prepares matched routes and article modules before React owns the
document; failed preparation retains static content and metadata. Optional
landing effects contain their rendering failures, and native mobile navigation
works without JavaScript. The real production build passed 258 browser cases;
production deployment and search reindexing remain unverified.

## Decision

Keep enumerated static prerendering. Request-time SSR alone would not prevent
client rendering from overwriting HTML. The [draft Spec](../../../../specs/public-site-static-content.md)
defines direct visits in both locales and the intentional loss of JavaScript
interactions when initialization cannot finish.

The custom client entry awaits `hydrateStart`, then synchronously invalidates
matched routes to run their loaders, including Fumadocs MDX preloads. Hydrated
server loader data alone does not populate browser article caches. This adds an
initial loader pass, including reads of generated static server-function caches.
TanStack lazy component preloads swallow import rejections, so the preparation
guard also observes Vite preload errors before deciding to hydrate. Ordinary
links remain usable when the original static document is retained.

The landing background, product demo, and marketing atmosphere have local error
boundaries. A failed background retains its gradient; an optional demo may vanish
without replacing surrounding content. No bot detection, duplicate SEO copy,
DOM snapshot restoration, or reload loop is introduced. Arbitrary exceptions
after successful hydration and client navigation recovery remain outside this change.

## Additional defects found by real browser validation

The mobile menu required React to open. It now uses native `details`/`summary`,
while React adds Escape dismissal and scroll locking; opening it before hydration
preserves the open state. The Chinese local-project page linked to a nonexistent
`cli.html`; it now links to the published CLI route and its verified heading anchor.
Featured blog cards nested author links inside the card link, causing React hydration
error #418 in both locales. Authors inside the card are now non-link text; article
bylines retain their links.

## Validation and limits

An independent full clone with the working changes, frozen-lockfile dependencies,
and required ACP submodules produced all 218 prerendered pages. Building
`acp-extension-core` explicitly was necessary because dependency installation skipped
scripts. One earlier local prerender run hit ECONNRESET; an unchanged retry and the
final complete build both passed.

The repeatable `site-docs/scripts/verify-static-browser.mjs` suite serves the actual
production output over HTTP, blocks external requests, and passed 258 Chromium cases:

- 216 published pages with JavaScript disabled: visible headings and body, article
  content, title, description, canonical, language, structured data and internal
  static link targets; plus two unknown-route HTTP 404/noindex checks.
- 30 healthy/fault cases across ten English/Chinese landing, documentation and blog
  routes: working theme changes and no uncaught page errors when healthy; unchanged
  static body and metadata when real route chunks, article chunks or generated
  static server-function data fail.
- Ten navigation cases: desktop/mobile no-JS journeys through docs and blog articles,
  healthy mobile dismissal/navigation, mobile navigation after route failure,
  opening the native menu before hydration, and the repaired Chinese CLI anchor.

An additional run of all 30 healthy/fault cases passed with stronger React document
ownership assertions: healthy startup owns the document, failed preparation never
hydrates it. Tests wait for observable navigation, guard completion and DOM state,
without fixed sleeps. JSON reports and screenshots are emitted under
`site-docs/out/static-verification/`. Site TypeScript checking, all 43 existing site
tests and the public repository boundary check also passed. The earlier synthetic
fixture additionally exercised optional component render failures; those failures
were not injected into the complete production site.

The pre-commit root `pnpm check` was attempted in the site-focused dependency
installation but stopped in `acp-extension-claude` compilation: SDK packages and
TypeScript globals were unavailable. This is not a passing full-repository check.

No production deployment was performed. This verifies local Chromium and static-host
behavior, not Google reindexing, production CDN behavior, every interactive widget
without JS, or arbitrary errors after successful hydration. The original crawler
resource request failure's cause and historical search-result title remain unconfirmed.
