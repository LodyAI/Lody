# Site-docs: share link vs live handoff

Status: implemented
Translation: current

English | [中文](2026-09-08-site-docs-share-link-vs-live-handoff.zh.md)

## Abstract

Search and sales conversations collapse “share my session” into one idea, so a screenshot, transcript, or share link is easy to treat as a teammate joining the live coding-agent session. The how-to already lives on `/docs/session-handoff`; this change adds a crawler-only compare page at `/docs/compare/share-link-vs-live-handoff` that owns the definition contrast, links back to handoff for steps and ACL, and emits FAQ / `llms.txt` answers. The title is category-level, not a competitor name. The page is omitted from the docs sidebar so humans keep Features for product guides.

## Problem

`session-handoff.mdx` already has a comparison table that mentions Lore and SpecStory. That page is the permission and how-to SSOT. Expanding it further would bury the definition, while a competitor-titled URL ages if those products rebrand or later offer true live join. GEO questions such as “is a share link a handoff?” still need an answer block that can link a current English docs path.

## Decision

- Add `content/docs/{en,zh}/compare/share-link-vs-live-handoff.mdx`. Do not list `compare` in root or Features `meta.json`, so the page stays out of the sidebar while sitemap / search / `llms.txt` still emit `/docs/compare/share-link-vs-live-handoff`.
- Keep every access rule identical to `session-handoff.mdx`: workspace membership, machine sharing, local project sharing, and “URL copy ≠ Share with team…”. Do not invent a public share-link ACL.
- Put Lore and SpecStory in one table row as examples of the share-link / archive category. Do not put a competitor name in the H1 or document title. Do not add benchmarks or a replacement claim.
- Point handoff, team, parallel-agents, copy-md, and the existing handoff blog at the compare page. Add a dedicated `llms-answers.mjs` question plus a link from the existing handoff answer.

Rejected: a Features sidebar entry; a `lody-vs-lore` title or slug; putting the contrast only on the blog; restating the full four-step how-to on the compare page.

## Limits

Share-link product details are limited to what the existing Lody docs already state plus their public share/docs URLs. If a named example later offers true live-session join, revise the table row rather than stretching it. Sibling compare PRs share `generate-llms.mjs` extras listing and `llms-answers.mjs`; merge order will need a rebase of those files.
