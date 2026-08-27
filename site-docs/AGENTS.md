# Repository Guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Invariants

- `site-docs/` is the current TanStack Start + Vite + Fumadocs public site. It
  owns the marketing landing, docs, blog, changelog, pricing, download, and
  legal/support pages. The dev server runs on port 3002.
- Content SSOT for docs/blog/changelog/legal is `content/**`. Edit these MDX
  files directly. Public document images and compatibility files are tracked in
  `public/_docs-assets/` and `public/.well-known/`.
- Ordinary site HTTPS navigation must remain in the browser. The global head owns
  an app-id-only iOS Smart App Banner; never add an `app-argument`. The empty files
  in `public/.well-known/` deliberately revoke previously published iOS/Android
  app-link associations; keep them empty unless a public client explicitly owns
  and documents universal-link handling.
- Pricing / download / changelog use `marketing-shell` (deep-ocean field matching
  homepage dark): ice ink, restrained aqua, **seamless nav** (gradient fade —
  no frosted bar / hard divider). Surfaces share atmosphere hue (~208 navy-teal)
  via `--mkt-panel-*` frosted panels. Light/dark both supported: light = shallow
  water (landing pale blue) + dark ink; dark = abyss + ice ink. Ambient field:
  `components/marketing-atmosphere.tsx` — one fixed full-screen WebGL fragment
  shader with `uTheme` (tracks `html.dark`), mid-density caustics, dpr≤1.5,
  **capped at 30fps**, paused on hidden tab / reduced-motion; CSS gradient
  fallback until ready. It is an expensive pass (~445 `sin()` per pixel; the four
  `warped()` calls are ~77% of it) — the two gradient taps feeding `ridge` look
  redundant but carry the filigree, so do not fold them into a cheaper
  finite difference. Frame rate and dpr are the safe knobs.
  **Hosted once** via `MarketingAtmosphereHost` in `site-root-provider` (price /
  download / changelog share one GL context; off-route pauses without teardown).
  Pricing content lives in
  `components/pricing-page.tsx` + `app/pricing.css` (Vue-ported table + plans +
  FAQ). **Public Plus yearly is fixed early-bird**: `$5`/seat/mo (`$60`/yr) with
  regular `$8` strike-through; monthly `$10`. No `Date.now()` / env gate.
  Billing toggle animates via `@number-flow/react` (digit odometer) plus CSS
  height/opacity for promo banner, strike-through reference, and note swap.
- Framework boundary files live under `src/`: `src/router.tsx`,
  `src/routes/__root.tsx`, file routes in `src/routes/**`, and shared route/page
  adapters in `src/site-pages/**`. Do not add new route logic under `app/`;
  `app/` is now CSS-only.
- Content is Fumadocs MDX. `fumadocs-mdx` generates `.source/`, and
  `scripts/site-paths.mjs` enumerates prerender paths for docs/blog/changelog.
  Docs under `content/docs/{en,zh}` use matching Fumadocs folder groups such as
  `(sessions)/` and `(agents-and-cli)/`. Keep both locale trees and every
  folder's `meta.json` in sync. Parenthesized group names are intentional: they
  provide physical/sidebar hierarchy without changing established docs URLs.
  The deployed site has no runtime server, so every content `createServerFn`
  must use `staticFunctionMiddleware`; client navigation reads the prerendered
  `__tsr/staticServerFnCache` output instead of calling a server endpoint.
  `scripts/generate-sitemap.mjs` writes `public/sitemap.xml` from the same path
  source. `scripts/generate-llms.mjs` validates docs title/description
  frontmatter and generates root `public/llms.txt` + `public/llms-full.txt` from
  the ordered English docs and public blog content. `scripts/generate-rss.mjs`
  writes `public/rss.xml` (en) and `public/rss-zh.xml` (zh) from the same blog
  frontmatter, skipping drafts; both feeds are linked from every blog `head()`.
  Root `public/robots.txt` is also owned here; the App build must not overwrite
  public-site SEO files.
- `prebuild` runs `scripts/clean-output.mjs` before content generation. Keep this:
  stale Next/static prerender files in `out/` can create Vite preview redirect
  loops during TanStack prerender. Downstream deployments that immediately run
  `build` may set `LODY_SKIP_SITE_DOCS_POSTINSTALL=1` to avoid generating the same
  content during install; never use the switch unless a later build/generate step
  is guaranteed.
