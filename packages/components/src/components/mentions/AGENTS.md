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
  bare `@` must call none of them.
- Issues and PRs rank over their own slice of the shared cache. The shared
  ranking caps its result set, so ranking the merged list first lets a long issue
  list starve every PR out of the PR category.
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
- `mention-fuse.ts` owns the shared, module-cached `fuse.js` import.
- The menu must not load Fuse or rebuild provider entries from per-render
  derived objects. Keep Fuse constructor loading module-cached and keyed by menu
  activation; reuse provider file entries when paths/lazy dirs are unchanged.
- `issue-pr-hash-mention.tsx` provides cached GitHub issue/PR lookup, ranking,
  hydration, and post-insert title hints.
- `mention-skill-source.tsx` provides `$` skill discovery, provider directory
  filtering, hydration, and the before-send prompt expansion.
- `mention-analytics.ts` centralizes mention analytics event helpers.
