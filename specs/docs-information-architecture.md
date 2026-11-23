# Documentation information architecture

Status: draft
Translation: current

[中文](docs-information-architecture.zh.md)

A reader arriving at the public docs with a job to do — "I am new", "I already use Codex", "I lead
a team" — must be able to find a starting path without already knowing Lody's feature names.
Documentation is organized by the reader's task and stage, not by the order features shipped. The
existing pages remain the content; this contract governs where they live and how they link.

## Structure

Top-level docs groups under `content/docs/{en,zh}` express the reader's path:

| Group                     | Reader question                                   |
| ------------------------- | ------------------------------------------------- |
| Getting Started           | How do I install Lody and finish one session?     |
| Core Concepts             | What are the objects every screen assumes?        |
| Guides                    | How do I complete a real workflow end to end?     |
| Coming from another agent | I already use Codex or Claude Code; what changes? |
| Feature List              | What does this one capability do?                 |

Parenthesized folder names are virtual groups: they change sidebar hierarchy without changing
published URLs. The English and Chinese trees keep the same group names, page slugs, and
`meta.json` order. Adding or moving a page updates both locales and every affected `meta.json` in
the same change.

Pages that describe a repeatable, end-to-end task belong under `(guides)`. Pages that describe one
capability belong under `(reference)`, grouped by surface. The concept group holds only the small
mental model; it does not hold setup or feature pages.

## Page contract

Every published docs page:

- has `title` and `description`;
- opens with the reader's outcome and who the page is for;
- links prerequisites or a starting page before the steps;
- ends with a next step rather than a dead end;
- uses `## FAQ` / `## 常见问题` only for real questions, because that section emits FAQPage JSON-LD;
- prefers the registered rich MDX components over undifferentiated prose.

## Stable URLs

Moving a page between parenthesized groups or between locales must not change its published URL.
Renaming a slug is a redirect decision, not an editorial one; the site has no runtime redirect
layer, so a slug change requires an explicit compatibility decision first.

## Non-goals

This does not require rewriting every existing page, translating content that is already missing,
or guaranteeing feature parity across runtimes. It also does not make docs search, generated SEO
files, or FAQ JSON-LD the source of truth for the tree.

## Implementation evidence

- `site-docs/content/docs/{en,zh}/meta.json` and the group `meta.json` files.
- `site-docs/components/mdx.tsx` registers the rich MDX components.
- `site-docs/scripts/site-paths.mjs` flattens parenthesized groups into published URLs.
- `site-docs/scripts/generate-llms.mjs` follows `meta.json` order.
