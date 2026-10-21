# src/components/mentions

Product-level mention sources built on the `src/ui/mention` primitive. Binding
rules live in [AGENTS.md](AGENTS.md); the pipeline and its reasoning live in
[ui-mentions.md](../../../../../.agents/docs/ui-mentions.md).

| Area             | Owner                                                                                                | Responsibility                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Composer entry   | [combined-mention-textarea.tsx](combined-mention-textarea.tsx)                                       | Registers triggers and connects sources to the input.                |
| Menu             | [mention-registry.ts](mention-registry.ts), [mention-two-level-menu.tsx](mention-two-level-menu.tsx) | Builds views and renders rows, including merged typed slash results. |
| Source search    | Source modules below                                                                                 | Apply source-specific visibility and availability before ranking.    |
| Commit lifecycle | [mention-expansion.ts](mention-expansion.ts), [mention-hydration.ts](mention-hydration.ts)           | Preserve and expand selected ranges.                                 |

## Files

- `combined-mention-textarea.tsx` combines sources, hydrators, triggers, and
  `MentionInput` for chat composer usage, and exposes `mentionActionsRef`
  (`insertSessionMention` and `insertPathMentions`) for drop-time insertion.
- `mention-registry.ts` holds the two-level menu contract: category definitions,
  candidate building, and `selectMentionMenuView`.
- `mention-two-level-menu.tsx` renders that contract as the single `@` menu and
  owns the activation latch plus the `menu_open` → `category_enter` → `select`
  funnel, both through `hooks/use-fire-once` rather than private refs.
  `category_enter` is reported from the resolved view, not a row callback: a
  navigation item never fires `onMentionSelect`, and the keyboard route counts.
  Candidate descriptions fill the space between the heading and bottom facts,
  with an ellipsis after the last complete line that fits. Paths stay visible
  and the detail pane does not scroll. See the
  [description sizing decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-20-mention-description-space.md).
- `file-at-mention.tsx` and `mention-project-file-source.ts` load file paths and
  provide draft hydration. GitHub discovery uses the shared cache and request-level
  failure observer; see [fetch contract](../../../../../specs/mention-file-fetch.md). [`file-search/`](file-search/README.md) owns the
  cancellable Worker, React lifecycle, and bounded path ranking.
- `mention-session-source.ts` owns session slugs, candidates, the slug → id cache,
  hydration, the drop-time insertion, and the before-send expansion. Transfer
  format and the self-drop check live in `lib/session-mention-drag.ts`.
- `mention-agent-role-source.ts` owns the Agent Roles candidates, hydration, and
  the before-send rewrite. `useAgentRoleMentionItems` is the single owner of
  readable Roles and their availability: the menu shows disabled reasons after
  available matches; hydration and expansion use only available Roles. Every
  composer can reach any authorized machine. It reads the visible-machine index,
  so a test that renders a composer stubs it the same way it stubs the session
  source.
- `issue-pr-hash-mention.tsx` provides cached GitHub issue/PR lookup, ranking,
  hydration, and post-insert title hints.
- `mention-skill-source.tsx` provides `$` skill discovery (`￥` and `¥` are menu aliases), provider directory
  filtering, hydration, and the before-send prompt expansion.
- `mention-prompt-shortcut-source.tsx` filters visible and available Prompt
  Shortcuts before the shared slash ranker orders them. Agent Commands use that
  same ranker through `mention-registry.ts`. The ranker lives in
  [command-slash-search.ts](../../lib/command-slash-search.ts); the
  [evaluation](../../../benchmarks/slash-search/README.md) records its behavior.
- `mention-expansion.ts` composes every before-send transform into one hook.
- `mention-hydration.ts` owns the hydrate-the-initial-text-once effect, the range
  merge every source shares, and `forEachAtTokenSpan` — the single definition of
  where an `@` token ends. Both the file and session hydrators scan with it.
- `mention-persistence.ts` stores and restores a draft's ranges.
- `mention-chips.tsx` owns the kind → glyph and kind → colour tables for both chip
  surfaces; `message-text-chips.tsx` paints the transcript chip. Its paste button
  shares the prose baseline through its label, while the clipboard icon stays centered.
  A pasted-text chip's geometry assumes its label delimits itself — as
  `[Pasted 4,182 chars]` does, and as every custom label a caller passes must: the glyph
  paints over the leading `figure space + [` and the trailing `] + figure space` stays
  blank, so an undelimited label loses its own first and last character.
- `mention-rank.ts` and `vscode-fuzzy-score.ts` own matching for files, sessions,
  Roles, Issues, and PRs. The vendored score is taken from the pinned VS Code
  source identified in its header; AGENTS.md states what must survive an update.
- `mention-analytics.ts` centralizes mention analytics event helpers.
