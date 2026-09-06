# Repository Guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Scoped rules live in `app/`, `components/`, `content/`, `lib/`, `public/`,
`scripts/`, and `src/` — each has its own `AGENTS.md` and is read alongside this
file. The directory map, component responsibilities, and the landing visual
tuning shortcut are in [`README.md`](README.md).

## Invariants

- `site-docs/` is the current TanStack Start + Vite + Fumadocs public site. It
  owns the marketing landing, docs, blog, changelog, pricing, download, and
  legal/support pages. The dev server runs on port 3002. There is no second
  legacy site tree.
- Content SSOT for docs/blog/changelog/legal is `content/**`. Edit those MDX
  files directly. Public document images and compatibility files are tracked in
  `public/_docs-assets/` and `public/.well-known/`.
- Ordinary site HTTPS navigation must remain in the browser. The global head owns
  an app-id-only iOS Smart App Banner; never add an `app-argument`. The empty files
  in `public/.well-known/` deliberately revoke previously published iOS/Android
  app-link associations; keep them empty unless a public client explicitly owns
  and documents universal-link handling.

## Marketing shell (pricing / download / changelog)

- These pages use `marketing-shell`: ice ink, restrained aqua, **seamless nav**
  (gradient fade — no frosted bar / hard divider), `--mkt-panel-*` frosted panels on the
  shared ~208 navy-teal atmosphere hue. Light and dark are both supported.
- Ambient field: `components/marketing-atmosphere.tsx` — one fixed full-screen WebGL fragment
  shader with `uTheme` (tracks `html.dark`), mid-density caustics, dpr≤1.5, paused on
  hidden tab / reduced-motion; CSS gradient fallback until ready. Texture allocation
  failure must retain the direct 30fps renderer. Do not fold the two gradient taps
  feeding `ridge` into a cheaper finite difference — they look redundant but carry the
  filigree. Do not lower temporal texture resolution or shader quality as a performance
  shortcut.
- The field is **hosted once** via `MarketingAtmosphereHost` in `site-root-provider`
  (price / download / changelog share one GL context; off-route pauses without teardown).
- Pricing content lives in `components/pricing-page.tsx` + `app/pricing.css` (Vue-ported table +
  plans + FAQ). **Public Plus yearly is fixed early-bird**: `$5`/seat/mo (`$60`/yr) with
  regular `$8` strike-through; monthly `$10`. No `Date.now()` / env gate. The offer's end
  date is **one line of static copy** — folded into `promoDiscount` in both locales,
  deliberately not repeated in the yearly note or an FAQ. When it passes, edit that
  string; do not reintroduce a clock. Billing toggle animates via `@number-flow/react`
  (digit odometer) plus CSS height/opacity for promo banner, strike-through reference,
  and note swap.
- Marketing pages (landing/pricing/changelog/download) must stay on `--landing-*` /
  `--mkt-*` and reference no `fd-` token — check that before moving a component between
  marketing and reading (blog/docs) surfaces.

## Content pipeline and build

- Content is Fumadocs MDX; `fumadocs-mdx` generates `.source/`. Content-tree rules
  live in [`content/AGENTS.md`](content/AGENTS.md) and generator ownership in
  [`scripts/AGENTS.md`](scripts/AGENTS.md).
- The deployed site has no runtime server, so every content `createServerFn`
  must use `staticFunctionMiddleware`; client navigation reads the prerendered
  `__tsr/staticServerFnCache` output instead of calling a server endpoint.
- Root `public/robots.txt` is owned here; the App build must not overwrite
  public-site SEO files.
- `prebuild` runs `scripts/clean-output.mjs` before content generation. Keep this:
  stale Next/static prerender files in `out/` can create Vite preview redirect
  loops during TanStack prerender. Downstream deployments that immediately run
  `build` may set `LODY_SKIP_SITE_DOCS_POSTINSTALL=1` to avoid generating the same
  content during install; never use the switch unless a later build/generate step
  is guaranteed.
- `vite.config.ts` is the build integration point. Keep TanStack Start, Fumadocs
  MDX, Tailwind, React, and preview-only aliases there. The deployable static
  build output is `site-docs/out/client`; do not publish the SSR server bundle.
- `src/routeTree.gen.ts`, `public/sitemap.xml`, `public/docs-search.json`, `public/llms.txt`,
  `public/llms-full.txt`, `public/rss.xml`, `public/rss-zh.xml`,
  `lib/blog-reading-time.generated.ts`, and `lib/docs-faq.generated.ts` are
  generated and ignored. `pretypecheck` runs `tsr generate`; `generate` writes
  the SEO files. Do not edit or format the generated route tree or generated
  public SEO files.

## SEO and routing contracts

- SEO lives in `lib/metadata.ts` and TanStack route `head()` functions. Docs,
  blog, changelog, and pricing `head()` titles go through `brandTitle` so they
  get `| Lody`; landing/download titles already include the brand and must not be
  double-suffixed. Visible `DocsTitle` stays unbranded.
- Canonical page URLs should match Cloudflare Pages' directory form (`/`, `/zh/`,
  `/docs/.../`, `/zh/docs/.../`); file URLs keep their extension. `/home` and
  `/zh/home` are compatibility routes and should stay `noindex,follow`.
- Unmatched URLs must not SPA-fallback to the homepage: prerender `/404` to
  `out/client/404.html` (Cloudflare Pages serves that file with HTTP 404). The 404
  document is `noindex,follow` and must not canonicalize to `/`. Do not add a Vite
  `configurePreviewServer` 404 interceptor — TanStack prerender uses that
  preview server to fetch pages that do not exist on disk yet. Use
  `pnpm --filter @lody/site-docs preview:static` to emulate the static host.
- Docs pages that have an MDX `## FAQ` / `## 常见问题` section emit FAQPage
  JSON-LD through `pageHead` (`lib/docs-faq.ts`); do not duplicate that FAQ copy
  in a second catalog.

## Workspace component reuse

- The public site imports real workspace components through the `@/*` alias to
  `packages/components/src`. Exact aliases in `vite.config.ts` redirect app-only
  modules to `components/app-preview-shims/`. A `forceSingletonDeps` Vite plugin
  re-resolves `react` / `react-dom` / `i18next` / `react-i18next` / `next-themes`
  / `jotai` from this app (React 19) — `packages/components` still peers React 18,
  and without that force SSR can dual-load React (invalid hook / useContext null).
  Keep `next-themes` as a direct dependency (fumadocs re-exports `useTheme`
  from it; bare transitive resolution fails under pnpm).
- Keep the optional R3F usage calendar behind `StatsSettingsView`'s lazy boundary
  rather than importing its leaf directly into the landing graph. The workspace
  pins R3F 9 for React 19, and the landing may opt into the real skyline by passing
  calendar/timeline data without moving it into the initial hydration path.
- `types/lody-app-components.d.ts` is hand-written and TypeScript's ONLY view of
  every `@/*` import (there is no tsconfig path to `packages/components/src`), so a
  stale declaration silently hides a real API break. When an app component changes,
  update its declaration there in the same change, and verify the landing in a
  browser; typecheck alone cannot catch this class of drift. The failure that
  proved it is recorded in
  [landing and marketing internals](../.agents/docs/site-landing-and-marketing.md).
