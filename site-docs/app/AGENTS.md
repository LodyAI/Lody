# site-docs/app

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `site-docs/AGENTS.md` also apply.

- `app/` is CSS-only. Do not add route logic here; framework boundary files live under
  `src/` (see [`../src/AGENTS.md`](../src/AGENTS.md)).
- `reading-theme.css` owns the dark **reading** palette (`--ink-*`) shared by blog and
  docs, and is the single source of truth for both: `blog.css` maps the `--landing-*`
  tokens onto it and the same file remaps Fumadocs' `--color-fd-*`. It exists because
  the stock grounds (marketing `222 55% 9.6%`, Fumadocs ocean `220 60% 8%`) are too
  saturated for long-form reading. It also cancels the ocean preset's `.dark body` blue
  glow. Light mode intentionally keeps stock values.
- Marketing pages (landing/pricing/changelog/download) must stay on `--landing-*` /
  `--mkt-*` and reference no `fd-` token, which is what keeps the reading override off
  them — check that before moving a component between marketing and reading surfaces.
- `underwater.css` owns landing layout/legibility; `pricing.css` owns the pricing page.
- `landing-first-paint.css` is the inlined first-screen sheet (`finalize-prerender-html.mjs`).
  Keep it system-font-only and visually identical to the final hero/nav layout,
  background, and type in `underwater.css` / `site-nav.css` (dark default).
  Include the final hero/nav chrome: `.rw-*`, nav links/theme/toggle fill,
  landing nav surface, dark overlay, `.underwater-btn__icon`, dark lead
  treatment, and the desktop scroll hint (hidden ≤768px). Deferred CSS must
  not restyle that chrome; only WebGL / chevron motion may start later.
