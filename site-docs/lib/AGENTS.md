# site-docs/lib

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `site-docs/AGENTS.md` also apply.

- `docs.server.ts` is the server-only docs lookup layer for Fumadocs page
  metadata/tree/toc. Route files reach it through `src/docs-loader.ts`.
- `blog.server.ts` and `changelog.server.ts` are the server-only Fumadocs lookup
  layers for those collections. `blog.ts` and `changelog.ts` must stay browser-safe:
  types, formatting, and pure normalization helpers only.
- `source.ts` exposes generated docs content for server-only loaders. Do not import it
  from route components, shared page components, or browser-safe code.
- `metadata.ts` creates canonical, alternate/hreflang, Open Graph, Twitter, robots, and
  article metadata records for TanStack `head()`.
- `docs-faq.ts` emits FAQPage JSON-LD through `pageHead`.
- `blog-reading-time.generated.ts` and `docs-faq.generated.ts` are generated and
  ignored. Do not edit or format them.
