# site-docs/scripts

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `site-docs/AGENTS.md` also apply.

- `site-paths.mjs` enumerates prerender paths for docs/blog/changelog and is the one
  path source. `generate-sitemap.mjs` writes `public/sitemap.xml` from it.
- `generate-docs-search.mjs` writes the bilingual, browser-side docs index to
  `public/docs-search.json`. Docs search stays local and must not depend on a runtime
  API or hosted search service.
- `generate-llms.mjs` validates docs title/description frontmatter and generates root
  `public/llms.txt` + `public/llms-full.txt` from the ordered English docs and public
  blog content. `llms.txt` also includes a short Answers section from
  `llms-answers.mjs`; every answer link must resolve to a current English docs path on
  this tree — do not invent pages that are still draft.
- `generate-docs-faq.mjs` extracts MDX `## FAQ` / `## 常见问题` sections into
  `lib/docs-faq.generated.ts` for FAQPage JSON-LD.
- `generate-rss.mjs` writes `public/rss.xml` (en) and `public/rss-zh.xml` (zh) from the
  same blog frontmatter, skipping drafts; both feeds are linked from every blog
  `head()`.
- `clean-output.mjs` runs in `prebuild`, before content generation. Keep it: stale
  Next/static prerender files in `out/` can create Vite preview redirect loops during
  TanStack prerender.
- `finalize-404-html.mjs` runs after prerender and strips app hydration from
  `404.html` so a junk URL cannot boot the client router and blank the page.
- `../lib/module-preload.ts` is the typed HTML-only `modulepreload` allowlist
  used by `vite.config.ts`. JS hosts keep every dependency so client nav still
  loads `pricing-*.css` / `legal-*.css`. The same href allowlist is copied in
  `finalize-prerender-html.mjs` so the post-prerender strip stays a plain
  Node script.
- `finalize-prerender-html.mjs` runs after prerender and strips non-critical
  `modulepreload` from every other HTML document so first paint does not compete
  with unused route chunks. Keep only the hydration runtime (entry / react /
  jsx-runtime / rolldown-runtime / preload-helper). Do not add the landing or
  docs chunks back onto every page. Landing HTML inlines `landing-first-paint.css`
  (final hero/nav layout, including `.rw-*` and `.site-nav__link` / theme
  controls) and applies the shared bundle after the first painted frame. Docs
  keep `index-*.css` render-blocking. A pricing or legal document keeps its own
  `pricing-*.css` / `legal-*.css` render-blocking; only leaked sibling sheets
  are deferred. Do not hide first-screen chrome and reveal it later.
- `generate:landing-agents` produces `components/landing-agents.generated.ts`; provider
  marks and the ACP wall must come from it rather than hand-written lists.
