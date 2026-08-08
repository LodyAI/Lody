# src/components/mentions

Product-level mention sources built on `src/ui/mention`.

## Invariants

- `CombinedMentionTextarea` wires the composer triggers: `@` files, `#`
  issues/PRs, `/` commands, and `$` skills.
- Desktop mention menus should render through `MentionContent` and cap width with
  `var(--mention-input-width)` so menus stay inside the composer/input range.
- `$` skill mention tokens must remain whitespace-free; trigger parsing scans
  from `$` to the next whitespace.
- `$` skill menu shows skills from `useProjectSkills`, not Codex's runtime
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
- The desktop `$` skill menu defaults to `side="top"` with
  `positionAnchor="input-top"`, `avoidCollisions={false}`, and a 20px offset;
  session/dialog panes bottom-align above the input. Chat landing passes caret
  placement so it uses the normal below-caret `MentionContent` positioning and
  top-aligns the list/detail panes.
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
- The `@` file menu must not load Fuse or rebuild provider entries from
  per-render derived objects. Keep Fuse constructor loading module-cached and
  keyed by menu activation; reuse provider file entries when paths/lazy dirs are
  unchanged.
- `issue-pr-hash-mention.tsx` provides cached GitHub issue/PR lookup, hydration,
  menu rows, and post-insert title hints.
- `command-slash-mention.tsx` provides `/` command filtering and analytics.
- `mention-skill-source.tsx` provides `$` skill discovery, provider directory
  filtering, hydration, and the desktop two-pane skill menu.
- `mention-analytics.ts` centralizes mention analytics event helpers.
