# src/components/mentions

Product-level mention sources built on `src/ui/mention`.

## Invariants

- `@` is the only menu trigger. Every mention type is reached through the
  single two-level menu; `/` is the one exception and still opens commands
  directly, because a slash command must own the whole prompt. `#` and `$` no
  longer open a menu — but their hydrators stay, so a hand-typed or pasted
  `#123` / `$token` is still highlighted and still expands before send.
- Desktop mention menus should render through `MentionContent` and cap width with
  `var(--mention-input-width)` so menus stay inside the composer/input range.
- `$` skill tokens must remain whitespace-free; hydration scans from `$` to the
  next whitespace.
- `$` skill candidates come from `useProjectSkills`, not Codex's runtime
  skill registry. The same CLI `list-global-skills` home scan returns two scopes:
  `global` (user-authored, over `ALL_KNOWN_GLOBAL_SKILL_DIRS`) and `system`
  (agent built-ins, over `ALL_KNOWN_SYSTEM_SKILL_DIRS` — e.g. codex
  `~/.codex/skills/.system`). Both are filtered by the selected provider's dirs
  (`getRegisteredGlobalSkillDirs` + `getRegisteredSystemSkillDirs`).
  `~/.agents/skills` is a provider-specific alias, not a universal fallback;
  only providers with verified support include it in `getRegisteredGlobalSkillDirs`.
  The scanner supports flat `~/<agent>/skills/<skill>/SKILL.md` and catalog-layout
  `~/<agent>/skills/<category>/<skill>/SKILL.md`; plugin cache paths outside the
  provider's registered global root still do not appear unless their scan dirs are
  explicitly added.
- Before send, known `$` skill tokens are expanded in prompt text to
  `use /token [Skill Path](path)`. Project skills use their project-relative
  `SKILL.md` path; home-scoped (`global` + `system`) skills use the CLI-provided
  absolute `SKILL.md` path. Display order is project → global → system
  (`compareProjectSkillScope`).
- Hydrators should only add ranges for known tokens/items and should preserve
  existing external `pasted_text` mention ranges.
- A `MentionCandidate`'s `insertText` must keep its type's existing prompt form
  (`@path`, `#123`, `$token`, `/cmd`). Reaching a type through `@` must not
  change what the agent receives.
- `MentionCategory.getCandidates` stays lazy. Ranking the file index is the
  expensive one, so a query scoped to another category must never call it, and a
  bare `@` must call none of them. Its `limit` is a hint a source may honour to
  stop early; `selectMentionMenuView` still enforces the cap, so a source that
  ignores it stays correct.
- Issues and PRs rank over their own slice of the shared cache. The shared
  ranking caps its result set, so ranking the merged list first lets a long issue
  list starve every PR out of the PR category. The slices are partitioned once by
  `useMentionCategories` and shared with the Fuse indexes, not re-derived per
  keystroke.
- Every category caps its candidate count. A row is a registered collection item
  that arrow-key movement walks, so an uncapped source degrades navigation, not
  just render time.
- `@session:` is the only type whose displayed text differs from what the agent
  receives: the composer holds `@session:<title-slug>`, the mention range holds
  the real `sessionId`, and `useMentionPromptExpansion` rewrites the token into
  an id-bearing MCP instruction on send. Its `@session:` prefix therefore stays
  in the committed text — it is the expansion anchor, unlike every other
  namespace prefix, which is consumed on commit.
- An unresolvable session slug is sent verbatim. A stale token the agent can
  ignore beats a confidently wrong session id, so expansion never guesses.
- Session slugs resolve through the live list first, then a `localStorage`
  slug -> id map. The store is synchronous on purpose: expansion runs on the
  send path, and an async store would make that whole path async. Its key is
  registered in `lib/clear-local-cache.ts`, and the write is skipped when the
  serialized map is unchanged — the session list ticks several times a second
  while an agent streams, and `setItem` blocks.
- `useSessionMentionItems` is the single owner of the mentionable-session list.
  The composer and `useMentionPromptExpansion` are both mounted on a session
  screen, so deriving the items separately re-slugged every visible session twice
  per tick.
- `useMentionPromptExpansion` is the single before-send text transform. There are
  exactly two send paths, so per-type expansion hooks must compose here rather
  than being wired into both by hand.
- A candidate describes its side panel through the neutral `MentionCandidateDetail`
  fields, not its own component, so one pane serves every category. The pane is
  desktop-only: the docked mobile strip is too narrow and has no hover to preview
  with. Those fields are rendered verbatim, so a source must put i18n'd text in
  them — never a raw enum value such as a skill scope.
- Locale files are flat dotted-key maps — i18next runs with `keySeparator: false`,
  so a nested block never resolves and silently falls back to the inline default.
- `@` directory candidates must carry both `navigateText` (`@dir/`, descend) and
  `insertText` (`@dir`, commit without the trailing slash). The primitive no
  longer infers drill-down from a trailing `/`, so dropping either prop silently
  turns directories into plain one-shot mentions.

## Files

- `combined-mention-textarea.tsx` combines sources, hydrators, triggers, and
  `MentionInput` for chat composer usage.
- `file-at-mention.tsx` and `mention-project-file-source.ts` provide file path
  indexing and `@` candidates.
- `mention-registry.ts` holds the two-level menu contract: category definitions,
  candidate building, and `selectMentionMenuView`.
- `mention-two-level-menu.tsx` renders that contract as the single `@` menu and
  owns the `menu_open` -> `category_enter` -> `select` funnel. `category_enter`
  is reported from the resolved view, not a row callback: a navigation item
  never fires `onMentionSelect`, and the keyboard route must count too.
- `mention-session-source.ts` owns `@session:` slugs, candidates, the slug -> id
  cache, hydration, and the before-send expansion.
- `mention-expansion.ts` composes every before-send transform into one hook.
- `mention-hydration.ts` owns the hydrate-the-initial-text-once effect and the
  range merge every source shares; a source supplies only its `hydrate`.
- `mention-fuse.ts` owns the shared, module-cached `fuse.js` import.
- The menu must not load Fuse or rebuild provider entries from per-render
  derived objects. Keep Fuse constructor loading module-cached and keyed by menu
  activation; reuse provider file entries when paths/lazy dirs are unchanged.
  Activation is latched, so closing the menu must not drop the constructor and
  force every caller to rebuild its index on the next `@`.
- `issue-pr-hash-mention.tsx` provides cached GitHub issue/PR lookup, ranking,
  hydration, and post-insert title hints.
- `mention-skill-source.tsx` provides `$` skill discovery, provider directory
  filtering, hydration, and the before-send prompt expansion.
- `mention-analytics.ts` centralizes mention analytics event helpers.
