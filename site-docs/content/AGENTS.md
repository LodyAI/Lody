# site-docs/content

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `site-docs/AGENTS.md` also apply.

- This tree is the content SSOT for docs, blog, changelog, and legal pages. Edit
  these MDX files directly; the site renders them through Fumadocs MDX.
- Docs under `content/docs/{en,zh}` use matching Fumadocs folder groups such as
  `(sessions)/` and `(agents-and-cli)/`. Keep both locale trees and every folder's
  `meta.json` in sync. Parenthesized group names are intentional: they provide
  physical/sidebar hierarchy without changing established docs URLs.
- Reference public document images as URLs, `<img src="/_docs-assets/name.png" />`.
  Do not use Markdown image syntax here; Vite will treat it as a JS import from
  `public/`.
- `scripts/generate-llms.mjs` validates docs title/description frontmatter, so every
  docs page needs both.
- A docs page with an MDX `## FAQ` / `## 常见问题` section emits FAQPage JSON-LD
  automatically. Do not duplicate that FAQ copy in a second catalog.
- Blog frontmatter drives the RSS feeds and `llms.txt`; drafts are skipped.
