# src/components/mentions

Product-level mention sources built on the `src/ui/mention` primitive. Binding
rules live in [AGENTS.md](AGENTS.md); the pipeline and its reasoning live in
[ui-mentions.md](../../../../../.agents/docs/ui-mentions.md).

## Files

- `combined-mention-textarea.tsx` combines sources, hydrators, triggers, and
  `MentionInput` for chat composer usage, and exposes `mentionActionsRef`
  (`insertSessionMention`) for drop-time insertion.
- `mention-registry.ts` holds the two-level menu contract: category definitions,
  candidate building, and `selectMentionMenuView`.
- `mention-two-level-menu.tsx` renders that contract as the single `@` menu and
  owns the activation latch plus the `menu_open` → `category_enter` → `select`
  funnel, both through `hooks/use-fire-once` rather than private refs.
  `category_enter` is reported from the resolved view, not a row callback: a
  navigation item never fires `onMentionSelect`, and the keyboard route counts.
- `file-at-mention.tsx` and `mention-project-file-source.ts` provide file path
  indexing and `@` candidates.
- `mention-session-source.ts` owns session slugs, candidates, the slug → id cache,
  hydration, the drop-time insertion, and the before-send expansion. Transfer
  format and the self-drop check live in `lib/session-mention-drag.ts`.
- `mention-agent-role-source.ts` owns the Agent Roles work-context rule,
  candidates, hydration, and the before-send rewrite. `useAgentRoleMentionItems`
  is the single owner of the mentionable list, like `useSessionMentionItems`: the
  menu and expansion both read it. It reads the visible-machine index, so a test
  that renders a composer stubs it the same way it stubs the session source.
- `issue-pr-hash-mention.tsx` provides cached GitHub issue/PR lookup, ranking,
  hydration, and post-insert title hints.
- `mention-skill-source.tsx` provides `$` skill discovery, provider directory
  filtering, hydration, and the before-send prompt expansion.
- `mention-expansion.ts` composes every before-send transform into one hook.
- `mention-hydration.ts` owns the hydrate-the-initial-text-once effect, the range
  merge every source shares, and `forEachAtTokenSpan` — the single definition of
  where an `@` token ends. Both the file and session hydrators scan with it.
- `mention-persistence.ts` stores and restores a draft's ranges.
- `mention-chips.tsx` owns the kind → glyph and kind → colour tables for both chip
  surfaces; `message-text-chips.tsx` paints the transcript chip.
- `mention-rank.ts` and `vscode-fuzzy-score.ts` own ranking. The vendored score is
  taken from the pinned VS Code source identified in its header; AGENTS.md states
  what must survive an update.
- `mention-analytics.ts` centralizes mention analytics event helpers.
