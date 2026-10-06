# Docs content cleanup: primary agents, removed comparisons, and the Feature List label

Status: proposed
Translation: current
Language: [中文](2026-10-06-docs-content-cleanup.zh.md)

## Abstract

The docs still assumed a specific first-class agent or a removed setting. This
proposal makes the multi-agent guide agent-agnostic (a primary agent coordinates
the others, without Claude Code-specific wording), removes the Lore and SpecStory
rows from the handoff comparison, deletes the unsupported VS Code themes pages,
renames the Reference sidebar group to Feature List, and clarifies that session
tabs let different agents reuse one workspace. The English and Chinese trees, the
draft information-architecture Spec, and the docs index are updated together; the
deleted page has no redirect because the site has no runtime redirect layer.

## Problem

- The multi-agent guide singled out Claude Code as the coordinator even though any
  configured agent can use the cross-session tools. It also explained a Claude
  Code-specific native capability instead of staying agent-agnostic.
- The handoff page compared Lody with Lore and SpecStory, two external products
  that make the table longer without helping the reader choose how to hand off a
  session.
- VS Code themes are no longer supported, but the page still documents the
  removed settings and stays in the sidebar.
- The sidebar group label "参考" / "Reference" undersold a capability list; the
  requested label is "功能列表" / "Feature List".
- The session-tabs intro described parallel surfaces but not the defining
  property: different agents share the same workspace and files.

## Decision

- Rewrite the `agent-collaboration` guide around "a primary agent" / "主 Agent"
  in both locales. The coordinator is a role the user fills with any configured
  agent. Remove the Claude Code native Agent Teams sentence rather than attribute
  it to the primary agent. Update the inbound link text on `session-orchestration`
  and `parallel-agents`.
- Remove the Lore and SpecStory rows from the `session-handoff` comparison and
  the FAQ that named them. Keep the ChatGPT-style share link as the read-only
  record example.
- Delete `vscode-themes.mdx` in both locales, remove it from
  `(reference)/(settings-and-cli)/meta.json`, and drop the embedded terminal
  page's reference to a selected code theme. The feature is unsupported, so the
  page is removed rather than deprecated.
- Rename the `(reference)` group display title from "参考" / "Reference" to
  "功能列表" / "Feature List" in both `meta.json` files, and update the draft IA
  Spec, the IA note, and the docs index descriptions. Folder names and published
  URLs stay unchanged.
- Extend the `session-tabs` intro to say different agents reuse the same
  workspace: same files, branch, and uncommitted changes, with separate
  conversation histories.

## Alternatives considered

1. Keep the guide Claude Code-specific and add a note that other agents can also
   coordinate. Rejected: the guide and its inbound links would still read as a
   Claude Code tutorial.
2. Keep the Lore and SpecStory rows as historical comparisons. Rejected: they are
   external products, not capabilities the reader is choosing between.
3. Mark VS Code themes deprecated instead of deleting the page. Rejected: the
   setting is gone; documenting how to configure it would be worse than a 404.
4. Rename only the Chinese sidebar label and leave the English "Reference".
   Rejected: the two locale trees keep the same group names by contract.
5. Keep the session-tabs wording and add a separate FAQ. Rejected: the shared
   workspace is the defining property of the feature and belongs in the intro.

## Verification and limits

- `pnpm --filter @lody/site-docs generate`, `typecheck`, and `test` pass.
  `pnpm run docs check` reports no new errors.
- A production build prerenders the site; the deleted pages are absent, and the
  sidebar group renders as Feature List / 功能列表.
- The full static browser suite reports 307 passing cases (309 before the two
  VS Code themes pages were removed) and the same two baseline mobile
  `no-js navigation` timeouts. Its internal-link pass finds no remaining link to
  the deleted pages.
- English and Chinese were updated together; the changes were not reviewed by a
  native speaker.
- Deleting a page is a URL decision. The site has no redirect layer, so
  `/docs/vscode-themes/` and `/zh/docs/vscode-themes/` now 404; a redirect needs a
  separate compatibility decision.
- The IA note remains `proposed` and now records the Feature List label. A future
  rename should update both the Spec and the note.