- `app/reading-theme.css` owns the dark **reading** palette (`--ink-*`) shared by
  blog and docs, and is the single source of truth for both: `blog.css` maps the
  `--landing-*` tokens onto it and the same file remaps Fumadocs' `--color-fd-*`.
  It exists because the stock grounds (marketing `222 55% 9.6%`, Fumadocs ocean
  `220 60% 8%`) are too saturated for long-form reading. It also cancels the
  ocean preset's `.dark body` blue glow. Light mode intentionally keeps stock
  values. Marketing pages (landing/pricing/changelog/download) must stay on
  `--landing-*` / `--mkt-*` and reference no `fd-` token, which is what keeps
  this override off them — check that before moving a component between them.
- SEO lives in `lib/metadata.ts` and TanStack route `head()` functions. Canonical
  page URLs should match Cloudflare Pages' directory form (`/`, `/zh/`,
  `/docs/.../`, `/zh/docs/.../`); file URLs keep their extension. `/home` and
  `/zh/home` are compatibility routes and should stay `noindex,follow`.
- `vite.config.ts` is the build integration point. Keep TanStack Start, Fumadocs
  MDX, Tailwind, React, and preview-only aliases there. The deployable static
  build output is `site-docs/out/client`; do not publish the SSR server bundle.
- `src/routeTree.gen.ts`, `public/sitemap.xml`, `public/llms.txt`,
  `public/llms-full.txt`, `public/rss.xml`, and `public/rss-zh.xml` are
  generated and ignored. `pretypecheck` runs `tsr generate`; `generate` writes
  the SEO files. Do not edit or format the generated route tree or generated
  public SEO files.
- The public site imports real workspace components through the `@/*` alias to
  `packages/components/src`. Exact aliases in `vite.config.ts` redirect app-only
  modules to `components/app-preview-shims/`. A `forceSingletonDeps` Vite plugin
  re-resolves `react` / `react-dom` / `i18next` / `react-i18next` / `next-themes`
  / `jotai` from this app (React 19) — `packages/components` still peers React 18,
  and without that force SSR can dual-load React (invalid hook / useContext null).
  Keep `next-themes` as a direct dependency (fumadocs re-exports `useTheme`
  from it; bare transitive resolution fails under pnpm).
  Keep the optional R3F usage calendar behind `StatsSettingsView`'s lazy boundary
  rather than importing its leaf directly into the landing graph. The workspace
  pins R3F 9 for React 19, and the landing may opt into the real skyline by passing
  calendar/timeline data without moving it into the initial hydration path.
- The marketing landing (`/`, `/home`, `/zh`, `/zh/home`) is an immersive WebGL
  "underwater point-cloud" hero. `components/landing.tsx` owns copy/nav/footer and
  mounts `components/underwater-experience.tsx`, which renders
  `components/underwater-background.tsx` (`UnderwaterPointCloudBackground`, raw
  three.js, no R3F).
