# Documentation information architecture

Status: implemented
Translation: current
Language: [中文](2026-10-01-docs-information-architecture.zh.md)

## Abstract

The public docs had grown into one flat 30-item "Features" list ordered by release history, so new
readers had no ramp and experienced Codex or Claude Code users had no migration entry. The docs now
group the tree by reader path (Getting Started, Core Concepts, Guides, Coming from another agent,
Feature List), add a first-session tutorial, a concepts and glossary page, and a migration page, and
keep every existing docs URL stable because only parenthesized virtual groups moved. The
[Spec](../../../../specs/docs-information-architecture.md) stays draft, native-speaker review of both
languages did not happen, and the overlap between `quota` and `usage-and-quota` is still open.

## Problem

- `index.mdx` read as a changelog: a list of new capabilities with no audience routing.
- `Features` was a flat list of 30 pages; `image-input`, `copy-md`, and `session-handoff` had equal
  sidebar weight, and the list grew by append.
- Getting Started ended before the first complete session; `workflow` jumped straight to parallel
  worktrees and a PR loop.
- `session-orchestration`, `agent-collaboration`, `parallel-agents`, and `session-handoff` formed a
  naming cluster with no page explaining which one to use.
- Four content pages had zero inbound content links; most pages had no prerequisites or next step.

## Decision

- Follow the reader-path groups and page contract of the draft Spec
  [documentation information architecture](../../../../specs/docs-information-architecture.md).
- Move existing pages only between parenthesized virtual groups, so every published URL is
  unchanged.
- Add three entry-path pages: `(getting-started)/first-session`, `(core-concepts)/concepts`, and
  `(migrating)/from-codex-claude-code`, in both languages.
- Rewrite `index.mdx` as an audience map and move `workflow` from Getting Started into Guides.
- Split `Features` into `(guides)` (task-oriented) and `(reference)` (capability-oriented, with four
  subgroups).
- Add a "Which page do I need?" callout to the `session-orchestration` and `agent-collaboration`
  cluster, and point Quick Start at the new entry pages.

## Alternatives considered

1. Keep the flat `Features` list and only append new pages. Rejected: it does not fix navigation
   and keeps growing the same way.
2. Move pages into real, non-parenthesized directories. Rejected: it changes every published URL and
   the site has no redirect layer.
3. Rewrite every page to the new page contract in this change. Rejected as too large to review;
   the contract applies to future edits and to the pages touched here.

## Verification and limits

- Nested `(reference)/(...)` groups and all four subgroups render in both locales, and each new
  and moved page appears at its published URL. A filtered install cannot build site-docs until a full
  workspace install supplies the hoisted `tw-animate-css` that `app/global.css` imports.
- The upstream revert removed the unintended `/coding-agent-gui` and `/coding-agent-remote-control`
  pages with their routes, footer/nav links and docs links; the docs index keeps one `Daemon Mode`
  anchor link for the upstream query/fragment browser checks.
- URL stability is confirmed against the merged build output, not only by convention: every
  pre-change docs slug still exists under `out/client`, and the three new docs pages are present in
  both locales. The only removed site paths are the two upstream-reverted marketing pages.
- The static browser suite's mobile `no-js navigation` cases for `/` and `/zh` timed out before
  and after this change; that failure was not investigated here.
- `quota` remains a separate reference page rather than being merged or removed, because removing a
  slug needs a redirect decision. The overlap with `usage-and-quota` is still open.
- English and Chinese were written together, but neither was reviewed by a native speaker.
