# Documentation information architecture

Status: proposed
Translation: current
Language: [中文](2026-10-01-docs-information-architecture.zh.md)

## Abstract

The public docs had grown into one flat 30-item "Features" list ordered by release history, so new
readers had no ramp and experienced Codex or Claude Code users had no migration entry. This proposal
groups the tree by reader path (Getting Started, Core Concepts, Guides, Coming from another agent,
Reference), adds a first-session tutorial, a concepts and glossary page, and a migration page, and
keeps every existing URL stable because only parenthesized virtual groups moved. The restructure is
written into content, the path-dependent tests are updated, and a production build, typecheck, unit
tests, and the static browser suite have now run; they add no new failures versus `HEAD`.

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

- Adopt the Spec [documentation information architecture](../../../../specs/docs-information-architecture.md)
  and its reader-path groups and page contract.
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

- Verified in the authoring worktree after an offline install (`pnpm --filter @lody/site-docs
  install --offline --frozen-lockfile`): `generate`, `tsc --noEmit`, and the package test suite
  (54 tests) pass, and a full `pnpm build` prerenders 259 HTML pages. The nested `(reference)/(...)`
  groups and all four subgroups render in both locales, and each new and moved page appears at its
  published URL. A filtered install cannot build site-docs until a full workspace install supplies
  the hoisted `tw-animate-css` that `app/global.css` imports.
- URL stability is confirmed against the build output, not only by convention: every pre-change slug
  still exists under `out/client`, and `scripts/site-paths.mjs` reports 0 lost and 3 added paths per
  locale.
- The static browser suite still reports three failures that are identical at `HEAD`: the
  `repaired Chinese CLI link and anchor` anchor gains a trailing slash after the fragment, and the
  two mobile `no-js navigation` cases time out. The baseline run had those plus two more; this change
  adds no new failures.
- `quota` remains a separate reference page rather than being merged or removed, because removing a
  slug needs a redirect decision. The overlap with `usage-and-quota` is still open.
- English and Chinese were written together, but neither was reviewed by a native speaker.