- Page order: hero → product demo stage (in-flow) → post-demo stack (team collab
  → bring-your-own subscriptions → agent fan-out
  (`landing-orchestration-section.tsx`: short claim + tags, no diagram) →
  CLI control plane (`landing-cli-section.tsx`: scripts/CI/integration +
  terminal) → power features → mobile/Dynamic Island → closing CTA → footer.
  No bottom ACP section / built-in runtime matrix. The ACP logo marquee now
  lives INLINE inside subscriptions (the "any coding agent that speaks ACP"
  wall), not as a bottom footer strip. CTA platform
  detection lives in `landing-cta-section.tsx` (iOS → App Store; desktop →
  updates.lody.ai; Android → APK). Product demos are an ordinary in-flow section
  (tabs + `LandingAppPreview`). Desktop (fine pointer): a light downward nudge on
  the hero spring-scrolls to the stage; past that, free scroll. Touch / mobile:
  free document scroll only (no auto-spring, no Scroll chevron). Preview frame is
  `pointer-events: none` so nested chat/scroll UI cannot trap wheel/touch — only
  feature tabs are clickable. Hero is 100dvh on all breakpoints so the product
  demo never peeks on first paint. The desktop scroll hint keeps its localized
  label and animated chevron visually centered in equal-height boxes. No CSS
  scroll-snap. The power-section usage frame accepts native manual scrolling and preserves default scroll chaining so
  reaching either boundary returns the wheel/touch gesture to the document. It
  rotates ranges only when visible, so number/chart transitions do not create
  permanent background work. Document scroll drives only the display-only PR
  frame's internal progress, starting once half of the frame is visible and using
  eased ends. The usage preview must define the complete `--chart-1` through
  `--chart-5` palette inside its isolated theme scope; otherwise heatmap cells or
  later donut segments resolve to transparent backgrounds. Its narrow 7-day
  matrix also keeps dot height coupled to the final constrained width so the
  24-column layout cannot stretch circles into capsules.
- Demo sequencing and screenshot notes live in
  [context/landing-demos.md](context/landing-demos.md).
  Dynamic Island is **not** simulated in the play stage — real device media in
  `landing-mobile-deep-section.tsx` only.
- No scroll dive: hero + demo stage + post-demo are ordinary flow; point-cloud
  camera stays static (`diveRef` always 0). Portrait framing pan is **width-only**
  (`framingPanX`); never re-derive pan from live aspect — Safari chrome
  show/hide thrash would re-frame mid-scroll. `.underwater-bg` uses `100lvh`
  (not `inset:0`/`100dvh`) so the canvas height does not resize with the URL
  bar. Demos unlock once (first stage reach / intersect) and stay mounted —
  scroll must not null `demo` or remount ghost scripts. Off-screen, tab fill
  freezes via `animation-play-state` only. Ghost pointer: `scrollIntoView`
  no-op + `focus({preventScroll})` while demos run; `ghostEnabled` false when
  stage &lt; ~55% visible so clicks/drags stop.
- Feature carousel: `landing-feature-tabs.tsx` auto-advances over
  worktree / diff / design / mobile; each drives `LandingAppPreview` `demo`.
  Ghost scripts must not call `focus()` (browser scrollIntoView yanks the page);
  use `clickQuiet` and controlled state for typing. Details in
  [context/landing-demos.md](context/landing-demos.md).
- `landing-agents-section.tsx` (count lockup + built-in runtime matrix) stays an
  unmounted reference component. `landing-agent-banner.tsx` IS mounted: the
  subscriptions section renders it with the `inline` prop as the ACP logo wall
  (`.uw-agents__banner--inline` drops the legacy absolute footer positioning).
  Both provider marks and the wall come from `landing-agents.generated.ts`
  (`pnpm --filter @lody/site-docs generate:landing-agents`).
- `underwater-background.tsx` is client-only three.js in `useEffect`. Startup is
  deliberately staged — keep all three legs when touching it: (1)
  `underwater-experience.tsx` loads it via module-eval `import()` + `lazy` so
  three.js stays out of the landing's critical chunk (CSS gradient on
  `.underwater-bg` covers until mount; keep it in sync with the BG shader); (2)
  the initial seabed attributes are computed in `underwater-terrain.worker.ts`
  (pure math shared via `underwater-terrain-math.ts`, one regular height grid
  for normals instead of 4 extra noise samples per point) and fade in via the
  terrain `uReveal` uniform, while gradient/particles/jellyfish render
  immediately; (3) first render waits on `renderer.compileAsync` (`ready` gate)
  so shader compilation never blocks the main thread. Tune/downgrade rebuilds
  stay synchronous on the main thread.
- `landing-app-preview.tsx` is the live product mock for the center stage, and the
  landing's heaviest module (real product UI + composer/markdown/katex behind it).
  `underwater-experience.tsx` mounts it via `lazy()` — deliberately NOT module-eval
  `import()` like the background, so hero + WebGL keep first-paint bandwidth. The
  `previewArmed` latch fires one viewport ahead (idle fallback for non-scrollers)
  and never flips back, so the frame is filled before arrival and ghost scripts
  never remount. Tab durations + the demo id union live in
  `landing-demo-durations.ts`; importing them from the preview would pull it back
  into the critical chunk. The stage frame carries `aria-hidden` + `inert` — the
  replica is `pointer-events: none`, but its real buttons/session rows otherwise
  stayed in the a11y tree and tab order.
  `landing-control-plane.tsx` remains an unmounted reference component on disk.
- The desktop session shell must track `packages/components/src/components/sessions`
  1:1 — read that directory's `AGENTS.md` before touching it. Current shape:
  ONE merged top row (`SessionTabBar` `mt-0.5 h-11` + a right-slot toolbar; NO
  repo-title header row and NO header PR badge), the real `SessionInfoBar` glued
  above the composer (repo/branch/PR/±diff/actions + the emerald Browser chip),
  and ONE floating right-panel card (`mx-2 mt-2 mb-2 rounded-xl border-sidebar-border/80
bg-sidebar`) whose `SessionSidePanelTabBar` carries Files / All Changes /
  conditional PR + Browser plus closeable diff tabs — file and diff viewers live
  in that panel, never in a second pane. That panel starts CLOSED
  (`DEFAULT_SIDE_PANEL_STATE.open === false` in
  `lib/session-detail-initial-state.ts`); only a demo that scripts the toggle opens
  it. The composer has NO bottom bar: machine → project → branch/worktree pill in
  the top row, `DesktopRunConfigMenu` + `DesktopPermissionModeButton` in the footer
  (mobile keeps the single `MobileSessionRunConfig`).
