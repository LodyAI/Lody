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
- `generate:landing-agents` produces `components/landing-agents.generated.ts`; provider
  marks and the ACP wall must come from it rather than hand-written lists.
