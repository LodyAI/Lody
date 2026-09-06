# site-docs

The public Lody site: TanStack Start + Vite + Fumadocs. It owns the marketing
landing, docs, blog, changelog, pricing, download, and legal/support pages, and
builds to `site-docs/out/client`. Binding rules live in
[`AGENTS.md`](AGENTS.md) and in each subdirectory's own `AGENTS.md`.

## Directory map

| Directory | Owns | Rules |
| --- | --- | --- |
| `app/` | CSS only: reading theme, landing, pricing | [`app/AGENTS.md`](app/AGENTS.md) |
| `components/` | Landing, marketing, and product-replica React components | [`components/AGENTS.md`](components/AGENTS.md) |
| `content/` | MDX SSOT for docs, blog, changelog, legal | [`content/AGENTS.md`](content/AGENTS.md) |
| `context/` | Landing demo sequencing and screenshot notes | — |
| `lib/` | Server-only content lookups, metadata, browser-safe helpers | [`lib/AGENTS.md`](lib/AGENTS.md) |
| `public/` | Static assets, `.well-known/`, generated SEO files | [`public/AGENTS.md`](public/AGENTS.md) |
| `scripts/` | Path enumeration and SEO/content generators | [`scripts/AGENTS.md`](scripts/AGENTS.md) |
| `src/` | Router, file routes, page adapters | [`src/AGENTS.md`](src/AGENTS.md) |
| `types/` | Hand-written declarations for `@/*` app components | — |

## Component responsibilities

- `components/landing.tsx` — landing copy, nav, and footer.
- `components/underwater-experience.tsx` — hero, in-flow product stage, and the
  post-demo stack (free scroll; no wheel lock). Styles in `app/underwater.css`.
- `components/underwater-background.tsx` — the three.js point-cloud scene and
  desktop cursor interaction.
- `components/landing-feature-tabs.tsx` — the onboarding indicator above the app
  (`.underwater-tabs`) with auto-advancing progress bars.
- `components/landing-app-preview.tsx` — the live product replica on the stage.
- `components/marketing-atmosphere.tsx` — the shared marketing ambient field,
  hosted once by `components/site-root-provider.tsx`.
- `components/pricing-page.tsx` — pricing table, plans, and FAQ.
- `components/app-preview-shims/` — build shims for modules that cannot run in the
  public-site bundle. `use-online-machines-shim.ts` is the machine source for
  `DesktopRunConfigMenu` (the real hook needs an installed platform); the preview
  seeds its `landingPreviewMachinesAtom` alongside `agentConfigMetaCacheAtom` in
  `previewStore`.

Demo sequencing and screenshot notes live in
[context/landing-demos.md](context/landing-demos.md). Measurements, history, and
the replicated session shell's current shape are in
[landing and marketing internals](../.agents/docs/site-landing-and-marketing.md).

## Changing landing visuals

Edit `components/underwater-background.tsx` (scene/shaders) and
`app/underwater.css` (layout/legibility); copy and CTA live in
`components/landing.tsx`. Every scene knob lives in one `PARAMS` object, and
`DEFAULT_PARAMS` is the shipped look. Open any page with `?tune` for a live slider
panel, then bake copied values into `DEFAULT_PARAMS`. Verify with
`pnpm --filter @lody/site-docs build` and a screenshot; WebGL renders in headless
Chromium. There is no second legacy site tree.

## Local development

The dev server runs on port 3002. Use
`pnpm --filter @lody/site-docs preview:static` to emulate the static host.