- The desktop CHAT LANDING has no Local/GitHub/Chat `ContextSwitch` any more. One
  `UnifiedProjectSelector` lists local projects and GitHub repos together and the
  context type is DERIVED from the selection (clearing it is the plain-chat
  context); the preview uses the platform-independent `UnifiedProjectSelectorView`. Its
  heading is the app's rotating `chat.heading` / `chat.heading2` copy.
- The mobile session shell is `session-detail.tsx`'s `if (isMobile)` branch, not a
  narrow desktop: a floating frosted `BaseHeader` over the conversation, glass
  chrome, no `SessionTabBar`, no header PR badge, and the bottom `SessionInfoBar`
  with `branch={null}`. Details + the new-chat sheet's slot stack are in
  [context/landing-demos.md](context/landing-demos.md).
- `types/lody-app-components.d.ts` is hand-written and TypeScript's ONLY view of
  every `@/*` import (there is no tsconfig path to `packages/components/src`), so a
  stale declaration silently hides a real API break — `DesktopSessionDetailLayout`
  once rendered with none of its props and the whole top bar + right panel
  vanished while `pnpm typecheck` stayed green. When an app component changes,
  update its declaration here in the same change, and verify the landing in a
  browser; typecheck alone cannot catch this class of drift.

## Responsibility Split

- `src/routes/**` maps URLs to TanStack routes. Keep route files thin: define
  `createFileRoute`, `loader`, `head`, and component wiring only.
- `src/site-pages/<domain>.tsx` adapts reusable page components to TanStack
  loaders/head — one module per domain (`landing`, `docs`, `blog`, `changelog`,
  `pricing`, `download`, `legal`, `not-found`). Do not reintroduce a barrel that
  re-exports them: every route file imports this layer, so a barrel puts the docs
  layout, blog, changelog and pricing on the landing's chunk. `SiteNotFound` has
  its own module for the same reason — `__root.tsx` is on every page.
  `src/site-pages/shared.ts` holds `SiteLocale`, `localeCode` and the route-data
  types and must stay free of page-component imports. Do not import
  `.source/server` from these client-shared modules.
- `lib/docs.server.ts` is the server-only docs lookup layer for Fumadocs page
  metadata/tree/toc. Docs route files call it through `src/docs-loader.ts`, and
  `src/site-pages/docs.tsx` renders MDX through `.source/browser` client loaders.
- `lib/blog.server.ts` and `lib/changelog.server.ts` are the server-only
  Fumadocs lookup layers for those collections. `lib/blog.ts` and
  `lib/changelog.ts` must stay browser-safe: types, formatting, and pure
  normalization helpers only.
- `lib/metadata.ts` creates canonical, alternate/hreflang, Open Graph, Twitter,
  robots, and article metadata records for TanStack `head()`.
- `lib/source.ts` exposes generated docs content for server-only loaders. Do not
  import it from route components, shared page components, or browser-safe code.
- Public docs assets under `public/_docs-assets/` are source files and should be referenced as URLs
  with `<img src="/_docs-assets/name.png" />`. Do not use Markdown image syntax
  in `content/`; Vite will treat it as a JS import from `public/`.
- `components/underwater-experience.tsx` owns hero + in-flow product stage +
  post-demo stack (free scroll; no wheel lock). Styles in `app/underwater.css`.
  Feature demos: [context/landing-demos.md](context/landing-demos.md).
- `components/landing-feature-tabs.tsx` is the onboarding indicator above the app
  (`.underwater-tabs`) with auto-advancing progress bars.
- `components/underwater-background.tsx` owns the three.js point-cloud scene and
  desktop cursor interaction.
- `components/app-preview-shims/` contains build shims for modules that cannot run
  in the public-site bundle. `use-online-machines-shim.ts` is the machine source
  for `DesktopRunConfigMenu` (the real hook needs an installed platform); the preview seeds its
  `landingPreviewMachinesAtom` alongside `agentConfigMetaCacheAtom` in
  `previewStore`.

## Expensive Shortcut

To change landing visuals, edit `components/underwater-background.tsx`
(scene/shaders) and `app/underwater.css` (layout/legibility); copy/CTA live in
`components/landing.tsx`. Every scene knob lives in one `PARAMS` object;
`DEFAULT_PARAMS` is the shipped look. Open any page with `?tune` for a live slider
panel, then bake copied values into `DEFAULT_PARAMS`. Verify with
`pnpm --filter @lody/site-docs build` and a screenshot; WebGL renders in headless
Chromium. There is no second legacy site tree.
