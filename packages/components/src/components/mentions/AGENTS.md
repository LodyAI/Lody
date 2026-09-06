# src/components/mentions

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Product sources on `src/ui/mention`. [Files](README.md).
[Pipeline](../../../../../.agents/docs/ui-mentions.md).

## Menu and candidates

- `@` reaches menu categories through the two-level menu. Skills also use `$`;
  commands use `/`; `#` has no menu but keeps hydration and before-send expansion.
- `enableAtMentions` gates `@` registration, includes every source's enablement
  (sessions require items), and does NOT gate `<Mention>` mounting: URL support
  is unconditional. Advertise `$` only when Skill mentions are enabled.
- Desktop menus use `MentionContent` capped at `var(--mention-input-width)`.
- `insertText` preserves each type's prompt form regardless of entry trigger.
  Directories carry both `navigateText` (`@dir/`) and `insertText` (`@dir`).
- `getCandidates` stays lazy: scoped queries never rank other categories' file
  indexes; bare `@` calls none. Every category caps candidates. Its `limit` is a
  hint; `selectMentionMenuView` enforces the cap.
- `useMentionCategories` partitions the issue/PR cache once; rank each slice
  separately. Files, Sessions, Agent Roles, Issues, and PRs use vendored VS Code
  `scoreFuzzy`, non-contiguous matching, and source-specific ordering. Skills
  and commands retain their ranking.
- Detail fields render verbatim: use i18n text, never raw enums. Use neutral
  `MentionCandidateDetail` except `detail.agentRole`, which renders the shared
  Role pane on desktop only, with fixed height and a stable scrollbar gutter.
- Lazy work uses `MentionCategory.activation`. `onMentionNavigate` starts it
  synchronously; `selectMentionViewActivations` covers typed/pasted prefixes,
  direct triggers, and aggregate views. Both share one latch per menu opening;
  the menu has no source-specific rules. Shared sources share `sourceKey`.
- Activation ensures loading, not revalidation. Issues/PRs use
  `ISSUE_PR_FRESH_FOR_MS`; only explicit gestures force refresh. Persist the
  fetch timestamp on the cached entry through IndexedDB. Unasked sources report
  `loading`, not empty `ready`.

## URL and browser references

- Retain pasted URLs as native textarea text. Recognize only bounded native
  paste/redo insertions after commit, never ordinary typing, composition, or
  collapsed pasted-text blobs. Removing a reference removes only its range.
  Alt+Enter at its boundary opens the click actions.
- Freeze browser machine/session ownership, logical URL, and optional title.
  Never persist preview capability query parameters. Open through the owning
  browser's navigation/approval flow. Discovery reads existing browser state;
  never fetch page metadata or content.

## Hydration, drafts, and spans

- Hydrate only known tokens/items, preserve external `pasted_text` ranges, and
  record `kind`. Latch the first non-empty text, not the first render.
- Store narrow `PersistedMentionRange` values with drafts, never live ranges.
  Restore via `PersistedMentionHydrator`; text rebuilding is fallback only.
  `mergeHydratedMentions` rejects overlaps with existing ranges, not just duplicates.
- In-place draft swaps require `draftKey` and a render-phase reset.
- Locale files use flat dotted keys (`keySeparator: false`). Preserve the
  vendored score's Microsoft copyright, adjacent MIT license, and generated
  third-party attribution when updating it.
- Compose all before-send transforms in `useMentionPromptExpansion`. List
  rewrites in `REWRITTEN_SPAN_KINDS`; derive verbatim kinds from
  `MESSAGE_TEXT_SPAN_KINDS` minus that list.
- Freeze `MessageTextSpan.mark` at send; never resolve it from the live catalog
  in the transcript. Declare span fields in both `sanitizeMessageTextSpans`
  and strict `MessageTextSpanSchema`.
- Only `agent_role` collapses to its label for message copy
  (`getCopyTextFromMessageItems`). Edit/resend reads expanded text through
  `getTextContentFromMessageItems`. Both chip surfaces use the single glyph and
  colour table in `mention-chips.tsx`.

## Skills

- `$` tokens stay whitespace-free; scan to the next whitespace. Expand known
  tokens to `use /token [Skill Path](path)`. Project paths stay project-relative;
  home `global`/`system` paths use CLI-provided absolute `SKILL.md` paths. Order
  project, global, system via `compareProjectSkillScope`.
- Candidates use `useProjectSkills`, never Codex's runtime registry. One CLI
  `list-global-skills` scan returns global/system scopes, each filtered through
  the provider's `getRegisteredGlobalSkillDirs`/`getRegisteredSystemSkillDirs`.
  `~/.agents/skills` is provider-specific, never a universal fallback. Support
  flat/catalog layouts; unregistered roots appear only after registration.
- Registered entries with no directory (`deepagents`) keep an empty whitelist;
  unregistered agent types get `null`, not an empty `Set`.

## Sessions

- `useSessionMentionItems` alone owns the list, reading child-inclusive
  `allActiveSessions`, not sidebar `sessionListAtom`. Exclude archived and own
  sessions. Project scope filters menus only, never hydration, expansion, drag
  insertion, slug resolution, or child-session addressing.
- Commit plain `@<title-slug>`, without `session:`; ranges carry `sessionId`.
  Rewrite the range into the id-bearing MCP instruction. Without a range, send
  verbatim and never resolve a slug. Hydration skips tokens known to the file source.
- Resolve slugs from the live list, then the synchronous localStorage slug/id
  map. Register its key in `lib/clear-local-cache.ts`; skip unchanged writes.
- Sidebar/session-tab drops must insert real ranges through
  `mentionActionsRef.insertSessionMention(sessionId)`, returning false for
  unknown, own, or already-mentioned sessions. Draft and file/diff tabs cannot
  supply mentions. Paint one `ConversationDropOverlay` per conversation column
  through `SessionMentionDropLayer`, never per keep-alive page.

## Agent Roles

- Commit plain `@<token>` with the stable Role id on its range. Rewrite to a
  CREATE Session instruction carrying only that id; root rules own MCP
  create/freeze. Unavailable composer Roles stay plain text with no instruction.
  Derive tokens from the name (`getAgentRoleMentionSlug`), never a second field;
  renaming changes the token and uniqueness checks use that derived token.
- `MentionCandidate.iconEmoji` replaces the category glyph, defaulted through
  `getAgentRoleEmoji`; omit detail `title`. `applyAgentRoleEmojiChip` paints the
  committed emoji boxed/clipped to its slot. Carry config and machine on
  `AgentRoleMentionItem`.
- Filter visibility, executability, then work context. Local Project and V1
  plain chat pin the machine. GitHub projects may use any authorized machine
  unless checked out (`localWorktree`). Unavailable Roles cannot be submitted;
  never fall back to another machine, provider, or model.
